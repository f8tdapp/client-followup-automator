create or replace function public.mark_email_draft_manually_sent(
  requested_draft_id uuid,
  requested_sent_at timestamptz default now(),
  requested_note text default null
)
returns table (
  result text,
  draft_id uuid,
  schedule_id uuid,
  enrollment_id uuid,
  enrollment_status text,
  enrollment_step integer,
  next_send_date date
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  draft_record public.email_drafts%rowtype;
  schedule_record public.daily_send_schedule%rowtype;
  enrollment_record public.contact_campaign_enrollments%rowtype;
  current_step_record public.campaign_steps%rowtype;
  next_step_record public.campaign_steps%rowtype;
  effective_sent_at timestamptz;
  effective_note text;
  already_recorded boolean;
begin
  if requested_draft_id is null then
    raise exception 'Draft ID must not be null.';
  end if;

  if requested_sent_at is null then
    raise exception 'Sent timestamp must not be null.';
  end if;

  select drafts.*
  into draft_record
  from public.email_drafts as drafts
  where drafts.id = requested_draft_id
  for update;

  if not found then
    raise exception 'Draft % was not found.', requested_draft_id;
  end if;

  if draft_record.status not in ('approved', 'manually_sent') then
    raise exception 'Only approved or already manually sent drafts can be recorded as sent.';
  end if;

  if draft_record.schedule_id is null
     or draft_record.campaign_id is null
     or draft_record.campaign_step_id is null
     or draft_record.step_number is null then
    raise exception 'Draft % is missing campaign progress details.', requested_draft_id;
  end if;

  select schedules.*
  into schedule_record
  from public.daily_send_schedule as schedules
  where schedules.id = draft_record.schedule_id
  for update;

  if not found then
    raise exception 'Schedule % was not found.', draft_record.schedule_id;
  end if;

  if schedule_record.campaign_id <> draft_record.campaign_id
     or schedule_record.campaign_step_id <> draft_record.campaign_step_id then
    raise exception 'Draft % does not match its schedule campaign and step.', requested_draft_id;
  end if;

  select steps.*
  into current_step_record
  from public.campaign_steps as steps
  where steps.id = schedule_record.campaign_step_id
    and steps.campaign_id = schedule_record.campaign_id
    and steps.step_number = draft_record.step_number
  for key share;

  if not found then
    raise exception 'Draft % does not match an existing campaign step.', requested_draft_id;
  end if;

  select enrollments.*
  into enrollment_record
  from public.contact_campaign_enrollments as enrollments
  where enrollments.contact_id = schedule_record.contact_id
    and enrollments.campaign_id = schedule_record.campaign_id
  for update;

  if not found then
    raise exception 'Enrollment for draft % was not found.', requested_draft_id;
  end if;

  already_recorded := draft_record.status = 'manually_sent';
  effective_sent_at := case
    when already_recorded then draft_record.manually_sent_at
    else requested_sent_at
  end;
  effective_note := case
    when already_recorded then draft_record.manually_sent_note
    else nullif(pg_catalog.btrim(requested_note), '')
  end;

  if effective_sent_at is null then
    raise exception 'Manually sent draft % has no sent timestamp.', requested_draft_id;
  end if;

  if already_recorded then
    if enrollment_record.status = 'completed'
       or (
         enrollment_record.status = 'active'
         and enrollment_record.current_step > draft_record.step_number
       ) then
      update public.daily_send_schedule
      set status = 'manually_sent',
          updated_at = effective_sent_at
      where id = schedule_record.id
        and status <> 'manually_sent';

      return query
      select
        'already_recorded'::text,
        draft_record.id,
        schedule_record.id,
        enrollment_record.id,
        enrollment_record.status,
        enrollment_record.current_step,
        enrollment_record.next_send_date;
      return;
    end if;

    if enrollment_record.status <> 'active'
       or enrollment_record.current_step <> draft_record.step_number then
      raise exception 'Enrollment state is inconsistent with manually sent draft %.', requested_draft_id;
    end if;
  elsif enrollment_record.status <> 'active'
     or enrollment_record.current_step <> draft_record.step_number then
    raise exception 'Enrollment is not active at draft step %.', draft_record.step_number;
  end if;

  select steps.*
  into next_step_record
  from public.campaign_steps as steps
  where steps.campaign_id = schedule_record.campaign_id
    and steps.status = 'active'
    and steps.step_number > draft_record.step_number
  order by steps.step_number asc
  limit 1
  for key share;

  if not already_recorded then
    update public.email_drafts
    set status = 'manually_sent',
        manually_sent_at = effective_sent_at,
        manually_sent_note = effective_note,
        updated_at = effective_sent_at
    where id = draft_record.id;
  end if;

  update public.daily_send_schedule
  set status = 'manually_sent',
      updated_at = effective_sent_at
  where id = schedule_record.id;

  if next_step_record.id is not null then
    update public.contact_campaign_enrollments
    set status = 'active',
        current_step = next_step_record.step_number,
        last_sent_at = effective_sent_at,
        next_send_date = ((effective_sent_at at time zone 'UTC')::date + next_step_record.delay_days),
        completed_at = null,
        stopped_reason = null,
        updated_at = effective_sent_at
    where id = enrollment_record.id;
  else
    update public.contact_campaign_enrollments
    set status = 'completed',
        last_sent_at = effective_sent_at,
        completed_at = effective_sent_at,
        stopped_reason = null,
        updated_at = effective_sent_at
    where id = enrollment_record.id;
  end if;

  return query
  select
    case when already_recorded then 'repaired' else 'recorded' end,
    draft_record.id,
    schedule_record.id,
    enrollment_record.id,
    updated_enrollment.status,
    updated_enrollment.current_step,
    updated_enrollment.next_send_date
  from public.contact_campaign_enrollments as updated_enrollment
  where updated_enrollment.id = enrollment_record.id;
end;
$$;

alter function public.mark_email_draft_manually_sent(uuid, timestamptz, text)
owner to postgres;

revoke all on function public.mark_email_draft_manually_sent(uuid, timestamptz, text)
from public, anon, authenticated;

grant execute on function public.mark_email_draft_manually_sent(uuid, timestamptz, text)
to service_role;

notify pgrst, 'reload schema';
