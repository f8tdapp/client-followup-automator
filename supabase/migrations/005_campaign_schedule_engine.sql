alter table public.campaigns
  add column if not exists daily_send_limit integer not null default 10,
  add column if not exists broker_domain_daily_limit integer not null default 3,
  add column if not exists stop_on_reply boolean not null default true,
  add column if not exists stop_on_bounce boolean not null default true,
  add column if not exists stop_on_unsubscribe boolean not null default true;

update public.campaigns
set daily_send_limit = daily_limit
where daily_send_limit is null;

create table if not exists public.campaign_steps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  step_number integer not null check (step_number between 1 and 3),
  delay_days integer not null default 0,
  subject_template text not null default '',
  body_template text not null default '',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, step_number)
);

create table if not exists public.contact_campaign_enrollments (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.hubspot_contacts(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  current_step integer not null default 1 check (current_step between 1 and 4),
  status text not null default 'active',
  next_send_date date not null default current_date,
  last_sent_at timestamptz,
  completed_at timestamptz,
  stopped_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id, campaign_id)
);

create table if not exists public.daily_send_schedule (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.hubspot_contacts(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  campaign_step_id uuid not null references public.campaign_steps(id) on delete cascade,
  scheduled_date date not null default current_date,
  broker_domain text not null,
  status text not null default 'scheduled',
  reason text not null,
  safety_status text not null default 'safe',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id, campaign_id, campaign_step_id, scheduled_date)
);

create table if not exists public.broker_domain_limits (
  id uuid primary key default gen_random_uuid(),
  broker_domain text not null unique,
  daily_limit integer not null default 3,
  status text not null default 'active',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.contact_suppression_rules (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.hubspot_contacts(id) on delete cascade,
  suppression_type text not null,
  reason text,
  source text not null default 'manual',
  active boolean not null default true,
  snoozed_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaign_steps_campaign_step_idx
on public.campaign_steps(campaign_id, step_number);

create index if not exists contact_campaign_enrollments_due_idx
on public.contact_campaign_enrollments(status, next_send_date, current_step);

create index if not exists contact_campaign_enrollments_contact_idx
on public.contact_campaign_enrollments(contact_id);

create index if not exists daily_send_schedule_date_status_idx
on public.daily_send_schedule(scheduled_date, status);

create index if not exists daily_send_schedule_domain_date_idx
on public.daily_send_schedule(broker_domain, scheduled_date);

create index if not exists daily_send_schedule_step_date_idx
on public.daily_send_schedule(campaign_step_id, scheduled_date);

create index if not exists broker_domain_limits_domain_idx
on public.broker_domain_limits(broker_domain);

create index if not exists contact_suppression_rules_contact_active_idx
on public.contact_suppression_rules(contact_id, active);

create index if not exists contact_suppression_rules_type_idx
on public.contact_suppression_rules(suppression_type);

alter table public.campaign_steps enable row level security;
alter table public.contact_campaign_enrollments enable row level security;
alter table public.daily_send_schedule enable row level security;
alter table public.broker_domain_limits enable row level security;
alter table public.contact_suppression_rules enable row level security;

grant all privileges on table public.campaigns to service_role;
grant all privileges on table public.campaign_steps to service_role;
grant all privileges on table public.contact_campaign_enrollments to service_role;
grant all privileges on table public.daily_send_schedule to service_role;
grant all privileges on table public.broker_domain_limits to service_role;
grant all privileges on table public.contact_suppression_rules to service_role;

grant select, insert, update, delete on table public.campaigns to anon, authenticated;
grant select, insert, update, delete on table public.campaign_steps to anon, authenticated;
grant select on table public.contact_campaign_enrollments to anon, authenticated;
grant select on table public.daily_send_schedule to anon, authenticated;
grant select on table public.broker_domain_limits to anon, authenticated;
grant select on table public.contact_suppression_rules to anon, authenticated;

drop policy if exists "Development anon full access campaign steps" on public.campaign_steps;
create policy "Development anon full access campaign steps"
on public.campaign_steps
for all
to anon
using (true)
with check (true);

drop policy if exists "Development authenticated full access campaign steps" on public.campaign_steps;
create policy "Development authenticated full access campaign steps"
on public.campaign_steps
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Development anon read enrollments" on public.contact_campaign_enrollments;
create policy "Development anon read enrollments"
on public.contact_campaign_enrollments
for select
to anon
using (true);

drop policy if exists "Development authenticated read enrollments" on public.contact_campaign_enrollments;
create policy "Development authenticated read enrollments"
on public.contact_campaign_enrollments
for select
to authenticated
using (true);

drop policy if exists "Development anon read daily send schedule" on public.daily_send_schedule;
create policy "Development anon read daily send schedule"
on public.daily_send_schedule
for select
to anon
using (true);

drop policy if exists "Development authenticated read daily send schedule" on public.daily_send_schedule;
create policy "Development authenticated read daily send schedule"
on public.daily_send_schedule
for select
to authenticated
using (true);

drop policy if exists "Development anon read broker domain limits" on public.broker_domain_limits;
create policy "Development anon read broker domain limits"
on public.broker_domain_limits
for select
to anon
using (true);

drop policy if exists "Development authenticated read broker domain limits" on public.broker_domain_limits;
create policy "Development authenticated read broker domain limits"
on public.broker_domain_limits
for select
to authenticated
using (true);

drop policy if exists "Development anon read suppression rules" on public.contact_suppression_rules;
create policy "Development anon read suppression rules"
on public.contact_suppression_rules
for select
to anon
using (true);

drop policy if exists "Development authenticated read suppression rules" on public.contact_suppression_rules;
create policy "Development authenticated read suppression rules"
on public.contact_suppression_rules
for select
to authenticated
using (true);

notify pgrst, 'reload schema';
