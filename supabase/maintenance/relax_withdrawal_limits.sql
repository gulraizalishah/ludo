-- TEMPORARY: relax the withdrawal limits for testing, then put them back exactly as they were.
-- Run the three parts one at a time. Part 1 saves your current values, part 2 relaxes, part 3 restores.

-- ===== PART 1: save the current values (a second run never overwrites the first save) and show them =====
insert into public.app_settings (key, value)
select 'backup_' || key, value from public.app_settings
 where key in ('min_withdrawal', 'withdraw_min_age_hours', 'withdraw_min_matches', 'withdraw_wager_ratio', 'first_withdrawal_manual')
on conflict (key) do nothing;
select key, value from public.app_settings where key like 'backup\_%' order by key;

-- ===== PART 2: relax for testing =====
update public.app_settings set value = '1'     where key = 'min_withdrawal';
update public.app_settings set value = '0'     where key in ('withdraw_min_age_hours', 'withdraw_min_matches', 'withdraw_wager_ratio');
update public.app_settings set value = 'false' where key = 'first_withdrawal_manual';

-- ===== PART 3: put everything back as it was, then remove the saved copies =====
-- update public.app_settings s set value = b.value from public.app_settings b where b.key = 'backup_' || s.key;
-- delete from public.app_settings where key like 'backup\_%';
-- select key, value from public.app_settings where key in ('min_withdrawal','withdraw_min_age_hours','withdraw_min_matches','withdraw_wager_ratio','first_withdrawal_manual') order by key;
