create or replace function public.mark_email_draft_contact_unsubscribed(
  requested_draft_id uuid,
  requested_actor text,
  requested_at timestamptz default now()
)
returns table (
  result text,
  contact_id uuid,
  stopped_enrollments integer,
  skipped_schedules integer,
  skipped_drafts integer
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  draft_record public.email_drafts%rowtype;
  schedule_record public.daily_send_schedule%rowtype;
  effective_at timestamptz;
  effective_actor text;
  already_suppressed boolean;
  enrollment_count integer := 0;
  schedule_count integer := 0;
  draft_count integer := 0;
begin
  if requested_draft_id is null then
    raise exception 'Draft ID must not be null.';
  end if;

  effective_at := coalesce(requested_at, pg_catalog.now());
  effective_actor := coalesce(
    nullif(pg_catalog.btrim(requested_actor), ''),
    'authorized owner'
  );

  select drafts.*
  into draft_record
  from public.email_drafts as drafts
  where drafts.id = requested_draft_id
  for update;

  if not found then
    raise exception 'Draft % was not found.', requested_draft_id;
  end if;

  select schedules.*
  into schedule_record
  from public.daily_send_schedule as schedules
  where schedules.id = draft_record.schedule_id
  for update;

  if not found then
    raise exception 'Schedule % was not found.', draft_record.schedule_id;
  end if;

  perform 1
  from public.hubspot_contacts as contacts
  where contacts.id = schedule_record.contact_id
  for update;

  if not found then
    raise exception 'Contact for draft % was not found.', requested_draft_id;
  end if;

  select exists (
    select 1
    from public.contact_suppression_rules as suppressions
    where suppressions.contact_id = schedule_record.contact_id
      and suppressions.active = true
      and pg_catalog.lower(pg_catalog.btrim(suppressions.suppression_type))
        in ('unsubscribe', 'unsubscribed')
  )
  into already_suppressed;

  if not already_suppressed then
    insert into public.contact_suppression_rules (
      contact_id,
      suppression_type,
      reason,
      source,
      active,
      snoozed_until,
      created_at,
      updated_at
    ) values (
      schedule_record.contact_id,
      'unsubscribed',
      'Unsubscribe confirmed in PipelineCue by ' || effective_actor,
      'pipelinecue_manual',
      true,
      null,
      effective_at,
      effective_at
    );
  end if;

  update public.hubspot_contacts
  set is_unsubscribed = true,
      updated_at = effective_at
  where id = schedule_record.contact_id
    and is_unsubscribed = false;

  update public.contact_campaign_enrollments as enrollments
  set status = 'stopped',
      stopped_reason = 'Unsubscribed in PipelineCue at ' || effective_at::text,
      completed_at = null,
      updated_at = effective_at
  where enrollments.contact_id = schedule_record.contact_id
    and enrollments.status = 'active';
  get diagnostics enrollment_count = row_count;

  update public.daily_send_schedule as schedules
  set status = 'skipped',
      reason = 'Contact unsubscribed in PipelineCue.',
      safety_status = 'unsubscribed',
      updated_at = effective_at
  where schedules.contact_id = schedule_record.contact_id
    and schedules.status in ('scheduled', 'drafted', 'reviewed');
  get diagnostics schedule_count = row_count;

  update public.email_drafts as drafts
  set status = 'skipped',
      approved_at = null,
      skipped_at = effective_at,
      updated_at = effective_at
  from public.daily_send_schedule as schedules
  where drafts.schedule_id = schedules.id
    and schedules.contact_id = schedule_record.contact_id
    and drafts.status in ('draft', 'approved');
  get diagnostics draft_count = row_count;

  return query
  select
    case when already_suppressed then 'already_recorded' else 'recorded' end,
    schedule_record.contact_id,
    enrollment_count,
    schedule_count,
    draft_count;
end;
$$;

alter function public.mark_email_draft_contact_unsubscribed(uuid, text, timestamptz)
owner to postgres;

revoke all on function public.mark_email_draft_contact_unsubscribed(uuid, text, timestamptz)
from public, anon, authenticated;

grant execute on function public.mark_email_draft_contact_unsubscribed(uuid, text, timestamptz)
to service_role;

notify pgrst, 'reload schema';
