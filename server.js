// LVC Petty Cash Claims: web server.
// Serves the claim form and a small JSON API backed by PostgreSQL (Railway).
//
// Environment variables:
//   DATABASE_URL     PostgreSQL connection string (Railway provides it)        required
//   ADMIN_EMAILS     comma-separated admin emails      default: wenqi@lvc-ecopack.com
//   EMAIL_DOMAIN     only this email domain can register   default: lvc-ecopack.com
//   CODE_SECRET      long random string used when hashing sign-in codes      recommended
//   MAIL_FROM        sender for sign-in code emails
//   RESEND_API_KEY   send emails through Resend (works on every Railway plan)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS   or send through SMTP (Railway Pro plan only)
//   With no email settings, codes are written to the server log (for setup and testing only).

import express from "express";
import pg from "pg";
import nodemailer from "nodemailer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const EMAIL_DOMAIN = (process.env.EMAIL_DOMAIN || "lvc-ecopack.com").trim().toLowerCase();
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || "wenqi@lvc-ecopack.com").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const CODE_SECRET = process.env.CODE_SECRET || "";
const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const MAX_CODE_TRIES = 5;
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

// ---------- email ----------
const smtp = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT || 587) === 465,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
}) : null;
const MAIL_FROM = process.env.MAIL_FROM || (process.env.RESEND_API_KEY ? "LVC Petty Cash <onboarding@resend.dev>" : `LVC Petty Cash <no-reply@${EMAIL_DOMAIN}>`);

async function sendMail({ to, subject, text, html }) {
  if (process.env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
    return;
  }
  if (smtp) { await smtp.sendMail({ from: MAIL_FROM, to, subject, text, html }); return; }
  console.warn(`[email not configured] To ${to} | ${subject} | ${text}`);
}

function codeEmail(code, purpose) {
  const signup = purpose === "signup";
  const subject = signup ? "Confirm your LVC Petty Cash account" : "Your LVC Petty Cash sign-in code";
  const lead = signup ? "Enter this code to confirm your email and create your account:" : "Your sign-in code is:";
  const text = `${lead} ${code}\n\nIt expires in ${CODE_MINUTES} minutes. If you didn't ask for this, ignore this email.`;
  const html = `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#2B2E26;max-width:480px">
    <div style="font-weight:700;letter-spacing:.14em;color:#5E7A14;font-size:20px">LVC</div>
    <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#6B6E66">Finance · Petty Cash</div>
    <p style="margin:24px 0 8px">${lead}</p>
    <p style="font-family:Consolas,monospace;font-size:30px;letter-spacing:6px;margin:0 0 16px;color:#2B2E26"><b>${code}</b></p>
    <p style="color:#6B6E66;font-size:13px">It expires in ${CODE_MINUTES} minutes. If you didn't ask for this, ignore this email.</p>
  </div>`;
  return { subject, text, html };
}

// ---------- helpers ----------
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const hashCode = (email, code) => sha256(`${CODE_SECRET}:${email}:${code}`);
const normEmail = s => String(s || "").trim().toLowerCase();
const isCompanyEmail = e => /^[^\s@]+@[^\s@]+$/.test(e) && e.endsWith("@" + EMAIL_DOMAIN);
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
const isAdmin = u => ADMIN_EMAILS.has(u.email);

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

// ----- sign-in -----
app.post("/api/auth/request-code", wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  if (!isCompanyEmail(email)) throw new HttpError(400, `Use your company email address ending in @${EMAIL_DOMAIN}.`);
  const existing = (await pool.query("select id from users where email = $1", [email])).rows[0];
  let purpose = req.body.mode === "signup" ? "signup" : "signin";
  if (purpose === "signin" && !existing) throw new HttpError(404, "There's no account for this email yet. Choose Create account to register.");
  let profile = null;
  if (existing) purpose = "signin";
  else {
    const p = req.body.profile || {};
    profile = { full_name: str(p.fullName, 120), department: str(p.department, 80), phone: str(p.phone, 40) || null };
    if (!profile.full_name || !profile.department) throw new HttpError(400, "Enter your full name and department.");
  }

  const recent = (await pool.query(
    `select count(*)::int as n, max(created_at) as last from login_codes where email = $1 and created_at > now() - interval '1 hour'`, [email])).rows[0];
  if (recent.n >= 6) throw new HttpError(429, "Too many codes requested. Wait a while, then try again.");
  if (recent.last && Date.now() - new Date(recent.last).getTime() < 30_000) throw new HttpError(429, "A code was just sent. Wait 30 seconds before asking for another.");

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await pool.query("update login_codes set used_at = now() where email = $1 and used_at is null", [email]);
  await pool.query(
    `insert into login_codes (email, code_hash, purpose, profile, expires_at) values ($1, $2, $3, $4, now() + make_interval(mins => $5::int))`,
    [email, hashCode(email, code), purpose, profile, CODE_MINUTES]);
  try { await sendMail({ to: email, ...codeEmail(code, purpose) }); }
  catch (err) { console.error("Email failed:", err.message); throw new HttpError(502, "The code couldn't be sent. Try again in a minute."); }
  res.json({ ok: true, mode: purpose });
}));

app.post("/api/auth/verify", wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const code = String(req.body.code || "").replace(/\D/g, "");
  const wrong = "That code is wrong or has expired. Check the latest email, or send a new code.";
  const row = (await pool.query(
    `select * from login_codes where email = $1 and used_at is null and expires_at > now() order by created_at desc limit 1`, [email])).rows[0];
  if (!row || code.length !== 6) throw new HttpError(400, wrong);
  if (row.attempts >= MAX_CODE_TRIES) {
    await pool.query("update login_codes set used_at = now() where id = $1", [row.id]);
    throw new HttpError(400, "Too many wrong tries. Send a new code.");
  }
  const ok = crypto.timingSafeEqual(Buffer.from(hashCode(email, code)), Buffer.from(row.code_hash));
  if (!ok) {
    await pool.query("update login_codes set attempts = attempts + 1 where id = $1", [row.id]);
    throw new HttpError(400, wrong);
  }
  await pool.query("update login_codes set used_at = now() where id = $1", [row.id]);

  let user = (await pool.query("select * from users where email = $1", [email])).rows[0];
  if (!user) {
    if (row.purpose !== "signup" || !row.profile) throw new HttpError(400, "There's no account for this email yet. Choose Create account to register.");
    const p = row.profile;
    user = (await pool.query(
      `insert into users (email, full_name, department, phone) values ($1, $2, $3, $4)
       on conflict (email) do update set email = excluded.email returning *`,
      [email, p.full_name, p.department, p.phone])).rows[0];
  }
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(`insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha256(token), user.id]);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  res.json(profileOut(user));
}));

app.post("/api/auth/logout", wrap(async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await pool.query("delete from sessions where token_hash = $1", [sha256(token)]);
  setSessionCookie(req, res, "", 0);
  res.json({ ok: true });
}));

app.get("/api/me", auth(async (req, res) => res.json(profileOut(req.user))));

app.put("/api/profile", auth(async (req, res) => {
  const p = { full_name: str(req.body.fullName, 120), department: str(req.body.department, 80), phone: str(req.body.phone, 40) || null };
  if (!p.full_name || !p.department) throw new HttpError(400, "Enter your full name and department.");
  const u = (await pool.query(
    `update users set full_name = $2, department = $3, phone = $4, updated_at = now() where id = $1 returning *`,
    [req.user.id, p.full_name, p.department, p.phone])).rows[0];
  res.json(profileOut(u));
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
    // Keep the employee's profile in step with the details used on their latest claim.
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
  if (!process.env.RESEND_API_KEY && !smtp) console.warn("No email provider set: sign-in codes will be written to this log. Set RESEND_API_KEY or SMTP_* before staff use the form.");
  if (!CODE_SECRET) console.warn("CODE_SECRET is not set. Set it to a long random string.");
  setInterval(() => {
    pool.query("delete from sessions where expires_at < now()").catch(() => {});
    pool.query("delete from login_codes where created_at < now() - interval '1 day'").catch(() => {});
  }, 60 * 60 * 1000).unref();
  app.listen(PORT, () => console.log(`LVC Petty Cash running on port ${PORT}. Admins: ${[...ADMIN_EMAILS].join(", ")}`));
}
start().catch(err => { console.error("Start-up failed:", err); process.exit(1); });
