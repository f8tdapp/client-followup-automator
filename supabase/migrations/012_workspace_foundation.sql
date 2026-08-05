-- UNAPPLIED: multi-customer workspace foundation.
-- This migration intentionally gives workspace_id no default. Every future
-- service-role write must provide the workspace authorized for that request.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status text not null default 'free'
    check (status in ('free', 'trialing', 'active', 'past_due', 'suspended', 'cancelled')),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

comment on table public.workspace_members is
  'Server-resolved workspace authorization. Browser-supplied workspace IDs are never authoritative.';

insert into public.workspaces (id, name, slug, status)
values ('00000000-0000-4000-8000-000000000001', 'PipelineCue legacy account', 'legacy-first-customer', 'free')
on conflict (id) do nothing;

do $$
declare
  owned_table text;
begin
  foreach owned_table in array array[
    'clients', 'client_events', 'campaigns', 'email_templates', 'campaign_steps',
    'hubspot_connections', 'hubspot_contacts', 'contact_engagement_events',
    'daily_recommendations', 'contact_campaign_enrollments', 'daily_send_schedule',
    'broker_domain_limits', 'contact_suppression_rules', 'email_drafts', 'sending_settings'
  ] loop
    execute format('alter table public.%I add column workspace_id uuid', owned_table);
    execute format(
      'update public.%I set workspace_id = %L where workspace_id is null',
      owned_table, '00000000-0000-4000-8000-000000000001'
    );
    execute format('alter table public.%I alter column workspace_id set not null', owned_table);
    execute format(
      'alter table public.%I add constraint %I foreign key (workspace_id) references public.workspaces(id) on delete restrict',
      owned_table, owned_table || '_workspace_fk'
    );
    execute format('create index %I on public.%I(workspace_id)', owned_table || '_workspace_idx', owned_table);
    execute format('alter table public.%I add constraint %I unique (workspace_id, id)', owned_table, owned_table || '_workspace_id_key');
    execute format('alter table public.%I enable row level security', owned_table);
  end loop;
end $$;

-- Explicitly retain this statement even though the owned-table loop above also
-- enables RLS. It makes the clients security invariant visible to schema
-- auditors and is safely repeatable.
alter table public.clients enable row level security;

create index workspace_members_user_active_idx on public.workspace_members(user_id, status);
create index workspace_members_workspace_role_idx on public.workspace_members(workspace_id, role);

-- Replace global natural-key uniqueness with tenant-local uniqueness.
drop index if exists public.hubspot_connections_provider_key;
drop index if exists public.daily_recommendations_date_contact_key;
-- hubspot_contacts_hubspot_contact_id_key is owned by the original UNIQUE
-- constraint, so remove the constraint rather than trying to drop its index.
alter table public.hubspot_contacts drop constraint if exists hubspot_contacts_hubspot_contact_id_key;
alter table public.daily_recommendations drop constraint if exists daily_recommendations_recommendation_date_hubspot_contact_id_key;
alter table public.broker_domain_limits drop constraint if exists broker_domain_limits_broker_domain_key;

create unique index hubspot_connections_workspace_provider_key on public.hubspot_connections(workspace_id, provider);
create unique index hubspot_connections_workspace_portal_key on public.hubspot_connections(workspace_id, provider, portal_id) where portal_id is not null;
create unique index hubspot_contacts_workspace_contact_key on public.hubspot_contacts(workspace_id, hubspot_contact_id);
create unique index daily_recommendations_workspace_date_contact_key on public.daily_recommendations(workspace_id, recommendation_date, hubspot_contact_id);
create unique index broker_domain_limits_workspace_domain_key on public.broker_domain_limits(workspace_id, broker_domain);
create unique index sending_settings_workspace_provider_key on public.sending_settings(workspace_id, provider);

-- Drop the original single-column foreign keys before replacing them with
-- composite keys that make cross-workspace references impossible.
alter table public.client_events drop constraint if exists client_events_client_id_fkey;
alter table public.email_templates drop constraint if exists email_templates_campaign_id_fkey;
alter table public.campaign_steps drop constraint if exists campaign_steps_campaign_id_fkey;
alter table public.contact_engagement_events drop constraint if exists contact_engagement_events_hubspot_contact_id_fkey;
alter table public.daily_recommendations drop constraint if exists daily_recommendations_hubspot_contact_id_fkey;
alter table public.contact_campaign_enrollments drop constraint if exists contact_campaign_enrollments_contact_id_fkey;
alter table public.contact_campaign_enrollments drop constraint if exists contact_campaign_enrollments_campaign_id_fkey;
alter table public.daily_send_schedule drop constraint if exists daily_send_schedule_contact_id_fkey;
alter table public.daily_send_schedule drop constraint if exists daily_send_schedule_campaign_id_fkey;
alter table public.daily_send_schedule drop constraint if exists daily_send_schedule_campaign_step_id_fkey;
alter table public.contact_suppression_rules drop constraint if exists contact_suppression_rules_contact_id_fkey;
alter table public.email_drafts drop constraint if exists email_drafts_schedule_id_fkey;
alter table public.email_drafts drop constraint if exists email_drafts_campaign_id_fkey;
alter table public.email_drafts drop constraint if exists email_drafts_campaign_step_id_fkey;

alter table public.client_events add constraint client_events_workspace_client_fk foreign key (workspace_id, client_id) references public.clients(workspace_id, id) on delete cascade;
alter table public.email_templates add constraint email_templates_workspace_campaign_fk foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id) on delete cascade;
alter table public.campaign_steps add constraint campaign_steps_workspace_campaign_fk foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id) on delete cascade;
alter table public.contact_engagement_events add constraint engagement_events_workspace_contact_fk foreign key (workspace_id, hubspot_contact_id) references public.hubspot_contacts(workspace_id, hubspot_contact_id) on delete cascade;
alter table public.daily_recommendations add constraint recommendations_workspace_contact_fk foreign key (workspace_id, hubspot_contact_id) references public.hubspot_contacts(workspace_id, hubspot_contact_id) on delete cascade;
alter table public.contact_campaign_enrollments add constraint enrollments_workspace_contact_fk foreign key (workspace_id, contact_id) references public.hubspot_contacts(workspace_id, id) on delete cascade;
alter table public.contact_campaign_enrollments add constraint enrollments_workspace_campaign_fk foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id) on delete cascade;
alter table public.daily_send_schedule add constraint schedule_workspace_contact_fk foreign key (workspace_id, contact_id) references public.hubspot_contacts(workspace_id, id) on delete cascade;
alter table public.daily_send_schedule add constraint schedule_workspace_campaign_fk foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id) on delete cascade;
alter table public.daily_send_schedule add constraint schedule_workspace_step_fk foreign key (workspace_id, campaign_step_id) references public.campaign_steps(workspace_id, id) on delete cascade;
alter table public.contact_suppression_rules add constraint suppressions_workspace_contact_fk foreign key (workspace_id, contact_id) references public.hubspot_contacts(workspace_id, id) on delete cascade;
alter table public.email_drafts add constraint drafts_workspace_schedule_fk foreign key (workspace_id, schedule_id) references public.daily_send_schedule(workspace_id, id) on delete cascade;
alter table public.email_drafts add constraint drafts_workspace_campaign_fk foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id) on delete set null (campaign_id);
alter table public.email_drafts add constraint drafts_workspace_step_fk foreign key (workspace_id, campaign_step_id) references public.campaign_steps(workspace_id, id) on delete set null (campaign_step_id);

-- Membership and workspace metadata are server-only just like customer data.
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
revoke all privileges on table public.workspaces, public.workspace_members from public, anon, authenticated;
grant all privileges on table public.workspaces, public.workspace_members to service_role;

-- Existing browser roles remain unable to access any customer-owned table.
revoke all privileges on table
  public.clients, public.client_events, public.campaigns, public.email_templates,
  public.campaign_steps, public.hubspot_connections, public.hubspot_contacts,
  public.contact_engagement_events, public.daily_recommendations,
  public.contact_campaign_enrollments, public.daily_send_schedule,
  public.broker_domain_limits, public.contact_suppression_rules,
  public.email_drafts, public.sending_settings
from anon, authenticated;

-- PipelineCue accesses clients only through its server-side service-role client.
-- Remove broader legacy table grants before restoring the required CRUD surface.
revoke all privileges on table public.clients from service_role;
grant select, insert, update, delete on table public.clients to service_role;

notify pgrst, 'reload schema';
