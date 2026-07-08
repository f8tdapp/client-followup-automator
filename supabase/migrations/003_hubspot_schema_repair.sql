create extension if not exists pgcrypto;

create table if not exists public.hubspot_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'hubspot',
  portal_id text,
  status text not null default 'not_connected',
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.hubspot_connections
  add column if not exists provider text not null default 'hubspot',
  add column if not exists portal_id text,
  add column if not exists status text not null default 'not_connected',
  add column if not exists access_token text,
  add column if not exists refresh_token text,
  add column if not exists token_expires_at timestamptz,
  add column if not exists scopes text[] not null default '{}',
  add column if not exists last_sync_at timestamptz,
  add column if not exists last_error text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

comment on column public.hubspot_connections.access_token is
  'Development storage only. TODO: encrypt tokens before production use.';
comment on column public.hubspot_connections.refresh_token is
  'Development storage only. TODO: encrypt tokens before production use.';

create unique index if not exists hubspot_connections_provider_key
on public.hubspot_connections(provider);

create index if not exists hubspot_connections_status_idx
on public.hubspot_connections(status);

create table if not exists public.hubspot_contacts (
  id uuid primary key default gen_random_uuid(),
  hubspot_contact_id text not null unique,
  email text,
  first_name text,
  last_name text,
  company text,
  phone text,
  lifecycle_stage text,
  is_unsubscribed boolean not null default false,
  last_contacted_at timestamptz,
  last_engaged_at timestamptz,
  raw_properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.hubspot_contacts
  add column if not exists hubspot_contact_id text,
  add column if not exists email text,
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists company text,
  add column if not exists phone text,
  add column if not exists lifecycle_stage text,
  add column if not exists is_unsubscribed boolean not null default false,
  add column if not exists last_contacted_at timestamptz,
  add column if not exists last_engaged_at timestamptz,
  add column if not exists raw_properties jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists hubspot_contacts_hubspot_contact_id_key
on public.hubspot_contacts(hubspot_contact_id);

create index if not exists hubspot_contacts_email_idx
on public.hubspot_contacts(email);

create index if not exists hubspot_contacts_company_idx
on public.hubspot_contacts(company);

create index if not exists hubspot_contacts_last_contacted_idx
on public.hubspot_contacts(last_contacted_at desc);

create index if not exists hubspot_contacts_last_engaged_idx
on public.hubspot_contacts(last_engaged_at desc);

create index if not exists hubspot_contacts_unsubscribed_idx
on public.hubspot_contacts(is_unsubscribed);

create table if not exists public.contact_engagement_events (
  id uuid primary key default gen_random_uuid(),
  hubspot_contact_id text not null references public.hubspot_contacts(hubspot_contact_id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.contact_engagement_events
  add column if not exists hubspot_contact_id text,
  add column if not exists event_type text,
  add column if not exists occurred_at timestamptz,
  add column if not exists details jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

create index if not exists contact_engagement_events_contact_occurred_idx
on public.contact_engagement_events(hubspot_contact_id, occurred_at desc);

create index if not exists contact_engagement_events_type_occurred_idx
on public.contact_engagement_events(event_type, occurred_at desc);

create table if not exists public.daily_recommendations (
  id uuid primary key default gen_random_uuid(),
  recommendation_date date not null default current_date,
  hubspot_contact_id text not null references public.hubspot_contacts(hubspot_contact_id) on delete cascade,
  recommended_action text not null default 'Follow up',
  reason text not null,
  status text not null default 'pending',
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (recommendation_date, hubspot_contact_id)
);

alter table public.daily_recommendations
  add column if not exists recommendation_date date not null default current_date,
  add column if not exists hubspot_contact_id text,
  add column if not exists recommended_action text not null default 'Follow up',
  add column if not exists reason text,
  add column if not exists status text not null default 'pending',
  add column if not exists priority integer not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists daily_recommendations_date_contact_key
on public.daily_recommendations(recommendation_date, hubspot_contact_id);

create index if not exists daily_recommendations_date_priority_idx
on public.daily_recommendations(recommendation_date, priority desc);

create index if not exists daily_recommendations_status_idx
on public.daily_recommendations(status);

alter table public.hubspot_connections enable row level security;
alter table public.hubspot_contacts enable row level security;
alter table public.contact_engagement_events enable row level security;
alter table public.daily_recommendations enable row level security;

grant select, insert, update, delete on public.hubspot_connections to anon;
grant select, insert, update, delete on public.hubspot_contacts to anon;
grant select, insert, update, delete on public.contact_engagement_events to anon;
grant select, insert, update, delete on public.daily_recommendations to anon;

grant select, insert, update, delete on public.hubspot_connections to authenticated;
grant select, insert, update, delete on public.hubspot_contacts to authenticated;
grant select, insert, update, delete on public.contact_engagement_events to authenticated;
grant select, insert, update, delete on public.daily_recommendations to authenticated;

drop policy if exists "Development anon full access hubspot connections" on public.hubspot_connections;
create policy "Development anon full access hubspot connections"
on public.hubspot_connections
for all
to anon
using (true)
with check (true);

drop policy if exists "Development anon full access hubspot contacts" on public.hubspot_contacts;
create policy "Development anon full access hubspot contacts"
on public.hubspot_contacts
for all
to anon
using (true)
with check (true);

drop policy if exists "Development anon full access engagement events" on public.contact_engagement_events;
create policy "Development anon full access engagement events"
on public.contact_engagement_events
for all
to anon
using (true)
with check (true);

drop policy if exists "Development anon full access daily recommendations" on public.daily_recommendations;
create policy "Development anon full access daily recommendations"
on public.daily_recommendations
for all
to anon
using (true)
with check (true);

drop policy if exists "Development authenticated full access hubspot connections" on public.hubspot_connections;
create policy "Development authenticated full access hubspot connections"
on public.hubspot_connections
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Development authenticated full access hubspot contacts" on public.hubspot_contacts;
create policy "Development authenticated full access hubspot contacts"
on public.hubspot_contacts
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Development authenticated full access engagement events" on public.contact_engagement_events;
create policy "Development authenticated full access engagement events"
on public.contact_engagement_events
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Development authenticated full access daily recommendations" on public.daily_recommendations;
create policy "Development authenticated full access daily recommendations"
on public.daily_recommendations
for all
to authenticated
using (true)
with check (true);

notify pgrst, 'reload schema';
