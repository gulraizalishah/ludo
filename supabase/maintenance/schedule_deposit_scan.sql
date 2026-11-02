-- AUTOMATIC deposits: once a minute the server looks at every deposit address, credits new deposits and moves them into the payout wallet.
-- Do this ONCE:
--   1) Supabase > Edge Functions > Secrets: add  CRON_SECRET  = a long random text (write it down, you need it below)
--   2) Replace the three placeholders below: YOUR_REF (the first part of your project address), YOUR_ANON_KEY (Project Settings > API, "anon public"),
--      and YOUR_CRON_SECRET (the same text as in step 1). Then run this whole script.
--   3) Open /admin.html: after a minute it should say "Automatic deposit collecting: running".
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('scan-deposits') where exists (select 1 from cron.job where jobname = 'scan-deposits');
select cron.schedule('scan-deposits', '* * * * *', $$
  select net.http_post(
    url := 'https://YOUR_REF.supabase.co/functions/v1/wallet',
    headers := '{"Content-Type":"application/json","apikey":"YOUR_ANON_KEY","Authorization":"Bearer YOUR_ANON_KEY","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
    body := '{"action":"scan_all"}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);

-- Check it (run these after a couple of minutes):
--   select jobname, schedule, active from cron.job;
--   select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
--   select status_code, content from net._http_response order by created desc limit 5;   -- 200 = good, 401 = wrong key or "Verify JWT" blocking, 403 = wrong CRON_SECRET
-- To stop it:  select cron.unschedule('scan-deposits');
