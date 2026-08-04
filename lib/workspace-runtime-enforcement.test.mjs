import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL("../supabase/migrations/013_workspace_runtime_enforcement.sql", import.meta.url), "utf8");

test("Migration 013 requires workspace scope and rejects cross-workspace campaign IDs", () => {
  assert.match(sql, /requested_workspace_id uuid/);
  assert.match(sql, /campaigns\.workspace_id = requested_workspace_id/);
  assert.match(sql, /contacts\.workspace_id = requested_workspace_id/);
  assert.match(sql, /suppression\.workspace_id = requested_workspace_id/);
  assert.match(sql, /enrollment\.workspace_id = requested_workspace_id/);
});

test("Migration 013 preserves pause, exact-count, suppression, and atomicity guards", () => {
  for (const guard of ["campaign_paused", "stale_count", "snoozed_until", "calculated_inserted_count <> calculated_eligible_count", "for update"]) {
    assert.match(sql, new RegExp(guard));
  }
  assert.match(sql, /insert into public\.contact_campaign_enrollments \(\s*workspace_id/);
});

test("only service role may execute the workspace RPC", () => {
  assert.match(sql, /revoke all on function public\.enroll_eligible_campaign_contacts\(uuid, integer, date\).*service_role/s);
  assert.match(sql, /grant execute on function public\.enroll_eligible_campaign_contacts\(uuid, uuid, integer, date\) to service_role/);
  assert.doesNotMatch(sql, /grant execute .* to (anon|authenticated)/);
});
