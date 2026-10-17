# LVC Petty Cash Claims: setup

The form (`petty-cash-claim.html`) stores claims in **Supabase**, a hosted database with email sign-in.
One-time setup takes about 20 minutes.

## 1. Create the Supabase project
1. Go to https://supabase.com and sign up (the free plan is enough to start).
2. Click **New project**. Name it `lvc-petty-cash`, set a database password (keep it safe),
   and choose the region **Southeast Asia (Singapore)**.

## 2. Create the database
1. In the project, open **SQL Editor > New query**.
2. Paste the whole of `supabase-setup.sql` and click **Run**. It should say "Success".

This creates the employee profiles and claims tables, the PDF storage, the security rules and the admin list
(`wenqi@lvc-ecopack.com`). It also blocks accounts for any email that doesn't end in `@lvc-ecopack.com`.

## 3. Make the emails send a code
Employees create an account once and then sign in with a code sent to their email. Supabase uses two email templates for this, and both must show the code.
Open **Authentication > Emails (Email Templates)**:

**Confirm signup** (sent when someone creates an account): subject `Confirm your LVC Petty Cash account`, body:
```html
<h2>Welcome to LVC Petty Cash</h2>
<p>Enter this code to confirm your email and create your account:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
<p>It expires in 1 hour. If you didn't ask for this, ignore this email.</p>
```

**Magic Link** (sent at every later sign-in): subject `Your LVC Petty Cash sign-in code`, body:
```html
<h2>LVC Petty Cash sign-in</h2>
<p>Your sign-in code is:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
<p>It expires in 1 hour. If you didn't ask for this, ignore this email.</p>
```

Also check that **Authentication > Sign In / Providers > Email** is enabled and **Allow new users to sign up** is on.

## 4. Send emails through the company mailbox (required for real use)
Supabase's built-in email sender is for testing only. It sends just a few emails per hour.
Before staff start using the form, open **Authentication > Emails > SMTP Settings**,
turn on **Custom SMTP** and enter your mail server details. Your IT person or email provider has these.
- **Microsoft 365:** host `smtp.office365.com`, port `587`, a mailbox such as `noreply@lvc-ecopack.com` and its password.
- **Google Workspace:** host `smtp.gmail.com`, port `587`, with an app password.

Then, under **Authentication > Rate Limits**, raise "emails per hour" to a comfortable number (for example 100).

## 5. Connect the form
1. Open **Project Settings > API**. Copy the **Project URL** and the **anon public** key.
2. Open `petty-cash-claim.html` in a text editor (for example Notepad). Near the top of the `<script>`, replace:
   ```js
   const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
   const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";
   ```
   with your values, then save.

   The anon key is meant to be public. The security rules from step 2 decide what each person can see.

## 6. Share the form
Give staff the `petty-cash-claim.html` file, for example on a shared drive, or host it on your website or intranet.
Staff open it in Chrome or Edge, then:
1. **First time:** choose **Create account**, enter their company email, full name, department and phone, and type in the code that's emailed to them.
2. **After that:** choose **Sign in**, enter their company email and type in the code.

Their name, department and phone fill in each new claim. If they change these on a claim, their account is updated to match.

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
In **SQL Editor**, run:
```sql
insert into public.admins (email) values ('someone@lvc-ecopack.com');   -- add
delete from public.admins where email = 'someone@lvc-ecopack.com';      -- remove
```
The person signs out and back in to see the change.
