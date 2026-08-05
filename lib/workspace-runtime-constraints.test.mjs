import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/014_workspace_runtime_constraints.sql", import.meta.url), "utf8");
const rpcMigration = readFileSync(new URL("../supabase/migrations/013_workspace_runtime_enforcement.sql", import.meta.url), "utf8");

test("Migration 014 replaces global constraints with all workspace conflict targets", () => {
  for (const oldConstraint of [
    "campaign_steps_campaign_id_step_number_key",
    "daily_send_schedule_contact_id_campaign_id_campaign_step_id_scheduled_date_key",
    "email_drafts_schedule_id_key",
    "contact_campaign_enrollments_contact_id_campaign_id_key",
  ]) assert.match(migration, new RegExp(`drop constraint if exists ${oldConstraint}`));
  for (const columns of [
    "workspace_id, campaign_id, step_number",
    "workspace_id, contact_id, campaign_id, campaign_step_id, scheduled_date",
    "workspace_id, schedule_id",
    "workspace_id, contact_id, campaign_id",
  ]) assert.match(migration, new RegExp(`create unique index if not exists[\\s\\S]*?\\(${columns}\\)`));
});

test("Migration 013 uses the Migration 014 enrollment conflict target in order", () => {
  assert.match(rpcMigration, /on conflict \(workspace_id, contact_id, campaign_id\) do nothing/);
  assert.ok(rpcMigration.includes("requested_workspace_id"));
});

test("OAuth nonces store only a SHA-256-sized digest with service-only RLS access", () => {
  assert.match(migration, /nonce_digest bytea not null/);
  assert.match(migration, /octet_length\(nonce_digest\) = 32/);
  assert.doesNotMatch(migration, /\bnonce\s+text\b/i);
  assert.match(migration, /alter table public\.hubspot_oauth_nonces enable row level security/);
  assert.match(migration, /revoke all privileges on table public\.hubspot_oauth_nonces from public, anon, authenticated/);
  assert.match(migration, /grant all privileges on table public\.hubspot_oauth_nonces to service_role/);
});

test("nonce consumption is one atomic fail-closed update", () => {
  for (const guard of [
    "workspace_id = requested_workspace_id",
    "user_id = requested_user_id",
    "nonce_digest = requested_nonce_digest",
    "consumed_at is null",
    "expires_at > effective_time",
  ]) assert.match(migration, new RegExp(guard));
  assert.match(migration, /update public\.hubspot_oauth_nonces[\s\S]*returning id into consumed_id/);
  assert.match(migration, /effective_time timestamptz := pg_catalog\.clock_timestamp\(\)/);
  assert.doesNotMatch(migration, /consumed_time timestamptz/);
  assert.match(migration, /return consumed_id is not null/);
});

test("nonce consume function has secure ownership, path, and grants", () => {
  assert.match(migration, /security definer\s+set search_path = pg_catalog, pg_temp/);
  assert.match(migration, /alter function public\.consume_hubspot_oauth_nonce\(uuid, uuid, bytea\)\s+owner to postgres/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /grant execute on function[\s\S]*to (anon|authenticated)/);
});

test("recommendation contact relationship remains one named workspace composite", () => {
  assert.match(migration, /constraint recommendations_workspace_contact_fk[\s\S]*foreign key \(workspace_id, hubspot_contact_id\)[\s\S]*references public\.hubspot_contacts\(workspace_id, hubspot_contact_id\)/);
  assert.doesNotMatch(migration, /references public\.hubspot_contacts\(hubspot_contact_id\)/);
});
