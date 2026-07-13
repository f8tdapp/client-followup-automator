create table if not exists public.sending_settings (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'resend',
  sending_domain text not null default 'listingmediact.com',
  from_name text not null default 'TJ Muldoon',
  from_email text not null default 'tj@listingmediact.com',
  reply_to_email text not null default 'tj@listingmediact.com',
  daily_send_limit integer not null default 25,
  sending_enabled boolean not null default false,
  test_mode_only boolean not null default true,
  domain_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sending_settings_provider_idx
on public.sending_settings(provider);

create index if not exists sending_settings_domain_idx
on public.sending_settings(sending_domain);

alter table public.sending_settings enable row level security;

grant all privileges on table public.sending_settings to service_role;
grant select on table public.sending_settings to anon, authenticated;

drop policy if exists "Service role manage sending settings" on public.sending_settings;
create policy "Service role manage sending settings"
on public.sending_settings
for all
to service_role
using (true)
with check (true);

drop policy if exists "Development anon read sending settings" on public.sending_settings;
create policy "Development anon read sending settings"
on public.sending_settings
for select
to anon
using (true);

drop policy if exists "Development authenticated read sending settings" on public.sending_settings;
create policy "Development authenticated read sending settings"
on public.sending_settings
for select
to authenticated
using (true);

notify pgrst, 'reload schema';
