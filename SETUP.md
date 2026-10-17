# LVC Petty Cash Claims: setup

Everything runs on **Railway**:
- **petty-cash-claim**: a small Node.js server (`server.js`). It serves the form and handles accounts, claims, history and the admin summary.
- **Postgres**: a Railway PostgreSQL database. It stores accounts, sign-in sessions, claims and each claim's PDF.

The server creates the database tables itself on start-up (`schema.sql`), so there is no SQL to run by hand. No email service is needed.

## 1. Add the database
In the Railway project, click **Create > Database > PostgreSQL**. Railway starts a `Postgres` service.
Leave the database's **Public access** off: the server reaches it over Railway's private network.

## 2. Set the server's variables
Open the **petty-cash-claim** service > **Variables** and add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (a reference to the database; Railway fills in the real value) |
| `ADMIN_EMAILS` | `wenqi@lvc-ecopack.com` (separate several with commas) |
| `EMAIL_DOMAIN` | `lvc-ecopack.com` (optional; this is the default) |

Railway redeploys automatically after you save.

## 3. Share the link
The form is at the service's domain (**Settings > Networking**), for example
`https://petty-cash-claim-production.up.railway.app`. Every push to the `main` branch on GitHub redeploys it.

To use an address like `claims.lvc-ecopack.com`, add it under **Settings > Networking > Custom Domain** and create the CNAME record Railway shows.

## How staff use it
1. **First time:** open the link, choose **Create account**, and enter their company email, full name, department, phone and a password (at least 6 characters).
2. **After that:** choose **Sign in** and enter their email and password. A sign-in lasts 30 days on that browser.
3. **Change password:** click **Change password** next to their email at the top of the form. This also signs out any other browsers.

Only `@lvc-ecopack.com` addresses can register. After 10 wrong passwords, that email is locked out for 15 minutes.

**Note:** there's no email check, so the form can't confirm that the person registering really owns that mailbox.
The admin should look over **Admin > Employee accounts** now and then, and reset any account that looks wrong.

## Forgotten passwords
The admin opens **Admin**, scrolls to **Employee accounts**, and clicks **Reset password** next to the person (twice, to confirm).
A temporary password like `lvc-7kq4-m2xp` appears **once**. Give it to the employee in person or by phone.
They sign in with it, then choose **Change password**. Resetting also signs the person out everywhere.

## Who sees what
| | Employee | Admin |
|---|---|---|
| Create an account with a company email | Yes | Yes |
| Submit claims | Yes | Yes |
| See their own claims in "My history" | Yes | Yes |
| See everyone's claims, summaries and PDFs in "Admin" | No | Yes |
| Export to CSV (Excel) | No | Yes |
| Reset someone's password | No | Yes |
| Edit or delete a submitted claim | No | No (it's a permanent record) |

## Adding or removing admins
Change the `ADMIN_EMAILS` variable on the **petty-cash-claim** service, for example
`wenqi@lvc-ecopack.com,someone@lvc-ecopack.com`. The change applies after the automatic redeploy.
The admin also needs an account: they register with **Create account** like everyone else.

## Backups
Railway's Postgres service has a **Backups** tab. Turn on scheduled backups there so claims and PDFs can be restored if needed.
