import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL("../supabase/migrations/012_workspace_foundation.sql", import.meta.url), "utf8");

test("workspace foundation has deterministic free legacy workspace without Stripe", () => {
  assert.match(sql, /00000000-0000-4000-8000-000000000001/);
  assert.match(sql, /'legacy-first-customer', 'free'/);
  assert.match(sql, /stripe_customer_id text unique/);
  assert.match(sql, /stripe_subscription_id text unique/);
  assert.doesNotMatch(sql, /add column workspace_id uuid\s+default/i);
});

test("all customer-owned tables receive a required workspace key", () => {
  for (const table of ["clients", "client_events", "campaigns", "email_templates", "campaign_steps", "hubspot_connections", "hubspot_contacts", "contact_engagement_events", "daily_recommendations", "contact_campaign_enrollments", "daily_send_schedule", "broker_domain_limits", "contact_suppression_rules", "email_drafts", "sending_settings"]) {
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /alter column workspace_id set not null/);
  assert.match(sql, /foreign key \(workspace_id\) references public\.workspaces/);
});

test("tenant-local HubSpot IDs, connections, domains, recommendations, and settings are unique", () => {
  for (const index of ["hubspot_connections_workspace_provider_key", "hubspot_contacts_workspace_contact_key", "daily_recommendations_workspace_date_contact_key", "broker_domain_limits_workspace_domain_key", "sending_settings_workspace_provider_key"]) {
    assert.match(sql, new RegExp(`create unique index ${index}`));
  }
  assert.doesNotMatch(sql, /drop index if exists public\.hubspot_contacts_hubspot_contact_id_key/);
  assert.match(sql, /drop constraint if exists hubspot_contacts_hubspot_contact_id_key/);
});

test("composite foreign keys reject cross-workspace campaign/contact/enrolment links", () => {
  for (const constraint of ["enrollments_workspace_contact_fk", "enrollments_workspace_campaign_fk", "schedule_workspace_contact_fk", "schedule_workspace_campaign_fk", "schedule_workspace_step_fk", "drafts_workspace_schedule_fk"]) {
    assert.match(sql, new RegExp(`constraint ${constraint} foreign key \\(workspace_id,`));
  }
});

test("browser roles receive no workspace privileges", () => {
  assert.match(sql, /revoke all privileges on table public\.workspaces, public\.workspace_members from public, anon, authenticated/);
  assert.doesNotMatch(sql, /grant (select|insert|update|delete).*to (anon|authenticated)/i);
});
