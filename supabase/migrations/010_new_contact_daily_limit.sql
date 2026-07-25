alter table public.campaigns
  add column if not exists new_contacts_per_day integer not null default 8;

alter table public.campaigns
  alter column daily_send_limit set default 25;

update public.campaigns
set new_contacts_per_day = 8
where new_contacts_per_day is null;

notify pgrst, 'reload schema';
