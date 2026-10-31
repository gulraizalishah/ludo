-- Step 4c (v2): automatic withdrawals, fees by table size (2 players: 5%, 4 players: 10%), taking your earnings.

-- ---- settings (edit any time in the app_settings table, no code change)
insert into public.app_settings (key, value) values
  ('fee_percent_2p', '5'), ('fee_percent_4p', '10'),
  ('auto_withdraw_max', '100'),          -- bigger single withdrawals wait for your approval
  ('auto_withdraw_daily_max', '500')     -- per player per 24 hours; more than that waits for your approval
on conflict (key) do update set value = excluded.value;
update public.app_settings set value = '10' where key = 'min_withdrawal';

-- ---- allow the new ledger kind and the new withdrawal status
do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'public.ledger'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%';
  if c is not null then execute format('alter table public.ledger drop constraint %I', c); end if;
  alter table public.ledger add constraint ledger_kind_check check (kind in
    ('deposit','stake_lock','stake_refund','match_loss','match_win','platform_fee','withdrawal_request','withdrawal_refund','platform_payout'));
  select conname into c from pg_constraint where conrelid = 'public.withdrawals'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%';
  if c is not null then execute format('alter table public.withdrawals drop constraint %I', c); end if;
  alter table public.withdrawals add constraint withdrawals_status_check check (status in ('pending','processing','sent','rejected'));
end $$;
alter table public.withdrawals add column if not exists processing_at timestamptz;

-- ---- the fee now depends on the table size
create or replace function public.settle_match(p_match uuid, p_winner uuid) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches; r match_players; v_pool numeric; v_pct numeric; v_fee numeric; v_pay numeric;
begin
  select * into m from matches where id = p_match for update;
  if m.status = 'finished' then return m; end if;
  if m.status <> 'active' then raise exception 'match not active'; end if;
  if not exists (select 1 from match_players where match_id = p_match and user_id = p_winner) then
    raise exception 'winner is not in this match';
  end if;
  select sum(stake_locked) into v_pool from match_players where match_id = p_match;
  v_pct := _setting(case when m.max_players = 2 then 'fee_percent_2p' else 'fee_percent_4p' end);
  v_fee := round(v_pool * v_pct / 100, 6);
  v_pay := v_pool - v_fee;
  for r in select * from match_players where match_id = p_match order by user_id loop
    if r.user_id = p_winner then perform _post(r.user_id, 'match_win',  v_pay, -r.stake_locked, p_match);
    else                         perform _post(r.user_id, 'match_loss', 0,     -r.stake_locked, p_match);
    end if;
  end loop;
  perform _post(null, 'platform_fee', v_fee, 0, p_match);
  update matches set status = 'finished', winner_id = p_winner, fee_percent = v_pct, pool = v_pool,
         fee = v_fee, payout = v_pay, finished_at = now(), version = version + 1
   where id = p_match returning * into m;
  return m;
end $$;

-- ---- automatic payout bookkeeping: pending -> processing (claimed by ONE caller) -> sent | rejected (refunded)
create function public.claim_withdrawal(p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update withdrawals set status = 'processing', processing_at = now() where id = p_id and status = 'pending';
  get diagnostics n = row_count;
  return n = 1;
end $$;
-- the transaction id is saved BEFORE it is broadcast, so a lost reply can never cause a second payment
create function public.set_withdrawal_tx(p_id uuid, p_tx text) returns void
language sql security definer set search_path = public as $$
  update withdrawals set tx_hash = p_tx where id = p_id and status = 'processing' and tx_hash is null;
$$;
create function public.release_withdrawal(p_id uuid) returns void   -- nothing was sent yet: back to the queue
language sql security definer set search_path = public as $$
  update withdrawals set status = 'pending', processing_at = null where id = p_id and status = 'processing' and tx_hash is null;
$$;
create or replace function public.mark_withdrawal_sent(p_id uuid, p_tx text) returns void
language sql security definer set search_path = public as $$
  update withdrawals set status = 'sent', tx_hash = p_tx, processed_at = now() where id = p_id and status in ('pending','processing');
$$;
create or replace function public.reject_withdrawal(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare w withdrawals;
begin
  select * into w from withdrawals where id = p_id and status in ('pending','processing') for update;
  if not found then return; end if;
  update withdrawals set status = 'rejected', processed_at = now() where id = p_id;
  perform _post(w.user_id, 'withdrawal_refund', w.amount, 0, null, p_id::text);
end $$;

-- ---- you take your earnings: moves platform fees to the admin's own balance (then use Withdraw like anyone)
create function public.platform_payout(p_admin uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = public as $$
declare v_bal numeric;
begin
  if not exists (select 1 from profiles where id = p_admin and is_admin) then raise exception 'not an admin'; end if;
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;
  lock table ledger in share row exclusive mode;
  select coalesce(sum(d_available), 0) into v_bal from ledger where user_id is null;
  if p_amount > v_bal then raise exception 'only % of platform earnings are available', v_bal; end if;
  perform _post(null, 'platform_payout', -p_amount, 0);
  perform _post(p_admin, 'platform_payout', p_amount, 0);
end $$;

-- ---- overview now knows about withdrawals being sent
drop view if exists public.admin_overview;
create view public.admin_overview with (security_invoker = true) as
select
  (select coalesce(sum(amount), 0) from public.deposits)                                    as deposits_total,
  (select coalesce(sum(d_available), 0) from public.ledger where user_id is null)          as platform_fees,
  (select coalesce(sum(available), 0) from public.wallets)                                 as players_available,
  (select coalesce(sum(locked), 0) from public.wallets)                                    as players_locked,
  (select count(*) from public.withdrawals where status = 'pending')                       as pending_count,
  (select coalesce(sum(amount), 0) from public.withdrawals where status = 'pending')       as pending_amount,
  (select count(*) from public.withdrawals where status = 'processing')                    as processing_count,
  (select coalesce(sum(amount), 0) from public.withdrawals where status = 'sent')          as paid_out_total,
  (select count(*) from public.matches where status = 'active')                            as active_matches,
  (select count(*) from public.ledger_mismatches)                                          as wallet_mismatches,
  (select coalesce(sum(amount), 0) from public.deposits)
    - (select coalesce(sum(available), 0) from public.wallets)
    - (select coalesce(sum(locked), 0) from public.wallets)
    - (select coalesce(sum(d_available), 0) from public.ledger where user_id is null)
    - (select coalesce(sum(amount), 0) from public.withdrawals where status in ('pending','processing','sent')) as unaccounted;
revoke all on public.admin_overview from anon, authenticated;
grant select on public.admin_overview to service_role;

-- only the server may call the money functions
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant execute on function public.is_in_match(uuid) to authenticated;
