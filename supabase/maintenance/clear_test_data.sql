-- CLEAN SLATE FOR TESTING. Removes all test money, matches, withdrawals and collected-deposit records, and sets every balance to 0.
-- Keeps: accounts, usernames, admin rights, and every player's deposit address.
-- Real coins already sent to deposit addresses on the test network are credited AGAIN the next time a player presses
-- "check now" (the system reads the blockchain), so the fake "test-" credits disappear and real test deposits come back.
--
-- SAFETY: it refuses to run once testing mode is off. Before launch run:  update app_settings set value = 'false' where key = 'testing_mode';
insert into public.app_settings (key, value) values ('testing_mode', 'true') on conflict (key) do nothing;
do $$ begin
  if coalesce((select value #>> '{}' from public.app_settings where key = 'testing_mode'), 'false') <> 'true' then
    raise exception 'Testing mode is off. Refusing to delete money records.';
  end if;
end $$;

begin;
delete from public.matches;                 -- also removes match_players
delete from public.withdrawals;
do $$ begin if to_regclass('public.sweeps') is not null then delete from public.sweeps; end if; end $$;
delete from public.deposits;
delete from public.ledger;
update public.wallets set available = 0, locked = 0, updated_at = now();
commit;

-- Check: all three must be 0.
select (select count(*) from public.wallets where available <> 0 or locked <> 0) as wallets_not_zero,
       (select count(*) from public.ledger) as ledger_rows,
       (select count(*) from public.matches) as matches;
