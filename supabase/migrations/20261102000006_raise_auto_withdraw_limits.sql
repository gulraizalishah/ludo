-- Withdrawals up to 500 USDT per request are now paid out automatically (no admin needed).
-- Change these numbers any time in the app_settings table.
update public.app_settings set value = '500'  where key = 'auto_withdraw_max';
update public.app_settings set value = '2000' where key = 'auto_withdraw_daily_max';
