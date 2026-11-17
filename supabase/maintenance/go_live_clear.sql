-- ============ CLEAN START FOR THE REAL TRON NETWORK ============
-- Run this AFTER you have added the new secrets (new HD_SEED, TRON_API, TRONGRID_API_KEY). It removes all test money, matches,
-- withdrawals and collecting records, sets every balance to 0, and removes the old deposit addresses so that new ones are made
-- from your NEW seed. Accounts, usernames and admin rights stay.

insert into public.app_settings (key, value) values ('testing_mode', 'true') on conflict (key) do nothing;
do $$ begin
  if coalesce((select value #>> '{}' from public.app_settings where key = 'testing_mode'), 'false') <> 'true' then
    raise exception 'Testing mode is off. Refusing to delete money records.';
  end if;
end $$;

begin;
delete from public.matches;                      -- also removes match_players
delete from public.withdrawals;
do $$ begin if to_regclass('public.sweeps') is not null then delete from public.sweeps; end if; end $$;
delete from public.deposits;
delete from public.ledger;
delete from public.deposit_addresses;            -- every player gets a fresh address from the new seed
update public.wallets set available = 0, locked = 0, updated_at = now();
delete from public.app_settings where key = 'last_scan_at' or key like 'alert\_%';
commit;

-- Check: all four must be 0.
select (select count(*) from public.wallets where available <> 0 or locked <> 0) as wallets_not_zero,
       (select count(*) from public.ledger) as ledger_rows,
       (select count(*) from public.deposit_addresses) as old_addresses,
       (select count(*) from public.matches) as matches;

-- ============ LATER, after your own tiny test works and BEFORE you invite anyone: lock the wipe script for good ============
-- update public.app_settings set value = 'false' where key = 'testing_mode';

-- ============ OPTIONAL: careful starting limits (amounts are in TRX) ============
-- update public.app_settings set value = '100' where key = 'auto_withdraw_max';          -- bigger payouts wait for your approval
-- update public.app_settings set value = '300' where key = 'auto_withdraw_daily_max';
-- update public.app_settings set value = 'true' where key = 'first_withdrawal_manual';   -- you approve each account's first withdrawal
-- update public.app_settings set value = '3'  where key = 'withdraw_min_matches';        -- matches to finish before withdrawing
-- update public.app_settings set value = '1'  where key = 'withdraw_wager_ratio';        -- every deposit must be played through once
-- update public.app_settings set value = '24' where key = 'withdraw_min_age_hours';      -- NOTE: also delays YOUR first withdrawal test by a day: leave at 0 until you have tested
