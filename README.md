# LVC Petty Cash Claim

Petty cash claim form for LVC employees. Staff sign in with their company email, list their expenses, attach the receipt PDFs, sign, and submit.
Each claim is saved with one combined PDF (the claim form followed by the receipts). Staff can see their own claim history, and admins can see and summarise every claim.

| File | What it is |
|---|---|
| `petty-cash-claim.html` | The form, a single page. Open it in Chrome or Edge. |
| `supabase-setup.sql` | Creates the database tables, PDF storage, security rules and admin list in Supabase. |
| `Dockerfile`, `Caddyfile`, `railway.json` | Hosting on Railway: serves the form as the site's home page. |
| `SETUP.md` | Step-by-step setup: Supabase project, sign-in email, company SMTP, connecting the form. |
