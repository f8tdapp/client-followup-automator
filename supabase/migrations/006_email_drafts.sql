create table if not exists public.email_drafts (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.daily_send_schedule(id) on delete cascade,
  hubspot_contact_id text,
  contact_email text not null,
  contact_first_name text,
  contact_last_name text,
  contact_company text,
  campaign_id uuid references public.campaigns(id) on delete set null,
  campaign_step_id uuid references public.campaign_steps(id) on delete set null,
  step_number integer,
  subject text not null,
  body text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'skipped')),
  approved_at timestamptz,
  skipped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (schedule_id)
);

create index if not exists email_drafts_schedule_idx
on public.email_drafts(schedule_id);

create index if not exists email_drafts_campaign_idx
on public.email_drafts(campaign_id);

create index if not exists email_drafts_campaign_step_idx
on public.email_drafts(campaign_step_id);

create index if not exists email_drafts_status_idx
on public.email_drafts(status);

create index if not exists email_drafts_created_at_idx
on public.email_drafts(created_at);

alter table public.email_drafts enable row level security;

grant all privileges on table public.email_drafts to service_role;
grant select on table public.email_drafts to anon, authenticated;

drop policy if exists "Development anon read email drafts" on public.email_drafts;
create policy "Development anon read email drafts"
on public.email_drafts
for select
to anon
using (true);

drop policy if exists "Development authenticated read email drafts" on public.email_drafts;
create policy "Development authenticated read email drafts"
on public.email_drafts
for select
to authenticated
using (true);

notify pgrst, 'reload schema';
