# PipelineCue workspace foundation

Migration 012 is intentionally **unapplied**. Public signup, workspace switching, and Stripe checkout/billing are not implemented. Until every server route is converted in one reviewed change, the deployed application must remain on the existing email-allowlisted, single-owner boundary.

## Model

`workspaces` is the customer boundary. A workspace may be `free`, `trialing`, `active`, `past_due`, `suspended`, or `cancelled`; Stripe customer and subscription IDs are nullable placeholders. `workspace_members` joins a Supabase Auth user to a workspace with an `owner`, `admin`, or `member` role and an active/inactive status.

The deterministic legacy workspace ID is `00000000-0000-4000-8000-000000000001`. Migration 012 backfills existing rows to it, then makes `workspace_id` required with no default. Composite foreign keys prevent records in one workspace from referencing contacts, campaigns, steps, schedules, or drafts in another. Browser roles retain no table privileges; service-role queries must always filter and write the authorized workspace because service role bypasses RLS.

## Manual first-customer onboarding (after isolated validation)

1. Apply Migration 012 only to an isolated staging clone and verify its preflight backup and row counts. Do not apply it to production as part of this work.
2. In the Supabase dashboard, use Authentication → Users → Add user and create the customer with a temporary password and **Auto Confirm User** enabled. Do not use “send invitation” or magic-link actions during testing; those send email. Store the returned Auth user UUID, not the password.
3. Using a trusted SQL/admin channel, add the membership:

   ```sql
   insert into public.workspace_members (workspace_id, user_id, role, status)
   values ('00000000-0000-4000-8000-000000000001', '<AUTH_USER_UUID>', 'owner', 'active');
   ```

4. Verify the membership resolves through the server authorization layer. Before Migration 012, only a missing `workspace_members` relation may reach the legacy fallback; other lookup failures fail closed. Once membership is verified, remove the explicit allowlist fallback in `lib/workspace-authorization.ts` in the same release that converts all routes.
5. Connect HubSpot later from the authenticated workspace after the OAuth route conversion is complete. The future OAuth state must be single-use, integrity-protected, short-lived, and bound to both the verified Auth user ID and server-resolved workspace ID.

Do not manually populate Stripe fields for the free customer. Null Stripe values are valid.

## Rollback plan

Take a database backup and record per-table row counts before isolated validation. Migration 012 is structural and should be rolled back by restoring that backup, not by an ad-hoc down migration. Dropping workspace columns would require first removing composite foreign keys and recreating the original global keys and uniqueness; doing this manually risks losing tenant distinctions and is not approved for production. If validation fails, discard/restore the isolated database and leave production untouched.

## Runtime conversion still required

Before Migration 012 can be considered application-ready, convert every privileged route and helper together: dashboard, campaigns/templates/steps, enrollment RPC and counts, scheduling/limits/suppressions, drafts, sending settings, forecast, recommendations, and all HubSpot connection/token/sync/health operations. Every read needs `workspace_id = authorizedWorkspace`; every insert must set it; every update/delete/upsert and RPC must include it. Add two-workspace integration tests against a disposable database, including hostile update/delete IDs and identical HubSpot IDs. No mixed single-tenant/multi-tenant runtime is safe to deploy.
