# LVC Petty Cash Claims: setup

Everything runs on **Railway**:
- **petty-cash-claim**: a small Node.js server (`server.js`). It serves the form and handles sign-in, claims, history and the admin summary.
- **Postgres**: a Railway PostgreSQL database. It stores accounts, sign-in sessions, claims and each claim's PDF.

The server creates the database tables itself on start-up (`schema.sql`), so there is no SQL to run by hand.

## 1. Add the database
In the Railway project, click **Create > Database > PostgreSQL**. Railway starts a `Postgres` service.

## 2. Set the server's variables
Open the **petty-cash-claim** service > **Variables** and add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (a reference to the database; Railway fills in the real value) |
| `CODE_SECRET` | a long random string (at least 32 characters) |
| `ADMIN_EMAILS` | `wenqi@lvc-ecopack.com` (separate several with commas) |
| `EMAIL_DOMAIN` | `lvc-ecopack.com` (optional; this is the default) |

Railway redeploys automatically after you save.

## 3. Send the sign-in codes by email
Until this is set up, sign-in codes are **only written to the server log**: **petty-cash-claim > Deployments > View logs**, a line starting `[email not configured]`. That's fine for testing, but staff need real emails.

Choose one:

**A. Resend (recommended; works on every Railway plan)**
1. Create an account at https://resend.com and add your domain `lvc-ecopack.com` under **Domains**. Add the DNS records it shows at your domain host (your IT person can do this) and wait for **Verified**.
2. Create an API key (**API Keys > Create**).
3. Add these variables to **petty-cash-claim**:
   - `RESEND_API_KEY` = the key
   - `MAIL_FROM` = `LVC Petty Cash <no-reply@lvc-ecopack.com>`

**B. Company SMTP (Microsoft 365 / Google Workspace)**
Railway only allows outgoing SMTP on the **Pro** plan. If you have it, add:
- `SMTP_HOST`: `smtp.office365.com` (Microsoft 365) or `smtp.gmail.com` (Google)
- `SMTP_PORT`: `587`
- `SMTP_USER` / `SMTP_PASS`: the sending mailbox and its password (or app password)
- `MAIL_FROM`: `LVC Petty Cash <no-reply@lvc-ecopack.com>`

## 4. Share the link
The form is at the service's domain (**Settings > Networking**), for example
`https://petty-cash-claim-production.up.railway.app`. Every push to the `main` branch on GitHub redeploys it.

To use an address like `claims.lvc-ecopack.com`, add it under **Settings > Networking > Custom Domain** and create the CNAME record Railway shows.

## How staff use it
1. **First time:** open the link, choose **Create account**, and enter their company email, full name, department and phone. Then type in the 6-digit code that's emailed to them.
2. **After that:** choose **Sign in**, enter their email and type in the code. A sign-in lasts 30 days on that browser.

Only `@lvc-ecopack.com` addresses can register. Codes expire after 10 minutes and stop working after 5 wrong tries.

## Who sees what
| | Employee | Admin |
|---|---|---|
| Create an account with a company email | Yes | Yes |
| Submit claims | Yes | Yes |
| See their own claims in "My history" | Yes | Yes |
| See everyone's claims, summaries and PDFs in "Admin" | No | Yes |
| Export to CSV (Excel) | No | Yes |
| Edit or delete a submitted claim | No | No (it's a permanent record) |

## Adding or removing admins
Change the `ADMIN_EMAILS` variable on the **petty-cash-claim** service, for example
`wenqi@lvc-ecopack.com,someone@lvc-ecopack.com`. The change applies after the automatic redeploy.

## Backups
Railway's Postgres service has a **Backups** tab. Turn on scheduled backups there so claims and PDFs can be restored if needed.
