-- Migration 017: record bounced and blocked email addresses.
--
-- Pilot finding (Sep-Oct 2026): contacts whose first email bounced kept
-- receiving later campaign steps because PipelineCue had no way to record a
-- bounce. These functions add a permanent 'bounced' suppression, stop active
-- enrollments, and skip unsent drafts and pending schedules for the contact.
-- Genuine sent history is preserved. HubSpot is not changed. Nothing is sent.
--
-- Every bounce kind (address not found, message blocked, mailbox full, other)
-- produces the same terminal 'bounced' suppression. The kind is kept in the
-- suppression reason so a soft bounce can be reviewed and lifted later.

create or replace function public.pipelinecue_apply_bounce_suppression(
  requested_contact_id uuid,
  requested_kind text,
  requested_actor text,
  requested_at timestamptz
)
returns table (
  result text,
  stopped_enrollments integer,
  skipped_schedules integer,
  skipped_drafts integer
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  effective_at timestamptz;
  effective_actor text;
  effective_kind text;
  kind_label text;
  already_suppressed boolean;
  enrollment_count integer := 0;
  schedule_count integer := 0;
  draft_count integer := 0;
begin
  if requested_contact_id is null then
    raise exception 'Contact ID must not be null.';
  end if;

  effective_at := coalesce(requested_at, pg_catalog.now());
  effective_actor := coalesce(
    nullif(pg_catalog.btrim(requested_actor), ''),
    'authorized owner'
  );
  effective_kind := coalesce(
    nullif(pg_catalog.lower(pg_catalog.btrim(requested_kind)), ''),
    'other'
  );

  kind_label := case effective_kind
    when 'address_not_found' then 'address not found'
    when 'blocked' then 'message blocked by recipient server'
    when 'mailbox_full' then 'mailbox full'
    when 'other' then 'other delivery failure'
    else null
  end;

  if kind_label is null then
    raise exception 'Unsupported bounce kind: %', requested_kind;
  end if;

  perform 1
  from public.hubspot_contacts as contacts
  where contacts.id = requested_contact_id
  for update;

  if not found then
    raise exception 'Contact % was not found.', requested_contact_id;
  end if;

  select exists (
    select 1
    from public.contact_suppression_rules as suppressions
    where suppressions.contact_id = requested_contact_id
      and suppressions.active = true
      and pg_catalog.lower(pg_catalog.btrim(suppressions.suppression_type))
        in ('bounced', 'bounce')
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
      requested_contact_id,
      'bounced',
      'Bounce (' || kind_label || ') confirmed in PipelineCue by ' || effective_actor,
      'pipelinecue_manual',
      true,
      null,
      effective_at,
      effective_at
    );
  end if;

  update public.contact_campaign_enrollments as enrollments
  set status = 'stopped',
      stopped_reason = 'Bounced (' || kind_label || ') in PipelineCue at ' || effective_at::text,
      completed_at = null,
      updated_at = effective_at
  where enrollments.contact_id = requested_contact_id
    and enrollments.status = 'active';
  get diagnostics enrollment_count = row_count;

  update public.daily_send_schedule as schedules
  set status = 'skipped',
      reason = 'Email bounced (' || kind_label || ').',
      safety_status = 'bounced',
      updated_at = effective_at
  where schedules.contact_id = requested_contact_id
    and schedules.status in ('scheduled', 'drafted', 'reviewed');
  get diagnostics schedule_count = row_count;

  update public.email_drafts as drafts
  set status = 'skipped',
      approved_at = null,
      skipped_at = effective_at,
      updated_at = effective_at
  from public.daily_send_schedule as schedules
  where drafts.schedule_id = schedules.id
    and schedules.contact_id = requested_contact_id
    and drafts.status in ('draft', 'approved');
  get diagnostics draft_count = row_count;

  return query
  select
    case when already_suppressed then 'already_recorded' else 'recorded' end,
    enrollment_count,
    schedule_count,
    draft_count;
end;
$$;

alter function public.pipelinecue_apply_bounce_suppression(uuid, text, text, timestamptz)
owner to postgres;

-- Internal helper: only the two public entry points below may call it.
revoke all on function public.pipelinecue_apply_bounce_suppression(uuid, text, text, timestamptz)
from public, anon, authenticated, service_role;

-- Entry point 1: mark the contact behind a draft as bounced.
create or replace function public.mark_email_draft_contact_bounced(
  requested_draft_id uuid,
  requested_kind text,
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
  target_contact_id uuid;
  applied record;
begin
  if requested_draft_id is null then
    raise exception 'Draft ID must not be null.';
  end if;

  select drafts.*
  into draft_record
  from public.email_drafts as drafts
  where drafts.id = requested_draft_id
  for update;

  if not found then
    raise exception 'Draft % was not found.', requested_draft_id;
  end if;

  select schedules.contact_id
  into target_contact_id
  from public.daily_send_schedule as schedules
  where schedules.id = draft_record.schedule_id
  for update;

  if not found then
    raise exception 'Schedule % was not found.', draft_record.schedule_id;
  end if;

  select *
  into applied
  from public.pipelinecue_apply_bounce_suppression(
    target_contact_id,
    requested_kind,
    requested_actor,
    requested_at
  );

  return query
  select
    applied.result,
    target_contact_id,
    applied.stopped_enrollments,
    applied.skipped_schedules,
    applied.skipped_drafts;
end;
$$;

alter function public.mark_email_draft_contact_bounced(uuid, text, text, timestamptz)
owner to postgres;

revoke all on function public.mark_email_draft_contact_bounced(uuid, text, text, timestamptz)
from public, anon, authenticated;

grant execute on function public.mark_email_draft_contact_bounced(uuid, text, text, timestamptz)
to service_role;

-- Entry point 2: record bounces for a list of email addresses (for example,
-- bounce notices found in Gmail days after sending). The whole batch is one
-- transaction: if any contact fails, nothing is recorded.
create or replace function public.record_contact_bounces(
  requested_emails text[],
  requested_kind text,
  requested_actor text,
  requested_at timestamptz default now()
)
returns table (
  email text,
  result text,
  matched_contacts integer,
  stopped_enrollments integer,
  skipped_schedules integer,
  skipped_drafts integer
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  normalized_email text;
  normalized_emails text[];
  contact_record record;
  applied record;
  email_result text;
  email_matches integer;
  email_enrollments integer;
  email_schedules integer;
  email_draft_count integer;
begin
  select coalesce(pg_catalog.array_agg(distinct cleaned.value order by cleaned.value), '{}')
  into normalized_emails
  from (
    select pg_catalog.lower(pg_catalog.btrim(raw.value)) as value
    from pg_catalog.unnest(coalesce(requested_emails, '{}'::text[])) as raw(value)
  ) as cleaned
  where cleaned.value <> '';

  if pg_catalog.cardinality(normalized_emails) = 0 then
    raise exception 'At least one email address is required.';
  end if;

  if pg_catalog.cardinality(normalized_emails) > 200 then
    raise exception 'Record at most 200 email addresses at a time.';
  end if;

  foreach normalized_email in array normalized_emails loop
    if normalized_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'Invalid email address: %', normalized_email;
    end if;

    email_result := null;
    email_matches := 0;
    email_enrollments := 0;
    email_schedules := 0;
    email_draft_count := 0;

    for contact_record in
      select contacts.id
      from public.hubspot_contacts as contacts
      where pg_catalog.lower(pg_catalog.btrim(contacts.email)) = normalized_email
      order by contacts.id
    loop
      select *
      into applied
      from public.pipelinecue_apply_bounce_suppression(
        contact_record.id,
        requested_kind,
        requested_actor,
        requested_at
      );

      email_matches := email_matches + 1;
      email_enrollments := email_enrollments + applied.stopped_enrollments;
      email_schedules := email_schedules + applied.skipped_schedules;
      email_draft_count := email_draft_count + applied.skipped_drafts;

      if applied.result = 'recorded' then
        email_result := 'recorded';
      elsif email_result is null then
        email_result := 'already_recorded';
      end if;
    end loop;

    return query
    select
      normalized_email,
      coalesce(email_result, 'not_found'),
      email_matches,
      email_enrollments,
      email_schedules,
      email_draft_count;
  end loop;
end;
$$;

alter function public.record_contact_bounces(text[], text, text, timestamptz)
owner to postgres;

revoke all on function public.record_contact_bounces(text[], text, text, timestamptz)
from public, anon, authenticated;

grant execute on function public.record_contact_bounces(text[], text, text, timestamptz)
to service_role;

notify pgrst, 'reload schema';
