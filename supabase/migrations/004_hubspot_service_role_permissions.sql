grant usage on schema public to service_role;

grant all privileges on table public.hubspot_connections to service_role;
grant all privileges on table public.hubspot_contacts to service_role;
grant all privileges on table public.contact_engagement_events to service_role;
grant all privileges on table public.daily_recommendations to service_role;

grant select on table public.hubspot_contacts to anon, authenticated;
grant select on table public.contact_engagement_events to anon, authenticated;
grant select on table public.daily_recommendations to anon, authenticated;

revoke insert, update, delete on table public.hubspot_contacts from anon, authenticated;
revoke insert, update, delete on table public.contact_engagement_events from anon, authenticated;
revoke insert, update, delete on table public.daily_recommendations from anon, authenticated;

drop policy if exists "Development anon full access hubspot contacts" on public.hubspot_contacts;
drop policy if exists "Development authenticated full access hubspot contacts" on public.hubspot_contacts;
drop policy if exists "Development anon full access engagement events" on public.contact_engagement_events;
drop policy if exists "Development authenticated full access engagement events" on public.contact_engagement_events;
drop policy if exists "Development anon full access daily recommendations" on public.daily_recommendations;
drop policy if exists "Development authenticated full access daily recommendations" on public.daily_recommendations;

create policy "Development anon read hubspot contacts"
on public.hubspot_contacts
for select
to anon
using (true);

create policy "Development authenticated read hubspot contacts"
on public.hubspot_contacts
for select
to authenticated
using (true);

create policy "Development anon read engagement events"
on public.contact_engagement_events
for select
to anon
using (true);

create policy "Development authenticated read engagement events"
on public.contact_engagement_events
for select
to authenticated
using (true);

create policy "Development anon read daily recommendations"
on public.daily_recommendations
for select
to anon
using (true);

create policy "Development authenticated read daily recommendations"
on public.daily_recommendations
for select
to authenticated
using (true);

notify pgrst, 'reload schema';
