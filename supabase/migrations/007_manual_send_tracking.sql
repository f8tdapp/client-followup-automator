alter table public.email_drafts
  add column if not exists manually_sent_at timestamptz,
  add column if not exists manually_sent_note text;

do $$
declare
  constraint_record record;
begin
  for constraint_record in
    select conname
    from pg_constraint
    where conrelid = 'public.email_drafts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format(
      'alter table public.email_drafts drop constraint if exists %I',
      constraint_record.conname
    );
  end loop;
end $$;

alter table public.email_drafts
  add constraint email_drafts_status_check
  check (status in ('draft', 'approved', 'skipped', 'manually_sent'));

create index if not exists email_drafts_manually_sent_at_idx
on public.email_drafts(manually_sent_at);

alter table public.contact_campaign_enrollments
  add column if not exists current_step_number integer not null default 1,
  add column if not exists last_sent_step_number integer,
  add column if not exists next_step_due_at date;

update public.contact_campaign_enrollments
set current_step_number = current_step
where current_step_number is null
   or current_step_number <> current_step;

update public.contact_campaign_enrollments
set next_step_due_at = next_send_date
where next_step_due_at is null;

create index if not exists contact_campaign_enrollments_next_step_due_idx
on public.contact_campaign_enrollments(status, next_step_due_at, current_step_number);

notify pgrst, 'reload schema';
