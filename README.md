# LVC Petty Cash Claim

Petty cash claim form for LVC employees. Staff create an account with their company email, list their expenses, attach the receipt PDFs, sign, and submit.
Each claim is saved with one combined PDF (the claim form followed by the receipts). Staff can see their own claim history, and admins can see and summarise every claim.

Runs on **Railway**: a Node.js server with a **PostgreSQL** database.

| File | What it is |
|---|---|
| `petty-cash-claim.html` | The form, served as the site's home page. |
| `server.js` | The server: sign-in codes, sessions, claims, PDFs and the admin API. |
| `schema.sql` | Database tables. The server applies them automatically at start-up. |
| `package.json`, `Dockerfile` | How Railway builds and runs the server. |
| `SETUP.md` | Railway setup: database, variables, sign-in email. |
