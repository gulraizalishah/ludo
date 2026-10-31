-- Step 4c: one-glance money overview for the admin page (service role only).
-- "unaccounted" must always be 0: every deposited USDT is either in a player wallet, locked in a match,
-- earned as platform fee, waiting in a pending withdrawal, or already paid out.
create view public.admin_overview with (security_invoker = true) as
select
  (select coalesce(sum(amount), 0) from public.deposits)                                   as deposits_total,
  (select coalesce(sum(d_available), 0) from public.ledger where user_id is null)         as platform_fees,
  (select coalesce(sum(available), 0) from public.wallets)                                as players_available,
  (select coalesce(sum(locked), 0) from public.wallets)                                   as players_locked,
  (select count(*) from public.withdrawals where status = 'pending')                      as pending_count,
  (select coalesce(sum(amount), 0) from public.withdrawals where status = 'pending')      as pending_amount,
  (select coalesce(sum(amount), 0) from public.withdrawals where status = 'sent')         as paid_out_total,
  (select count(*) from public.matches where status = 'active')                           as active_matches,
  (select count(*) from public.ledger_mismatches)                                         as wallet_mismatches,
  (select coalesce(sum(amount), 0) from public.deposits)
    - (select coalesce(sum(available), 0) from public.wallets)
    - (select coalesce(sum(locked), 0) from public.wallets)
    - (select coalesce(sum(d_available), 0) from public.ledger where user_id is null)
    - (select coalesce(sum(amount), 0) from public.withdrawals where status in ('pending', 'sent')) as unaccounted;
revoke all on public.admin_overview from anon, authenticated;
grant select on public.admin_overview to service_role;
