-- Clears ALL test money, matches and balances. Run ONLY before launch.
-- Safety: it refuses to run if any deposit looks real (a deposit whose id does not start with "test-").
do $$ begin
  if exists (select 1 from public.deposits where tx_hash not like 'test-%') then
    raise exception 'Real deposits exist. Refusing to wipe anything.';
  end if;
end $$;
begin;
delete from public.matches;          -- also removes match_players
delete from public.withdrawals;
delete from public.deposits;
delete from public.ledger;
update public.wallets set available = 0, locked = 0, updated_at = now();
commit;
select count(*) as wallets_not_zero from public.wallets where available <> 0 or locked <> 0;   -- must be 0
