-- UNAPPLIED: workspace runtime uniqueness and OAuth nonce enforcement.

-- Remove constraint-owned global indexes through their constraints, then add
-- workspace-scoped unique indexes usable as PostgREST onConflict targets.
alter table public.campaign_steps
  drop constraint if exists campaign_steps_campaign_id_step_number_key;
alter table public.daily_send_schedule
  drop constraint if exists daily_send_schedule_contact_id_campaign_id_campaign_step_id_scheduled_date_key;
alter table public.email_drafts
  drop constraint if exists email_drafts_schedule_id_key;
alter table public.contact_campaign_enrollments
  drop constraint if exists contact_campaign_enrollments_contact_id_campaign_id_key;

create unique index if not exists campaign_steps_workspace_campaign_step_key
  on public.campaign_steps(workspace_id, campaign_id, step_number);
create unique index if not exists daily_send_schedule_workspace_delivery_key
  on public.daily_send_schedule(workspace_id, contact_id, campaign_id, campaign_step_id, scheduled_date);
create unique index if not exists email_drafts_workspace_schedule_key
  on public.email_drafts(workspace_id, schedule_id);
create unique index if not exists enrollments_workspace_contact_campaign_key
  on public.contact_campaign_enrollments(workspace_id, contact_id, campaign_id);

-- Recreate the sole recommendation/contact relationship with an explicit name
-- so PostgREST cannot select a legacy global relationship.
alter table public.daily_recommendations
  drop constraint if exists recommendations_workspace_contact_fk;
alter table public.daily_recommendations
  add constraint recommendations_workspace_contact_fk
  foreign key (workspace_id, hubspot_contact_id)
  references public.hubspot_contacts(workspace_id, hubspot_contact_id)
  on delete cascade;

create table if not exists public.hubspot_oauth_nonces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nonce_digest bytea not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint hubspot_oauth_nonces_digest_length check (octet_length(nonce_digest) = 32),
  constraint hubspot_oauth_nonces_expiry_after_creation check (expires_at > created_at)
);

create unique index if not exists hubspot_oauth_nonces_digest_key
  on public.hubspot_oauth_nonces(nonce_digest);
create index if not exists hubspot_oauth_nonces_lookup_idx
  on public.hubspot_oauth_nonces(workspace_id, user_id, nonce_digest);
create index if not exists hubspot_oauth_nonces_expiry_idx
  on public.hubspot_oauth_nonces(expires_at) where consumed_at is null;

alter table public.hubspot_oauth_nonces enable row level security;
revoke all privileges on table public.hubspot_oauth_nonces from public, anon, authenticated;
grant all privileges on table public.hubspot_oauth_nonces to service_role;

create or replace function public.consume_hubspot_oauth_nonce(
  requested_workspace_id uuid,
  requested_user_id uuid,
  requested_nonce_digest bytea
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  consumed_id uuid;
  effective_time timestamptz := pg_catalog.clock_timestamp();
begin
  if requested_workspace_id is null
    or requested_user_id is null
    or requested_nonce_digest is null
    or pg_catalog.octet_length(requested_nonce_digest) <> 32 then
    return false;
  end if;

  update public.hubspot_oauth_nonces
  set consumed_at = effective_time
  where workspace_id = requested_workspace_id
    and user_id = requested_user_id
    and nonce_digest = requested_nonce_digest
    and consumed_at is null
    and expires_at > effective_time
  returning id into consumed_id;

  return consumed_id is not null;
end;
$$;

alter function public.consume_hubspot_oauth_nonce(uuid, uuid, bytea)
  owner to postgres;
revoke all on function public.consume_hubspot_oauth_nonce(uuid, uuid, bytea)
  from public, anon, authenticated;
grant execute on function public.consume_hubspot_oauth_nonce(uuid, uuid, bytea)
  to service_role;

notify pgrst, 'reload schema';
