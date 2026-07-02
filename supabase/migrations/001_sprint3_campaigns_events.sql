create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status text not null default 'draft',
  daily_limit integer not null default 10,
  cooldown_days integer not null default 30,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns(id) on delete cascade,
  name text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  event_type text not null,
  details text,
  created_at timestamptz not null default now()
);

alter table public.campaigns enable row level security;
alter table public.email_templates enable row level security;
alter table public.client_events enable row level security;

grant select, insert, update, delete on public.campaigns to anon;
grant select, insert, update, delete on public.email_templates to anon;
grant select, insert, update, delete on public.client_events to anon;

drop policy if exists "Development anon full access campaigns" on public.campaigns;
create policy "Development anon full access campaigns"
on public.campaigns
for all
to anon
using (true)
with check (true);

drop policy if exists "Development anon full access email templates" on public.email_templates;
create policy "Development anon full access email templates"
on public.email_templates
for all
to anon
using (true)
with check (true);

drop policy if exists "Development anon full access client events" on public.client_events;
create policy "Development anon full access client events"
on public.client_events
for all
to anon
using (true)
with check (true);
