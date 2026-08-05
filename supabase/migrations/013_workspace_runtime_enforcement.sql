-- UNAPPLIED: workspace-scoped replacement for Migration 011's enrollment RPC.
create or replace function public.enroll_eligible_campaign_contacts(
  requested_workspace_id uuid,
  requested_campaign_id uuid,
  confirmed_eligible_count integer,
  enrollment_date date default current_date
)
returns table (result text, message text, eligible_count integer, inserted_count integer)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  maximum_confirmed_eligible_count constant integer := 10000;
  campaign_paused boolean;
  calculated_eligible_count integer;
  calculated_inserted_count integer;
begin
  if requested_workspace_id is null or requested_campaign_id is null then
    raise exception 'Workspace ID and campaign ID must not be null.';
  end if;
  if confirmed_eligible_count is null or confirmed_eligible_count < 0 then
    raise exception 'Confirmed eligible count must be a non-negative integer.';
  end if;
  if confirmed_eligible_count > maximum_confirmed_eligible_count then
    raise exception 'Confirmed eligible count exceeds the maximum of %.', maximum_confirmed_eligible_count;
  end if;
  if enrollment_date is null then raise exception 'Enrollment date must not be null.'; end if;

  select campaigns.new_enrollments_paused into campaign_paused
  from public.campaigns as campaigns
  where campaigns.workspace_id = requested_workspace_id
    and campaigns.id = requested_campaign_id
    and campaigns.status = 'active'
  for update;
  if not found then raise exception 'Active campaign was not found in the requested workspace.'; end if;
  if campaign_paused then
    return query select 'paused'::text, 'New enrolments are paused for this campaign.'::text, 0, 0;
    return;
  end if;

  create temporary table pg_temp.eligible_campaign_contacts on commit drop as
  select contacts.id as contact_id
  from public.hubspot_contacts contacts
  where contacts.workspace_id = requested_workspace_id
    and contacts.email is not null and pg_catalog.btrim(contacts.email) <> ''
    and contacts.is_unsubscribed = false
    and not exists (
      select 1 from public.contact_suppression_rules suppression
      where suppression.workspace_id = requested_workspace_id
        and suppression.contact_id = contacts.id and suppression.active = true
        and (pg_catalog.lower(pg_catalog.btrim(suppression.suppression_type)) <> 'snoozed'
          or suppression.snoozed_until is null or suppression.snoozed_until >= enrollment_date)
    )
    and not exists (
      select 1 from public.contact_campaign_enrollments enrollment
      where enrollment.workspace_id = requested_workspace_id
        and enrollment.contact_id = contacts.id and enrollment.campaign_id = requested_campaign_id
    )
  order by contacts.id;

  select count(*)::integer into calculated_eligible_count from pg_temp.eligible_campaign_contacts;
  if calculated_eligible_count <> confirmed_eligible_count then
    return query select 'stale_count'::text,
      pg_catalog.format('Eligible contact count changed from %s to %s.', confirmed_eligible_count, calculated_eligible_count),
      calculated_eligible_count, 0;
    return;
  end if;
  if calculated_eligible_count = 0 then
    return query select 'no_eligible_contacts'::text, 'No eligible contacts are available to enrol.'::text, 0, 0;
    return;
  end if;

  insert into public.contact_campaign_enrollments (
    workspace_id, contact_id, campaign_id, current_step, current_step_number,
    status, next_send_date, next_step_due_at, updated_at
  )
  select requested_workspace_id, eligible.contact_id, requested_campaign_id, 1, 1,
    'active', enrollment_date, enrollment_date, pg_catalog.now()
  from pg_temp.eligible_campaign_contacts eligible
  on conflict (workspace_id, contact_id, campaign_id) do nothing;
  get diagnostics calculated_inserted_count = row_count;
  if calculated_inserted_count <> calculated_eligible_count then
    raise exception 'Concurrent enrolment changed the eligible set; no contacts were enrolled.';
  end if;
  return query select 'success'::text,
    pg_catalog.format('%s eligible contacts enrolled.', calculated_inserted_count),
    calculated_eligible_count, calculated_inserted_count;
end;
$$;

alter function public.enroll_eligible_campaign_contacts(uuid, uuid, integer, date) owner to postgres;
revoke all on function public.enroll_eligible_campaign_contacts(uuid, integer, date) from public, anon, authenticated, service_role;
revoke all on function public.enroll_eligible_campaign_contacts(uuid, uuid, integer, date) from public, anon, authenticated;
grant execute on function public.enroll_eligible_campaign_contacts(uuid, uuid, integer, date) to service_role;
notify pgrst, 'reload schema';
