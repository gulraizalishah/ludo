-- Step 2a: core tables, security rules (RLS) and realtime.
-- Money columns are numeric(18,6): exact decimals, never floats. USDT has 6 decimals.

create table public.app_settings (key text primary key, value jsonb not null);
insert into public.app_settings(key, value) values
  ('platform_fee_percent', '25'),   -- your cut of the TOTAL pool
  ('min_stake', '1'), ('max_stake', '100'),
  ('min_withdrawal', '5');          -- placeholders: edit freely, no code change needed

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  is_admin boolean not null default false,
  is_banned boolean not null default false,
  created_at timestamptz not null default now()
);

-- One wallet per user. available = can play/withdraw, locked = stakes held in running matches.
create table public.wallets (
  user_id uuid primary key references public.profiles on delete cascade,
  available numeric(18,6) not null default 0 check (available >= 0),
  locked numeric(18,6) not null default 0 check (locked >= 0),
  updated_at timestamptz not null default now()
);

-- Every money movement is a ledger row. user_id NULL = the platform (your fee).
-- Balances can always be re-derived from here (see the ledger_mismatches view).
create table public.ledger (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles,
  kind text not null check (kind in ('deposit','stake_lock','stake_refund','match_loss','match_win',
                                     'platform_fee','withdrawal_request','withdrawal_refund')),
  d_available numeric(18,6) not null default 0,
  d_locked numeric(18,6) not null default 0,
  match_id uuid,
  ref text,
  created_at timestamptz not null default now()
);
create index on public.ledger (user_id, created_at desc);

-- Only PUBLIC addresses are stored here, never private keys.
create table public.deposit_addresses (
  user_id uuid primary key references public.profiles on delete cascade,
  address text not null unique,
  derivation_index bigint generated always as identity unique,
  created_at timestamptz not null default now()
);
create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles,
  tx_hash text not null unique,            -- unique = a transaction can never be credited twice
  amount numeric(18,6) not null check (amount > 0),
  created_at timestamptz not null default now()
);
create table public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles,
  amount numeric(18,6) not null check (amount > 0),
  to_address text not null,
  status text not null default 'pending' check (status in ('pending','sent','rejected')),
  tx_hash text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  game text not null default 'ludo',
  max_players int not null check (max_players in (2, 4)),
  stake numeric(18,6) not null check (stake > 0),
  status text not null default 'waiting' check (status in ('waiting','active','finished','cancelled')),
  state jsonb,                              -- the engine's game state (written only by the server)
  version int not null default 0,           -- bumped on every move; stops two moves racing each other
  turn_deadline timestamptz,
  winner_id uuid references public.profiles,
  fee_percent numeric(5,2), pool numeric(18,6), fee numeric(18,6), payout numeric(18,6),  -- frozen at settlement
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index on public.matches (status, stake, max_players);
create table public.match_players (
  match_id uuid not null references public.matches on delete cascade,
  user_id uuid not null references public.profiles,
  color text check (color in ('red','green','yellow','blue')),   -- assigned at random when the table fills
  stake_locked numeric(18,6) not null,
  joined_at timestamptz not null default now(),
  primary key (match_id, user_id),
  unique (match_id, color)
);
create index on public.match_players (user_id);

-- New sign-up -> profile + empty wallet automatically.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id);
  insert into public.wallets (user_id) values (new.id);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Security: players may READ their own data and NOTHING can be written from the browser ----------
alter table public.app_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.ledger enable row level security;
alter table public.deposit_addresses enable row level security;
alter table public.deposits enable row level security;
alter table public.withdrawals enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;

create function public.is_in_match(m uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.match_players where match_id = m and user_id = auth.uid())
$$;
grant execute on function public.is_in_match(uuid) to authenticated;

create policy settings_read on public.app_settings for select to authenticated using (true);
create policy profile_own  on public.profiles for select to authenticated using (id = auth.uid());
create policy profile_edit on public.profiles for update to authenticated using (id = auth.uid());
create policy wallet_own   on public.wallets for select to authenticated using (user_id = auth.uid());
create policy ledger_own   on public.ledger for select to authenticated using (user_id = auth.uid());
create policy addr_own     on public.deposit_addresses for select to authenticated using (user_id = auth.uid());
create policy deposit_own  on public.deposits for select to authenticated using (user_id = auth.uid());
create policy wd_own       on public.withdrawals for select to authenticated using (user_id = auth.uid());
create policy match_read   on public.matches for select to authenticated
  using (status = 'waiting' or public.is_in_match(id));
create policy mplayer_read on public.match_players for select to authenticated using (public.is_in_match(match_id));

-- Belt and braces: even without policies, strip write permissions. Users may only change their username.
revoke insert, update, delete on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;
grant update (username) on public.profiles to authenticated;

-- Live board updates for the players.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.matches, public.match_players;
  end if;
end $$;
