-- Step 4f: choose the game currency in the app_settings table. 'TRX' = the coin itself (no top-ups needed to collect deposits),
-- 'USDT' = the dollar token. Numbers below are in that currency (1 TRX is about 0.33 USDT when this was written).
-- To go back:  update app_settings set value = '"USDT"' where key = 'asset';  (and set the amounts back to dollar-sized numbers)
insert into public.app_settings (key, value) values
  ('asset', '"TRX"'),
  ('stake_options', '[10,25,50,100]'),      -- the stake buttons players see
  ('min_stake', '5'), ('max_stake', '1000'),
  ('min_deposit', '10'),                    -- smaller transfers are ignored (dust / spam)
  ('min_withdrawal', '20'),
  ('auto_withdraw_max', '1500'),            -- paid out automatically up to this much per request
  ('auto_withdraw_daily_max', '6000'),
  ('sweep_min', '5')                        -- do not bother collecting less than this
on conflict (key) do update set value = excluded.value;
