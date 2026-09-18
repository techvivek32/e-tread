-- NOVA E*TRADE — trade archive schema
--
-- Run once in the NEW Supabase project for this instance -- never the existing USA/IBKR project.
-- Mirrors `ibkr_trades` so History / Analysis / FIFO P&L keep working unchanged.
--
-- The primary key is the broker's own execution id: the upsert is therefore IDEMPOTENT and a
-- replayed poll can never double-count a fill (that bug doubles a day's P&L).

create table if not exists public.etrade_trades (
  execution_id      text primary key,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,

  account_id_key    text not null,
  order_id          text,

  symbol            text not null,
  security_type     text not null default 'EQ',      -- EQ | OPTN
  side              text not null,                   -- BUY | SELL | BUY_TO_COVER | SELL_SHORT | BUY_OPEN | SELL_CLOSE ...
  quantity          numeric not null,
  price             numeric not null,
  commission        numeric not null default 0,
  fees              numeric not null default 0,

  executed_at       timestamptz not null,
  -- Day attribution is ALWAYS America/New_York. An IST viewer otherwise splits one trading
  -- day across two, and every daily statement comes out wrong.
  et_day            date not null,

  -- Option legs, when security_type = 'OPTN'
  underlying        text,
  call_put          text,
  strike_price      numeric,
  expiry_date       date,

  -- Filled orders surface here seconds after the fill, before the slow trade feed catches up.
  provisional       boolean not null default false,

  raw               jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists etrade_trades_user_day_idx on public.etrade_trades (user_id, et_day desc);
create index if not exists etrade_trades_symbol_idx   on public.etrade_trades (user_id, symbol, executed_at desc);
create index if not exists etrade_trades_order_idx    on public.etrade_trades (order_id);

-- ---------------------------------------------------------------- row level security
-- Isolation at the database, not just in the UI. A leaked anon key must not expose one
-- trader's book to another.

alter table public.etrade_trades enable row level security;

drop policy if exists "etrade_trades_select_own" on public.etrade_trades;
create policy "etrade_trades_select_own"
  on public.etrade_trades for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "etrade_trades_insert_own" on public.etrade_trades;
create policy "etrade_trades_insert_own"
  on public.etrade_trades for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "etrade_trades_update_own" on public.etrade_trades;
create policy "etrade_trades_update_own"
  on public.etrade_trades for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Deliberately NO delete policy: the archive is append-only. A trade record that can be
-- deleted is an archive nobody can trust at tax time.

-- ------------------------------------------------------------------- global app flags
-- Same pattern as the USA build: all authenticated users read, only admins write.

create table if not exists public.app_flags (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table public.app_flags enable row level security;

drop policy if exists "app_flags_read_all" on public.app_flags;
create policy "app_flags_read_all"
  on public.app_flags for select
  to authenticated
  using (true);

-- FILL THIS IN before running: the admin email(s) allowed to write global flags.
drop policy if exists "app_flags_write_admin" on public.app_flags;
create policy "app_flags_write_admin"
  on public.app_flags for all
  to authenticated
  using (auth.jwt() ->> 'email' in ('ADMIN_EMAIL_HERE'))
  with check (auth.jwt() ->> 'email' in ('ADMIN_EMAIL_HERE'));
