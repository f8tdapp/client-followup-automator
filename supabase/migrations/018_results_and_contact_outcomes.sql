-- Migration 018: Results summary and recording replies / unsubscribes /
-- do-not-contact by email address.
--
-- Pilot finding (Oct 2026): unsubscribe requests and replies arrived days
-- after sending, when the contact no longer had a draft in today's list, so
-- Mark Unsubscribed could not be used and outreach continued. These functions
-- let the owner record those outcomes by address, and give the app one place
-- that calculates the pilot statistics.
--
-- Single-customer for now. When workspaces land, both public functions take a
-- workspace and scope every read and write to it.

-- 1. Internal helper: apply one outcome to one contact.
create or replace function public.pipelinecue_apply_outcome_suppression(
  requested_contact_id uuid,
  requested_outcome text,
  requested_note text,
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
  effective_outcome text;
  effective_note text;
  outcome_label text;
  matching_types text[];
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
  effective_outcome := pg_catalog.lower(pg_catalog.btrim(coalesce(requested_outcome, '')));
  effective_note := pg_catalog.left(nullif(pg_catalog.btrim(requested_note), ''), 200);

  outcome_label := case effective_outcome
    when 'unsubscribed' then 'Unsubscribed'
    when 'replied' then 'Replied'
    when 'do_not_contact' then 'Do not contact'
    else null
  end;

  if outcome_label is null then
    raise exception 'Unsupported outcome: %', requested_outcome;
  end if;

  matching_types := case effective_outcome
    when 'unsubscribed' then array['unsubscribed', 'unsubscribe']
    when 'replied' then array['replied', 'reply']
    else array['do_not_contact']
  end;

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
        = any (matching_types)
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
      effective_outcome,
      outcome_label
        || coalesce(': ' || effective_note, '')
        || '. Recorded in PipelineCue by ' || effective_actor,
      'pipelinecue_manual',
      true,
      null,
      effective_at,
      effective_at
    );
  end if;

  if effective_outcome = 'unsubscribed' then
    update public.hubspot_contacts
    set is_unsubscribed = true,
        updated_at = effective_at
    where id = requested_contact_id
      and is_unsubscribed = false;
  end if;

  update public.contact_campaign_enrollments as enrollments
  set status = 'stopped',
      stopped_reason = outcome_label || ' in PipelineCue at ' || effective_at::text,
      completed_at = null,
      updated_at = effective_at
  where enrollments.contact_id = requested_contact_id
    and enrollments.status = 'active';
  get diagnostics enrollment_count = row_count;

  update public.daily_send_schedule as schedules
  set status = 'skipped',
      reason = outcome_label || '.',
      safety_status = effective_outcome,
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

alter function public.pipelinecue_apply_outcome_suppression(uuid, text, text, text, timestamptz)
owner to postgres;

revoke all on function public.pipelinecue_apply_outcome_suppression(uuid, text, text, text, timestamptz)
from public, anon, authenticated, service_role;

-- 2. Record an outcome for a list of email addresses. One transaction: if any
-- contact fails, nothing is recorded.
create or replace function public.record_contact_outcomes(
  requested_emails text[],
  requested_outcome text,
  requested_note text,
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
      from public.pipelinecue_apply_outcome_suppression(
        contact_record.id,
        requested_outcome,
        requested_note,
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

alter function public.record_contact_outcomes(text[], text, text, text, timestamptz)
owner to postgres;

revoke all on function public.record_contact_outcomes(text[], text, text, text, timestamptz)
from public, anon, authenticated;

grant execute on function public.record_contact_outcomes(text[], text, text, text, timestamptz)
to service_role;

-- 3. Results summary: every statistic on the Results page, read-only.
create or replace function public.pipelinecue_results_summary()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with sent as (
    select schedules.contact_id, drafts.step_number, drafts.manually_sent_at
    from public.email_drafts as drafts
    join public.daily_send_schedule as schedules on schedules.id = drafts.schedule_id
    where drafts.status = 'manually_sent'
  ),
  emailed as (
    select distinct sent.contact_id from sent
  ),
  rules as (
    select
      suppressions.contact_id,
      suppressions.reason,
      suppressions.source,
      suppressions.created_at,
      case pg_catalog.lower(pg_catalog.btrim(suppressions.suppression_type))
        when 'bounced' then 'bounced'
        when 'bounce' then 'bounced'
        when 'unsubscribed' then 'unsubscribed'
        when 'unsubscribe' then 'unsubscribed'
        when 'replied' then 'replied'
        when 'reply' then 'replied'
        when 'do_not_contact' then 'do_not_contact'
        else null
      end as outcome
    from public.contact_suppression_rules as suppressions
    where suppressions.active = true
  ),
  stopped as (
    select distinct on (rules.contact_id, rules.outcome)
      rules.contact_id, rules.outcome, rules.reason, rules.source, rules.created_at
    from rules
    where rules.outcome is not null
    order by rules.contact_id, rules.outcome, rules.created_at desc
  ),
  bounce_kinds as (
    select
      stopped.contact_id,
      coalesce(
        pg_catalog.substring(stopped.reason, 'Bounce \(([^)]*)\)'),
        'not specified'
      ) as kind
    from stopped
    where stopped.outcome = 'bounced'
  ),
  domains as (
    select
      contacts.id as contact_id,
      pg_catalog.lower(pg_catalog.split_part(pg_catalog.btrim(contacts.email), '@', 2)) as domain
    from public.hubspot_contacts as contacts
  ),
  domain_stats as (
    select
      domains.domain,
      pg_catalog.count(*) as agents_emailed,
      pg_catalog.count(bounce_kinds.contact_id) as bounced,
      pg_catalog.count(bounce_kinds.contact_id)
        filter (where bounce_kinds.kind like 'message blocked%') as blocked
    from emailed
    join domains on domains.contact_id = emailed.contact_id
    left join bounce_kinds on bounce_kinds.contact_id = emailed.contact_id
    where domains.domain <> ''
    group by domains.domain
  ),
  still_active as (
    select distinct stopped.contact_id
    from stopped
    where exists (
        select 1 from public.contact_campaign_enrollments as enrollments
        where enrollments.contact_id = stopped.contact_id and enrollments.status = 'active'
      )
      or exists (
        select 1 from public.daily_send_schedule as schedules
        where schedules.contact_id = stopped.contact_id
          and schedules.status in ('scheduled', 'drafted', 'reviewed')
      )
      or exists (
        select 1
        from public.email_drafts as drafts
        join public.daily_send_schedule as schedules on schedules.id = drafts.schedule_id
        where schedules.contact_id = stopped.contact_id
          and drafts.status in ('draft', 'approved')
      )
  )
  select pg_catalog.jsonb_build_object(
    'generated_at', pg_catalog.now(),
    'first_sent_at', (select pg_catalog.min(sent.manually_sent_at) from sent),
    'last_sent_at', (select pg_catalog.max(sent.manually_sent_at) from sent),
    'agents_emailed', (select pg_catalog.count(*) from emailed),
    'emails_sent', (select pg_catalog.count(*) from sent),
    'sent_by_step', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('step', by_step.step_number, 'sent', by_step.sent)
        order by by_step.step_number
      )
      from (
        select sent.step_number, pg_catalog.count(*) as sent
        from sent
        group by sent.step_number
      ) as by_step
    ), '[]'::jsonb),
    'agents_completed', (
      select pg_catalog.count(*)
      from public.contact_campaign_enrollments as enrollments
      where enrollments.status = 'completed'
    ),
    'bounced_emailed', (
      select pg_catalog.count(*)
      from bounce_kinds
      join emailed on emailed.contact_id = bounce_kinds.contact_id
    ),
    'outcome_counts', coalesce((
      select pg_catalog.jsonb_object_agg(counts.outcome, counts.contacts)
      from (
        select stopped.outcome, pg_catalog.count(*) as contacts
        from stopped
        group by stopped.outcome
      ) as counts
    ), '{}'::jsonb),
    'bounce_kinds', coalesce((
      select pg_catalog.jsonb_object_agg(counts.kind, counts.contacts)
      from (
        select bounce_kinds.kind, pg_catalog.count(*) as contacts
        from bounce_kinds
        group by bounce_kinds.kind
      ) as counts
    ), '{}'::jsonb),
    'hubspot_unsubscribed', (
      select pg_catalog.count(*)
      from public.hubspot_contacts as contacts
      where contacts.is_unsubscribed = true
    ),
    'by_domain', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'domain', ranked.domain,
          'agents_emailed', ranked.agents_emailed,
          'bounced', ranked.bounced,
          'blocked', ranked.blocked
        )
        order by ranked.bounced desc, ranked.agents_emailed desc, ranked.domain
      )
      from (
        select domain_stats.*
        from domain_stats
        order by domain_stats.bounced desc, domain_stats.agents_emailed desc, domain_stats.domain
        limit 12
      ) as ranked
    ), '[]'::jsonb),
    'stopped_contacts', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'contact_id', listed.contact_id,
          'email', listed.email,
          'name', listed.name,
          'company', listed.company,
          'outcome', listed.outcome,
          'reason', listed.reason,
          'recorded_at', listed.created_at
        )
        order by listed.created_at desc, listed.email
      )
      from (
        select
          stopped.contact_id,
          stopped.outcome,
          stopped.reason,
          stopped.created_at,
          contacts.email,
          contacts.company,
          nullif(
            pg_catalog.btrim(
              coalesce(contacts.first_name, '') || ' ' || coalesce(contacts.last_name, '')
            ),
            ''
          ) as name
        from stopped
        join public.hubspot_contacts as contacts on contacts.id = stopped.contact_id
        order by stopped.created_at desc
        limit 500
      ) as listed
    ), '[]'::jsonb),
    'health', pg_catalog.jsonb_build_object(
      'duplicate_step_sends', (
        select pg_catalog.count(*)
        from (
          select sent.contact_id, sent.step_number
          from sent
          group by sent.contact_id, sent.step_number
          having pg_catalog.count(*) > 1
        ) as duplicates
      ),
      'stopped_still_active', (select pg_catalog.count(*) from still_active)
    )
  );
$$;

alter function public.pipelinecue_results_summary()
owner to postgres;

revoke all on function public.pipelinecue_results_summary()
from public, anon, authenticated;

grant execute on function public.pipelinecue_results_summary()
to service_role;

notify pgrst, 'reload schema';
