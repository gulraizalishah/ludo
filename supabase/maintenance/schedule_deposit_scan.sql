-- Checks every player's deposit address once a minute. Run once, AFTER:
--   1) Database > Extensions: enable "pg_cron" and "pg_net"
--   2) deploying the wallet function and setting the CRON_SECRET secret
-- Replace YOUR_REF and YOUR_CRON_SECRET (the same value as the secret) before running.
select cron.schedule('scan-deposits', '* * * * *', $$
  select net.http_post(
    url := 'https://YOUR_REF.supabase.co/functions/v1/wallet',
    headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
    body := '{"action":"scan_all"}'::jsonb
  );
$$);
-- To stop it later:  select cron.unschedule('scan-deposits');
