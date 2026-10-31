-- Every withdrawal that is not paid automatically records WHY (shown on the admin page).
alter table public.withdrawals add column if not exists note text;
