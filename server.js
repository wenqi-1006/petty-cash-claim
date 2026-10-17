// LVC Petty Cash Claims: web server.
// Serves the claim form and a small JSON API backed by PostgreSQL (Railway).
//
// Environment variables:
//   DATABASE_URL   PostgreSQL connection string (Railway provides it)        required
//   ADMIN_EMAILS   comma-separated admin emails      default: wenqi@lvc-ecopack.com
//   EMAIL_DOMAIN   only this email domain can register   default: lvc-ecopack.com

import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const EMAIL_DOMAIN = (process.env.EMAIL_DOMAIN || "lvc-ecopack.com").trim().toLowerCase();
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || "wenqi@lvc-ecopack.com").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const SESSION_DAYS = 30;
const MIN_PASSWORD = 6;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const COOKIE = "lvc_session";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. In Railway, add a reference to the Postgres service's DATABASE_URL in this service's Variables.");
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

// ---------- passwords (scrypt, built into Node) ----------
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function checkPassword(pw, stored) {
  if (!stored) return false;
  const [kind, N, r, p, salt, key] = stored.split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(key, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, expected);
}
// A readable temporary password for admin resets, e.g. "lvc-7kq4-m2xp".
function tempPassword() {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  const part = () => Array.from({ length: 4 }, () => a[crypto.randomInt(a.length)]).join("");
  return `lvc-${part()}-${part()}`;
}

// Slow down password guessing: 10 failed sign-ins per email per 15 minutes.
const failures = new Map();
const FAIL_WINDOW = 15 * 60 * 1000, FAIL_LIMIT = 10;
function tooManyFailures(email) {
  const f = failures.get(email);
  return f && Date.now() - f.first < FAIL_WINDOW && f.count >= FAIL_LIMIT;
}
function noteFailure(email) {
  const f = failures.get(email);
  if (!f || Date.now() - f.first > FAIL_WINDOW) failures.set(email, { first: Date.now(), count: 1 });
  else f.count++;
}

// ---------- helpers ----------
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const normEmail = s => String(s || "").trim().toLowerCase();
const isCompanyEmail = e => /^[^\s@]+@[^\s@]+$/.test(e) && e.endsWith("@" + EMAIL_DOMAIN);
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
const isAdmin = u => ADMIN_EMAILS.has(u.email);
function checkNewPassword(pw) {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD) throw new HttpError(400, `Use a password of at least ${MIN_PASSWORD} characters.`);
  if (pw.length > 200) throw new HttpError(400, "That password is too long.");
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}
async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(`insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3::int))`,
    [sha256(token), userId, SESSION_DAYS]);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

async function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const { rows } = await pool.query(
    `select u.* from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(token)]);
  return rows[0] || null;
}
const auth = fn => wrap(async (req, res, next) => {
  req.user = await currentUser(req);
  if (!req.user) throw new HttpError(401, "Your session has ended. Please sign in again.");
  return fn(req, res, next);
});
const adminOnly = fn => auth(async (req, res, next) => {
  if (!isAdmin(req.user)) throw new HttpError(403, "Only admins can do this.");
  return fn(req, res, next);
});

const profileOut = u => ({ email: u.email, fullName: u.full_name, department: u.department, phone: u.phone, isAdmin: isAdmin(u) });
const claimOut = r => ({
  ref: r.ref, submittedAt: r.submitted_at, name: r.name, dept: r.department, email: r.email, phone: r.phone,
  purpose: r.purpose, claimDate: r.claim_date, total: Number(r.total_cents), items: r.items, receipts: r.receipts,
  hasPdf: r.pdf_size > 0,
});

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// State-changing API calls must come from this site, as JSON.
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const origin = req.get("origin");
  if (origin) {
    try { if (new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "Request blocked." }); }
    catch { return res.status(403).json({ error: "Request blocked." }); }
  }
  if (!req.is("application/json")) return res.status(415).json({ error: "Send JSON." });
  next();
});
app.use(express.json({ limit: "75mb" }));

app.get("/healthz", wrap(async (req, res) => { await pool.query("select 1"); res.send("ok"); }));

// ----- accounts -----
app.post("/api/auth/signup", wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  if (!isCompanyEmail(email)) throw new HttpError(400, `Use your company email address ending in @${EMAIL_DOMAIN}.`);
  const fullName = str(req.body.fullName, 120), department = str(req.body.department, 80), phone = str(req.body.phone, 40) || null;
  if (!fullName || !department) throw new HttpError(400, "Enter your full name and department.");
  checkNewPassword(req.body.password);
  const hash = await hashPassword(req.body.password);
  const { rows } = await pool.query(
    `insert into users (email, full_name, department, phone, password_hash) values ($1, $2, $3, $4, $5)
     on conflict (email) do update
       set full_name = excluded.full_name, department = excluded.department, phone = excluded.phone,
           password_hash = excluded.password_hash, updated_at = now()
       where users.password_hash is null   -- accounts made with the old email codes have no password yet
     returning *`, [email, fullName, department, phone, hash]);
  if (!rows[0]) throw new HttpError(409, "An account with this email already exists. Choose Sign in, or ask the admin to reset your password.");
  await startSession(req, res, rows[0].id);
  res.status(201).json(profileOut(rows[0]));
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const password = String(req.body.password || "");
  if (tooManyFailures(email)) throw new HttpError(429, "Too many wrong passwords. Wait 15 minutes, or ask the admin to reset your password.");
  const user = (await pool.query("select * from users where email = $1", [email])).rows[0];
  if (!user || !(await checkPassword(password, user.password_hash))) {
    noteFailure(email);
    throw new HttpError(401, "Email or password is incorrect.");
  }
  failures.delete(email);
  await startSession(req, res, user.id);
  res.json(profileOut(user));
}));

app.post("/api/auth/logout", wrap(async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await pool.query("delete from sessions where token_hash = $1", [sha256(token)]);
  setSessionCookie(req, res, "", 0);
  res.json({ ok: true });
}));

app.get("/api/me", auth(async (req, res) => res.json(profileOut(req.user))));

app.post("/api/auth/password", auth(async (req, res) => {
  if (!(await checkPassword(String(req.body.current || ""), req.user.password_hash))) throw new HttpError(400, "Your current password is incorrect.");
  checkNewPassword(req.body.password);
  await pool.query("update users set password_hash = $2, updated_at = now() where id = $1", [req.user.id, await hashPassword(req.body.password)]);
  // Sign out every other browser.
  const token = readCookie(req, COOKIE);
  await pool.query("delete from sessions where user_id = $1 and token_hash <> $2", [req.user.id, sha256(token || "")]);
  res.json({ ok: true });
}));

// ----- admin: employee accounts -----
app.get("/api/admin/users", adminOnly(async (req, res) => {
  const { rows } = await pool.query(
    `select u.email, u.full_name, u.department, u.phone, u.created_at,
            count(c.id)::int as claims, coalesce(sum(c.total_cents), 0)::bigint as total_cents
       from users u left join claims c on c.user_id = u.id
      group by u.id order by u.full_name`);
  res.json(rows.map(r => ({ email: r.email, fullName: r.full_name, department: r.department, phone: r.phone,
    createdAt: r.created_at, claims: r.claims, total: Number(r.total_cents), isAdmin: ADMIN_EMAILS.has(r.email) })));
}));

app.post("/api/admin/users/reset-password", adminOnly(async (req, res) => {
  const email = normEmail(req.body.email);
  const pw = tempPassword();
  const { rows } = await pool.query("update users set password_hash = $2, updated_at = now() where email = $1 returning id",
    [email, await hashPassword(pw)]);
  if (!rows[0]) throw new HttpError(404, "No account with that email.");
  await pool.query("delete from sessions where user_id = $1", [rows[0].id]);
  failures.delete(email);
  res.json({ email, temporaryPassword: pw });
}));

// ----- claims -----
const CLAIM_COLUMNS = "ref, submitted_at, name, department, email, phone, purpose, to_char(claim_date, 'YYYY-MM-DD') as claim_date, total_cents, items, receipts, pdf_size";

app.get("/api/claims", auth(async (req, res) => {
  const all = req.query.scope === "all";
  if (all && !isAdmin(req.user)) throw new HttpError(403, "Only admins can see everyone's claims.");
  const { rows } = all
    ? await pool.query(`select ${CLAIM_COLUMNS} from claims order by submitted_at desc`)
    : await pool.query(`select ${CLAIM_COLUMNS} from claims where user_id = $1 order by submitted_at desc`, [req.user.id]);
  res.json(rows.map(claimOut));
}));

app.post("/api/claims", auth(async (req, res) => {
  const b = req.body || {};
  const ref = str(b.ref, 40);
  if (!/^PC-\d{8}-[A-Z0-9]{4,8}$/.test(ref)) throw new HttpError(400, "The claim reference is invalid. Reload the page and submit again.");
  const name = str(b.name, 120), department = str(b.department, 80), phone = str(b.phone, 40) || null, purpose = str(b.purpose, 300);
  if (!name || !department || !purpose) throw new HttpError(400, "Name, department and purpose are required.");
  if (!isDate(b.claimDate)) throw new HttpError(400, "The claim date is invalid.");
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 200) throw new HttpError(400, "Add at least one expense.");
  const items = b.items.map(i => ({
    date: str(i.date, 10), receipt: str(i.receipt, 60), category: str(i.category, 60), desc: str(i.desc, 300),
    cents: Number.isSafeInteger(i.cents) ? i.cents : NaN,
  }));
  if (items.some(i => !isDate(i.date) || !i.category || !i.desc || !(i.cents > 0) || i.cents > 1e9)) throw new HttpError(400, "One of the expense lines is incomplete.");
  const total = items.reduce((s, i) => s + i.cents, 0);
  const receipts = Array.isArray(b.receipts) ? b.receipts.slice(0, 100).map(s => str(s, 200)) : [];
  const pdf = Buffer.from(String(b.pdfBase64 || ""), "base64");
  if (pdf.length < 5 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(400, "The claim PDF is missing or damaged.");
  if (pdf.length > MAX_PDF_BYTES) throw new HttpError(413, "The combined PDF is larger than 50 MB. Re-scan the receipts at a lower resolution.");

  try {
    const { rows } = await pool.query(
      `insert into claims (ref, user_id, email, name, department, phone, purpose, claim_date, total_cents, items, receipts, pdf, pdf_size)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning ${CLAIM_COLUMNS}`,
      [ref, req.user.id, req.user.email, name, department, phone, purpose, b.claimDate, total,
       JSON.stringify(items), JSON.stringify(receipts), pdf, pdf.length]);
    // Keep the employee's account details in step with their latest claim.
    await pool.query(`update users set full_name = $2, department = $3, phone = $4, updated_at = now() where id = $1`,
      [req.user.id, name, department, phone]);
    res.status(201).json(claimOut(rows[0]));
  } catch (err) {
    if (err.code === "23505") throw new HttpError(409, "That claim reference already exists. Submit again to get a new one.");
    throw err;
  }
}));

app.get("/api/claims/:ref/pdf", auth(async (req, res) => {
  const row = (await pool.query("select user_id, name, pdf from claims where ref = $1", [req.params.ref])).rows[0];
  if (!row || (row.user_id !== req.user.id && !isAdmin(req.user))) throw new HttpError(404, "Claim not found.");
  const safe = String(row.name).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Employee";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="PettyCash_${req.params.ref}_${safe}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(row.pdf);
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

// ----- the form -----
const formFile = path.join(__dirname, "petty-cash-claim.html");
app.get(["/", "/index.html", "/petty-cash-claim.html"], (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(formFile);
});

// ----- errors -----
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "The claim is too large to upload (limit 50 MB PDF)." });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server. Try again." });
});

// ---------- start ----------
async function start() {
  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  setInterval(() => { pool.query("delete from sessions where expires_at < now()").catch(() => {}); }, 60 * 60 * 1000).unref();
  app.listen(PORT, () => console.log(`LVC Petty Cash running on port ${PORT}. Admins: ${[...ADMIN_EMAILS].join(", ")}`));
}
start().catch(err => { console.error("Start-up failed:", err); process.exit(1); });
