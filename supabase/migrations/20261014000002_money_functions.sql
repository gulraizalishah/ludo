-- Step 2b: all money logic lives in the database, inside single transactions.
-- Only the server (service_role, i.e. your Edge Functions) can call these. Browsers cannot.

alter default privileges revoke execute on functions from public;   -- new functions: not callable by everyone

-- The ONE place a balance changes: updates the wallet and writes the ledger row together.
-- If a balance would go negative, the wallet CHECK fails and the whole transaction rolls back.
create function public._post(p_user uuid, p_kind text, p_av numeric, p_lk numeric,
                             p_match uuid default null, p_ref text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is not null then
    update wallets set available = available + p_av, locked = locked + p_lk, updated_at = now()
     where user_id = p_user;
  end if;
  insert into ledger (user_id, kind, d_available, d_locked, match_id, ref)
  values (p_user, p_kind, p_av, p_lk, p_match, p_ref);
end $$;

create function public._setting(p_key text) returns numeric
language sql stable security definer set search_path = public as $$
  select (value #>> '{}')::numeric from app_settings where key = p_key
$$;

-- A confirmed on-chain USDT deposit. Safe to call twice for the same tx: the second call does nothing.
create function public.credit_deposit(p_user uuid, p_tx text, p_amount numeric) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into deposits (user_id, tx_hash, amount) values (p_user, p_tx, p_amount)
  on conflict (tx_hash) do nothing;
  if not found then return false; end if;
  perform _post(p_user, 'deposit', p_amount, 0, null, p_tx);
  return true;
end $$;

-- Join (or open) a table with this stake. The stake is locked immediately.
-- When the last seat fills, colours are dealt at random and the match becomes active.
create function public.quick_match(p_user uuid, p_stake numeric, p_players int) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches; cnt int;
begin
  if not exists (select 1 from profiles where id = p_user and not is_banned) then raise exception 'account not allowed'; end if;
  if p_stake < _setting('min_stake') or p_stake > _setting('max_stake') then raise exception 'stake out of range'; end if;
  if exists (select 1 from match_players mp join matches x on x.id = mp.match_id
              where mp.user_id = p_user and x.status in ('waiting','active')) then
    raise exception 'already in a match';
  end if;

  select * into m from matches
   where status = 'waiting' and stake = p_stake and max_players = p_players
   order by created_at limit 1 for update;
  if not found then
    insert into matches (max_players, stake) values (p_players, p_stake) returning * into m;
  end if;

  perform _post(p_user, 'stake_lock', -p_stake, p_stake, m.id);
  insert into match_players (match_id, user_id, stake_locked) values (m.id, p_user, p_stake);

  select count(*) into cnt from match_players where match_id = m.id;
  if cnt = m.max_players then
    update match_players mp set color = c.col
      from (select user_id, row_number() over (order by random()) rn from match_players where match_id = m.id) pl
      join (select col, row_number() over (order by random()) rn
              from unnest(case when m.max_players = 2 then array['red','yellow']
                               else array['red','green','yellow','blue'] end) col) c on c.rn = pl.rn
     where mp.match_id = m.id and mp.user_id = pl.user_id;
    update matches set status = 'active', started_at = now() where id = m.id returning * into m;
  end if;
  return m;
end $$;

-- Leave a table that has not started yet: stake comes straight back.
create function public.leave_match(p_user uuid, p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m matches; r match_players;
begin
  select * into m from matches where id = p_match for update;
  if m.status <> 'waiting' then raise exception 'match already started'; end if;
  select * into r from match_players where match_id = p_match and user_id = p_user;
  if not found then return; end if;
  perform _post(p_user, 'stake_refund', r.stake_locked, -r.stake_locked, p_match);
  delete from match_players where match_id = p_match and user_id = p_user;
  if not exists (select 1 from match_players where match_id = p_match) then
    update matches set status = 'cancelled', finished_at = now() where id = p_match;
  end if;
end $$;

-- Abandoned or broken match: everybody gets their stake back.
create function public.cancel_match(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m matches; r match_players;
begin
  select * into m from matches where id = p_match for update;
  if m.status not in ('waiting','active') then return; end if;
  for r in select * from match_players where match_id = p_match order by user_id loop
    perform _post(r.user_id, 'stake_refund', r.stake_locked, -r.stake_locked, p_match);
  end loop;
  update matches set status = 'cancelled', finished_at = now(), version = version + 1 where id = p_match;
end $$;

-- Winner takes the pool minus the platform fee (25% of the TOTAL pool). Runs once per match.
create function public.settle_match(p_match uuid, p_winner uuid) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches; r match_players; v_pool numeric; v_pct numeric; v_fee numeric; v_pay numeric;
begin
  select * into m from matches where id = p_match for update;
  if m.status = 'finished' then return m; end if;                 -- already paid out: do nothing twice
  if m.status <> 'active' then raise exception 'match not active'; end if;
  if not exists (select 1 from match_players where match_id = p_match and user_id = p_winner) then
    raise exception 'winner is not in this match';
  end if;
  select sum(stake_locked) into v_pool from match_players where match_id = p_match;
  v_pct := _setting('platform_fee_percent');
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

-- Withdrawals: money leaves "available" at once; the server later sends USDT and marks it sent, or rejects (refund).
create function public.request_withdrawal(p_user uuid, p_amount numeric, p_address text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from profiles where id = p_user and not is_banned) then raise exception 'account not allowed'; end if;
  if p_amount < _setting('min_withdrawal') then raise exception 'below minimum withdrawal'; end if;
  if p_address !~ '^T[1-9A-HJ-NP-Za-km-z]{33}$' then raise exception 'invalid TRON address'; end if;
  insert into withdrawals (user_id, amount, to_address) values (p_user, p_amount, p_address) returning id into v_id;
  perform _post(p_user, 'withdrawal_request', -p_amount, 0, null, v_id::text);
  return v_id;
end $$;
create function public.mark_withdrawal_sent(p_id uuid, p_tx text) returns void
language sql security definer set search_path = public as $$
  update withdrawals set status = 'sent', tx_hash = p_tx, processed_at = now() where id = p_id and status = 'pending';
$$;
create function public.reject_withdrawal(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare w withdrawals;
begin
  select * into w from withdrawals where id = p_id and status = 'pending' for update;
  if not found then return; end if;
  update withdrawals set status = 'rejected', processed_at = now() where id = p_id;
  perform _post(w.user_id, 'withdrawal_refund', w.amount, 0, null, p_id::text);
end $$;

-- Safety net: any wallet that disagrees with its own ledger shows up here. Should always be EMPTY.
create view public.ledger_mismatches with (security_invoker = true) as
select w.user_id, w.available, w.locked,
       coalesce(sum(l.d_available), 0) as ledger_available, coalesce(sum(l.d_locked), 0) as ledger_locked
  from wallets w left join ledger l on l.user_id = w.user_id
 group by w.user_id, w.available, w.locked
having w.available <> coalesce(sum(l.d_available), 0) or w.locked <> coalesce(sum(l.d_locked), 0);

-- Lock the doors explicitly (does not depend on defaults): only the server may call the money functions.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant execute on function public.is_in_match(uuid) to authenticated;   -- needed by the read policies
revoke all on public.ledger_mismatches from anon, authenticated;
