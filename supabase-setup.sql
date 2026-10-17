-- LVC Petty Cash Claims: Supabase setup
-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste > Run.
-- Safe to run again (it skips or replaces what already exists).

-- 1. Admins ------------------------------------------------------------------
create table if not exists public.admins (
  email text primary key
);
alter table public.admins enable row level security;   -- no policies: not readable from the browser

insert into public.admins (email) values ('wenqi@lvc-ecopack.com')
on conflict (email) do nothing;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_admin() to authenticated;

-- 2. Only company email addresses can sign up ---------------------------------
create or replace function public.enforce_lvc_email()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.email is null or lower(new.email) not like '%@lvc-ecopack.com' then
    raise exception 'Only @lvc-ecopack.com email addresses can sign in.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_lvc_email on auth.users;
create trigger enforce_lvc_email
  before insert on auth.users
  for each row execute function public.enforce_lvc_email();

-- 3. Claims ------------------------------------------------------------------
create table if not exists public.claims (
  id            uuid primary key default gen_random_uuid(),
  ref           text not null unique,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  email         text not null,
  name          text not null,
  department    text not null,
  phone         text,
  purpose       text not null,
  claim_date    date not null,
  total_cents   bigint not null check (total_cents > 0),
  items         jsonb not null,            -- [{date, receipt, category, desc, cents}]
  receipts      jsonb not null default '[]'::jsonb,   -- original receipt file names
  pdf_path      text,                      -- path in the claim-pdfs bucket
  submitted_at  timestamptz not null default now()
);
create index if not exists claims_user_idx on public.claims (user_id, submitted_at desc);
create index if not exists claims_submitted_idx on public.claims (submitted_at desc);

alter table public.claims enable row level security;

-- Staff read their own claims; admins read everything.
drop policy if exists "claims: read own or admin" on public.claims;
create policy "claims: read own or admin" on public.claims
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Staff can only file claims as themselves, under their own sign-in email.
drop policy if exists "claims: insert own" on public.claims;
create policy "claims: insert own" on public.claims
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and lower(email) = lower(auth.jwt() ->> 'email')
  );
-- No update or delete policies: a submitted claim cannot be changed or removed from the browser.

-- 4. PDF storage --------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('claim-pdfs', 'claim-pdfs', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

-- Files live at <user id>/<claim ref>.pdf
drop policy if exists "claim pdfs: upload own" on storage.objects;
create policy "claim pdfs: upload own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'claim-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "claim pdfs: read own or admin" on storage.objects;
create policy "claim pdfs: read own or admin" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'claim-pdfs'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- To add another admin later:
--   insert into public.admins (email) values ('someone@lvc-ecopack.com');
-- To remove one:
--   delete from public.admins where email = 'someone@lvc-ecopack.com';
