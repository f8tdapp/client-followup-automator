alter table public.campaigns
  add column if not exists new_enrollments_paused boolean not null default false;

update public.campaigns
set new_enrollments_paused = false
where new_enrollments_paused is null;

create or replace function public.enroll_eligible_campaign_contacts(
  requested_campaign_id uuid,
  confirmed_eligible_count integer,
  enrollment_date date default current_date
)
returns table (
  result text,
  message text,
  eligible_count integer,
  inserted_count integer
)
language plpgsql
security definer
-- No caller-controlled object may be resolved by this SECURITY DEFINER function.
set search_path = pg_catalog, pg_temp
as $$
declare
  -- Deliberate guardrail against accidental or unreasonable bulk enrolment.
  maximum_confirmed_eligible_count constant integer := 10000;
  campaign_paused boolean;
  calculated_eligible_count integer;
  calculated_inserted_count integer;
begin
  if requested_campaign_id is null then
    raise exception 'Campaign ID must not be null.';
  end if;

  if confirmed_eligible_count is null then
    raise exception 'Confirmed eligible count must not be null.';
  end if;

  if enrollment_date is null then
    raise exception 'Enrollment date must not be null.';
  end if;

  if confirmed_eligible_count < 0 then
    raise exception 'Confirmed eligible count must not be negative.';
  end if;

  if confirmed_eligible_count > maximum_confirmed_eligible_count then
    raise exception 'Confirmed eligible count exceeds the maximum of %.',
      maximum_confirmed_eligible_count;
  end if;

  select campaigns.new_enrollments_paused
  into campaign_paused
  from public.campaigns as campaigns
  where campaigns.id = requested_campaign_id
    and campaigns.status = 'active'
  for update;

  if not found then
    raise exception 'Active campaign % was not found.', requested_campaign_id;
  end if;

  if campaign_paused then
    return query
    select
      'paused'::text,
      'New enrolments are paused for this campaign.'::text,
      0,
      0;
    return;
  end if;

  create temporary table pg_temp.eligible_campaign_contacts
  on commit drop
  as
  select contacts.id as contact_id
  from public.hubspot_contacts contacts
  where contacts.email is not null
    and pg_catalog.btrim(contacts.email) <> ''
    and contacts.is_unsubscribed = false
    and not exists (
      select 1
      from public.contact_suppression_rules suppression
      where suppression.contact_id = contacts.id
        and suppression.active = true
        and (
          pg_catalog.lower(pg_catalog.btrim(suppression.suppression_type)) <> 'snoozed'
          or suppression.snoozed_until is null
          or suppression.snoozed_until >= enrollment_date
        )
    )
    and not exists (
      select 1
      from public.contact_campaign_enrollments enrollment
      where enrollment.contact_id = contacts.id
        and enrollment.campaign_id = requested_campaign_id
    )
  order by contacts.id;

  select count(*)::integer
  into calculated_eligible_count
  from pg_temp.eligible_campaign_contacts;

  if calculated_eligible_count <> confirmed_eligible_count then
    return query
    select
      'stale_count'::text,
      pg_catalog.format(
        'Eligible contact count changed from %s to %s.',
        confirmed_eligible_count,
        calculated_eligible_count
      ),
      calculated_eligible_count,
      0;
    return;
  end if;

  if calculated_eligible_count = 0 then
    return query
    select
      'no_eligible_contacts'::text,
      'No eligible contacts are available to enrol.'::text,
      0,
      0;
    return;
  end if;

  insert into public.contact_campaign_enrollments (
    contact_id,
    campaign_id,
    current_step,
    current_step_number,
    status,
    next_send_date,
    next_step_due_at,
    updated_at
  )
  select
    eligible.contact_id,
    requested_campaign_id,
    1,
    1,
    'active',
    enrollment_date,
    enrollment_date,
    pg_catalog.now()
  from pg_temp.eligible_campaign_contacts eligible
  on conflict (contact_id, campaign_id) do nothing;

  get diagnostics calculated_inserted_count = row_count;

  if calculated_inserted_count <> calculated_eligible_count then
    raise exception
      'Concurrent enrolment changed the eligible set; no contacts were enrolled.';
  end if;

  return query
  select
    'success'::text,
    pg_catalog.format('%s eligible contacts enrolled.', calculated_inserted_count),
    calculated_eligible_count,
    calculated_inserted_count;
end;
$$;

alter function public.enroll_eligible_campaign_contacts(uuid, integer, date)
owner to postgres;

-- PipelineCue is a single-account application. All application data access now
-- crosses the owner-authorized Next.js server boundary; browser roles have no
-- direct table privileges. This is not a multi-tenant ownership policy.
alter table public.clients enable row level security;

revoke usage on schema public from anon, authenticated;
grant usage on schema public to service_role;

revoke all privileges on all sequences in schema public from anon, authenticated;
grant all privileges on all sequences in schema public to service_role;

revoke all privileges on table
  public.clients,
  public.client_events,
  public.campaigns,
  public.email_templates,
  public.campaign_steps,
  public.hubspot_connections,
  public.hubspot_contacts,
  public.contact_engagement_events,
  public.daily_recommendations,
  public.contact_campaign_enrollments,
  public.daily_send_schedule,
  public.broker_domain_limits,
  public.contact_suppression_rules,
  public.email_drafts,
  public.sending_settings
from anon, authenticated;

grant all privileges on table
  public.clients,
  public.client_events,
  public.campaigns,
  public.email_templates,
  public.campaign_steps,
  public.hubspot_connections,
  public.hubspot_contacts,
  public.contact_engagement_events,
  public.daily_recommendations,
  public.contact_campaign_enrollments,
  public.daily_send_schedule,
  public.broker_domain_limits,
  public.contact_suppression_rules,
  public.email_drafts,
  public.sending_settings
to service_role;

drop policy if exists "Allow all access for now" on public.clients;
drop policy if exists "Development anon full access campaigns" on public.campaigns;
drop policy if exists "Development authenticated full access campaigns" on public.campaigns;
drop policy if exists "PipelineCue anon read campaigns" on public.campaigns;
drop policy if exists "PipelineCue authenticated read campaigns" on public.campaigns;
drop policy if exists "Development anon full access email templates" on public.email_templates;
drop policy if exists "Development authenticated full access email templates" on public.email_templates;
drop policy if exists "Development anon full access client events" on public.client_events;
drop policy if exists "Development authenticated full access client events" on public.client_events;
drop policy if exists "Development anon full access campaign steps" on public.campaign_steps;
drop policy if exists "Development authenticated full access campaign steps" on public.campaign_steps;
drop policy if exists "Development anon full access hubspot connections" on public.hubspot_connections;
drop policy if exists "Development authenticated full access hubspot connections" on public.hubspot_connections;
drop policy if exists "Development anon full access hubspot contacts" on public.hubspot_contacts;
drop policy if exists "Development authenticated full access hubspot contacts" on public.hubspot_contacts;
drop policy if exists "Development anon read hubspot contacts" on public.hubspot_contacts;
drop policy if exists "Development authenticated read hubspot contacts" on public.hubspot_contacts;
drop policy if exists "Development anon full access engagement events" on public.contact_engagement_events;
drop policy if exists "Development authenticated full access engagement events" on public.contact_engagement_events;
drop policy if exists "Development anon read engagement events" on public.contact_engagement_events;
drop policy if exists "Development authenticated read engagement events" on public.contact_engagement_events;
drop policy if exists "Development anon full access daily recommendations" on public.daily_recommendations;
drop policy if exists "Development authenticated full access daily recommendations" on public.daily_recommendations;
drop policy if exists "Development anon read daily recommendations" on public.daily_recommendations;
drop policy if exists "Development authenticated read daily recommendations" on public.daily_recommendations;
drop policy if exists "Development anon read enrollments" on public.contact_campaign_enrollments;
drop policy if exists "Development authenticated read enrollments" on public.contact_campaign_enrollments;
drop policy if exists "Development anon read daily send schedule" on public.daily_send_schedule;
drop policy if exists "Development authenticated read daily send schedule" on public.daily_send_schedule;
drop policy if exists "Development anon read broker domain limits" on public.broker_domain_limits;
drop policy if exists "Development authenticated read broker domain limits" on public.broker_domain_limits;
drop policy if exists "Development anon read suppression rules" on public.contact_suppression_rules;
drop policy if exists "Development authenticated read suppression rules" on public.contact_suppression_rules;
drop policy if exists "Development anon read email drafts" on public.email_drafts;
drop policy if exists "Development authenticated read email drafts" on public.email_drafts;
drop policy if exists "Development anon read sending settings" on public.sending_settings;
drop policy if exists "Development authenticated read sending settings" on public.sending_settings;

revoke all on function public.enroll_eligible_campaign_contacts(uuid, integer, date)
from public, anon, authenticated;

grant execute on function public.enroll_eligible_campaign_contacts(uuid, integer, date)
to service_role;

-- Some older projects contain this catalog-management helper. Do not require
-- it to exist, but ensure browser/public roles cannot execute it when it does.
do $$
begin
  if pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;

notify pgrst, 'reload schema';
