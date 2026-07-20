alter table public.sending_settings
add column if not exists preferred_email_provider text not null default 'other';

update public.sending_settings
set preferred_email_provider = 'other'
where preferred_email_provider not in ('gmail', 'outlook', 'other');

alter table public.sending_settings
drop constraint if exists sending_settings_preferred_email_provider_check;

alter table public.sending_settings
add constraint sending_settings_preferred_email_provider_check
check (preferred_email_provider in ('gmail', 'outlook', 'other'));

notify pgrst, 'reload schema';
