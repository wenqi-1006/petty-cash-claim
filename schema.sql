-- LVC Petty Cash Claims: PostgreSQL schema.
-- The server runs this automatically at start-up. It is safe to run again.

create table if not exists users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,          -- always stored lower-case
  full_name      text not null,
  department     text not null,
  phone          text,
  password_hash  text,                           -- scrypt; never the password itself
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table users add column if not exists password_hash text;

-- Email sign-in codes are no longer used.
drop table if exists login_codes;

-- Signed-in browsers. Only a hash of each session token is stored.
create table if not exists sessions (
  token_hash  text primary key,
  user_id     uuid not null references users (id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions (user_id);

-- Submitted claims, with the combined claim PDF. Claims are never updated or deleted by the app.
create table if not exists claims (
  id            uuid primary key default gen_random_uuid(),
  ref           text not null unique,
  user_id       uuid not null references users (id),
  email         text not null,
  name          text not null,
  department    text not null,
  phone         text,
  purpose       text not null,
  claim_date    date not null,
  total_cents   bigint not null check (total_cents > 0),
  items         jsonb not null,              -- [{date, receipt, category, desc, cents}]
  receipts      jsonb not null default '[]'::jsonb,
  pdf           bytea not null,
  pdf_size      int not null,
  submitted_at  timestamptz not null default now()
);
create index if not exists claims_user_idx on claims (user_id, submitted_at desc);
create index if not exists claims_submitted_idx on claims (submitted_at desc);
