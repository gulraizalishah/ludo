-- Step 4e: collecting deposits. Every move of coins between OUR OWN addresses is recorded here
-- (TRX top-ups for fees, USDT sweeps into the payout wallet). Server-only: no policies, nothing for browsers.
create table public.sweeps (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles,
  address text not null,
  kind text not null check (kind in ('topup', 'sweep', 'check')),          -- check = looked, nothing to collect
  status text not null check (status in ('sent', 'confirmed', 'failed', 'empty')),
  amount numeric(18, 6) not null default 0,
  tx_hash text,
  note text,
  created_at timestamptz not null default now()
);
create index on public.sweeps (address, created_at desc);
alter table public.sweeps enable row level security;
revoke all on public.sweeps from anon, authenticated;

-- Addresses that received a (credited) deposit after their last collection.
create function public.sweep_candidates(p_limit int default 20)
returns table (user_id uuid, address text, derivation_index bigint)
language sql stable security definer set search_path = public as $$
  select a.user_id, a.address, a.derivation_index
    from deposit_addresses a
   where a.address not like 'pending-%'
     and exists (select 1 from deposits d
                  where d.user_id = a.user_id
                    and d.created_at > coalesce((select max(s.created_at) from sweeps s
                                                  where s.address = a.address and s.kind in ('sweep', 'check')
                                                    and s.status in ('sent', 'confirmed', 'empty')), '-infinity'::timestamptz))
   order by a.derivation_index
   limit p_limit;
$$;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant execute on function public.is_in_match(uuid) to authenticated;
grant all on public.sweeps to service_role;
