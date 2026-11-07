-- Step 5: sign-up gate (18+ and terms), withdrawal safeguards, player limits, self-exclusion, and risk views.

-- ---------- player profile fields (players can read their own row but can never change these directly)
alter table public.profiles
  add column if not exists age_confirmed_at timestamptz,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists limit_stake_daily numeric(18,6),     -- max total staked per 24 hours (null = no limit)
  add column if not exists limit_pending numeric(18,6),         -- a raised limit only applies after a 24 hour wait
  add column if not exists limit_pending_at timestamptz,
  add column if not exists excluded_until timestamptz;          -- self-exclusion: no new matches until then

-- accounts that already exist (test accounts) count as accepted; every NEW sign-up must accept on the sign-up page
update public.profiles set age_confirmed_at = coalesce(age_confirmed_at, now()), terms_accepted_at = coalesce(terms_accepted_at, now());

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, age_confirmed_at, terms_accepted_at) values (
    new.id,
    case when new.raw_user_meta_data ->> 'age_confirmed'  = 'true' then now() end,
    case when new.raw_user_meta_data ->> 'terms_accepted' = 'true' then now() end);
  insert into public.wallets (user_id) values (new.id);
  return new;
end $$;

-- ---------- settings (0 / empty = switched off; testnet defaults are off, recommended launch values are in LAUNCH_CHECKLIST.md)
insert into public.app_settings (key, value) values
  ('withdraw_min_age_hours', '0'),      -- new accounts must wait this long before their first withdrawal
  ('withdraw_min_matches', '0'),        -- finished matches needed before any withdrawal
  ('withdraw_wager_ratio', '0'),        -- must have staked this multiple of all deposits (1 = every deposit played through once)
  ('first_withdrawal_manual', 'false'), -- the first withdrawal of every account waits for your approval
  ('blocked_countries', '[]'),          -- e.g. ["US","GB"]: no new matches or deposits from these countries
  ('geo_strict', 'false'),              -- true = also refuse when the country cannot be determined
  ('alert_hot_min', '50')               -- alert when the payout wallet holds less than this (plus what is waiting)
on conflict (key) do nothing;

-- ---------- withdrawal safeguards (enforced in the database, so nothing can skip them)
create or replace function public.request_withdrawal(p_user uuid, p_amount numeric, p_address text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_prof profiles; v_hours numeric; v_need int; v_played int; v_ratio numeric; v_staked numeric; v_dep numeric;
begin
  select * into v_prof from profiles where id = p_user and not is_banned;
  if not found then raise exception 'account not allowed'; end if;
  if p_amount < _setting('min_withdrawal') then raise exception 'below minimum withdrawal'; end if;
  if p_address !~ '^T[1-9A-HJ-NP-Za-km-z]{33}$' then raise exception 'invalid TRON address'; end if;

  v_hours := coalesce(_setting('withdraw_min_age_hours'), 0);
  if v_hours > 0 and v_prof.created_at > now() - make_interval(hours => v_hours::int) then
    raise exception 'New accounts can withdraw % hours after sign-up.', v_hours::int;
  end if;
  v_need := coalesce(_setting('withdraw_min_matches'), 0)::int;
  select count(*) into v_played from match_players mp join matches m on m.id = mp.match_id where mp.user_id = p_user and m.status = 'finished';
  if v_played < v_need then raise exception 'Play at least % finished matches before withdrawing (you have played %).', v_need, v_played; end if;
  v_ratio := coalesce(_setting('withdraw_wager_ratio'), 0);
  if v_ratio > 0 then
    select coalesce(sum(mp.stake_locked), 0) into v_staked from match_players mp join matches m on m.id = mp.match_id where mp.user_id = p_user and m.status = 'finished';
    select coalesce(sum(amount), 0) into v_dep from deposits where user_id = p_user;
    if v_staked < v_ratio * v_dep then
      raise exception 'Before withdrawing you need to play at least % in matches (so far %).', round(v_ratio * v_dep, 2), round(v_staked, 2);
    end if;
  end if;

  insert into withdrawals (user_id, amount, to_address) values (p_user, p_amount, p_address) returning id into v_id;
  perform _post(p_user, 'withdrawal_request', -p_amount, 0, null, v_id::text);
  return v_id;
end $$;

-- ---------- joining a table: age/terms gate, self-exclusion, daily stake limit
create or replace function public.quick_match(p_user uuid, p_stake numeric, p_players int) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches; cnt int; p profiles; v_today numeric;
begin
  select * into p from profiles where id = p_user and not is_banned;
  if not found then raise exception 'account not allowed'; end if;
  if p.age_confirmed_at is null or p.terms_accepted_at is null then raise exception 'Please confirm you are 18 or older and accept the Terms first (Responsible play).'; end if;
  if p.excluded_until is not null and p.excluded_until > now() then
    raise exception 'You paused your account until %.', to_char(p.excluded_until at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"');
  end if;
  if p.limit_pending_at is not null and p.limit_pending_at <= now() then       -- a raised limit becomes active after its 24 hour wait
    update profiles set limit_stake_daily = limit_pending, limit_pending = null, limit_pending_at = null where id = p_user returning * into p;
  end if;
  if p_stake < _setting('min_stake') or p_stake > _setting('max_stake') then raise exception 'stake out of range'; end if;
  if p.limit_stake_daily is not null then
    select coalesce(sum(stake_locked), 0) into v_today from match_players where user_id = p_user and joined_at > now() - interval '24 hours';
    if v_today + p_stake > p.limit_stake_daily then
      raise exception 'This stake would pass your daily limit of % (already staked in the last 24 hours: %).', p.limit_stake_daily, v_today;
    end if;
  end if;
  if exists (select 1 from match_players mp join matches x on x.id = mp.match_id where mp.user_id = p_user and x.status in ('waiting', 'active')) then
    raise exception 'already in a match';
  end if;

  select * into m from matches where status = 'waiting' and stake = p_stake and max_players = p_players order by created_at limit 1 for update;
  if not found then insert into matches (max_players, stake) values (p_players, p_stake) returning * into m; end if;
  perform _post(p_user, 'stake_lock', -p_stake, p_stake, m.id);
  insert into match_players (match_id, user_id, stake_locked) values (m.id, p_user, p_stake);

  select count(*) into cnt from match_players where match_id = m.id;
  if cnt = m.max_players then
    update match_players mp set color = c.col
      from (select user_id, row_number() over (order by random()) rn from match_players where match_id = m.id) pl
      join (select col, row_number() over (order by random()) rn
              from unnest(case when m.max_players = 2 then array['red','yellow'] else array['red','green','yellow','blue'] end) col) c on c.rn = pl.rn
     where mp.match_id = m.id and mp.user_id = pl.user_id;
    update matches set status = 'active', started_at = now() where id = m.id returning * into m;
  end if;
  return m;
end $$;

-- ---------- the player's own controls (called by the server on behalf of the logged-in player)
create function public.accept_terms(p_user uuid) returns void
language sql security definer set search_path = public as $$
  update profiles set age_confirmed_at = coalesce(age_confirmed_at, now()), terms_accepted_at = coalesce(terms_accepted_at, now()) where id = p_user;
$$;
-- lowering a limit is immediate; raising or removing it only takes effect after 24 hours
create function public.set_stake_limit(p_user uuid, p_limit numeric) returns void
language plpgsql security definer set search_path = public as $$
declare cur numeric;
begin
  if p_limit is not null and p_limit <= 0 then raise exception 'The limit must be above zero.'; end if;
  select limit_stake_daily into cur from profiles where id = p_user for update;
  if p_limit is not null and (cur is null or p_limit < cur) then
    update profiles set limit_stake_daily = p_limit, limit_pending = null, limit_pending_at = null where id = p_user;
  elsif p_limit is distinct from cur then
    update profiles set limit_pending = p_limit, limit_pending_at = now() + interval '24 hours' where id = p_user;
  end if;
end $$;
create function public.self_exclude(p_user uuid, p_days int) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare t timestamptz;
begin
  if p_days not in (1, 7, 30) then raise exception 'Choose 1, 7 or 30 days.'; end if;
  update profiles set excluded_until = greatest(coalesce(excluded_until, now()), now() + make_interval(days => p_days)) where id = p_user returning excluded_until into t;
  return t;
end $$;

-- ---------- risk views for the admin page
create view public.admin_risk_addresses with (security_invoker = true) as   -- one payout address used by several accounts
select to_address, count(distinct user_id) as accounts, sum(amount) as total
  from public.withdrawals where status <> 'rejected' group by to_address having count(distinct user_id) >= 2;
create view public.admin_risk_pairs with (security_invoker = true) as        -- the same two accounts meeting again and again
select a.user_id as user_a, b.user_id as user_b, count(*) as matches,
       count(*) filter (where m.winner_id = a.user_id) as wins_a, count(*) filter (where m.winner_id = b.user_id) as wins_b
  from public.matches m
  join public.match_players a on a.match_id = m.id
  join public.match_players b on b.match_id = m.id and a.user_id < b.user_id
 where m.status = 'finished' and m.max_players = 2
 group by a.user_id, b.user_id having count(*) >= 3;
revoke all on public.admin_risk_addresses, public.admin_risk_pairs from anon, authenticated;
grant select on public.admin_risk_addresses, public.admin_risk_pairs to service_role;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant execute on function public.is_in_match(uuid) to authenticated;
