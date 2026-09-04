import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  excludePreviouslyManuallySentEnrollments,
  getManualSendProgressionKey,
} from "./manual-send-safety.ts";

const migrationUrl = new URL(
  "../supabase/migrations/015_atomic_manual_send_hotfix.sql",
  import.meta.url,
);

test("previously manually sent steps are excluded across schedule dates", () => {
  const enrollments = [
    { id: "enrollment-1", contact_id: "contact-1", campaign_id: "campaign-1", current_step: 1 },
    { id: "enrollment-2", contact_id: "contact-2", campaign_id: "campaign-1", current_step: 1 },
  ];
  const steps = [
    { id: "step-1", campaign_id: "campaign-1", step_number: 1 },
  ];
  const sent = new Set([
    getManualSendProgressionKey("contact-1", "campaign-1", "step-1"),
  ]);

  assert.deepEqual(
    excludePreviouslyManuallySentEnrollments(enrollments, steps, sent).map(
      (row) => row.id,
    ),
    ["enrollment-2"],
  );
});

test("a sent step does not suppress a different contact, campaign, or step", () => {
  const steps = [
    { id: "step-1", campaign_id: "campaign-1", step_number: 1 },
    { id: "step-2", campaign_id: "campaign-1", step_number: 2 },
  ];
  const sent = new Set([
    getManualSendProgressionKey("contact-1", "campaign-1", "step-1"),
  ]);
  const enrollments = [
    { id: "later-step", contact_id: "contact-1", campaign_id: "campaign-1", current_step: 2 },
    { id: "other-contact", contact_id: "contact-2", campaign_id: "campaign-1", current_step: 1 },
    { id: "other-campaign", contact_id: "contact-1", campaign_id: "campaign-2", current_step: 1 },
  ];

  assert.deepEqual(
    excludePreviouslyManuallySentEnrollments(enrollments, steps, sent),
    enrollments,
  );
});

test("migration atomically progresses Email 1 to Email 2 using production columns", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /for update;/);
  assert.match(migration, /set status = 'active',[\s\S]*current_step = next_step_record\.step_number/);
  assert.match(migration, /last_sent_at = effective_sent_at/);
  assert.match(migration, /next_send_date = \(\(effective_sent_at at time zone 'UTC'\)::date \+ next_step_record\.delay_days\)/);
  assert.doesNotMatch(
    migration,
    /current_step_number|last_sent_step_number|next_step_due_at/,
  );
});

test("migration completes a final-step enrollment and its schedule", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /update public\.daily_send_schedule[\s\S]*status = 'manually_sent'/);
  assert.match(migration, /else[\s\S]*update public\.contact_campaign_enrollments[\s\S]*status = 'completed'/);
  assert.match(migration, /completed_at = effective_sent_at/);
});

test("migration retry is idempotent and repairs only an unadvanced partial write", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /already_recorded := draft_record\.status = 'manually_sent'/);
  assert.match(migration, /enrollment_record\.current_step > draft_record\.step_number/);
  assert.match(migration, /'already_recorded'::text/);
  assert.match(migration, /case when already_recorded then 'repaired' else 'recorded' end/);
  assert.match(migration, /current_step <> draft_record\.step_number[\s\S]*raise exception/);
});

test("migration validates every locked relationship before its first state change", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const firstMutation = migration.indexOf("update public.daily_send_schedule");

  assert.ok(firstMutation > migration.indexOf("from public.email_drafts as drafts"));
  assert.ok(firstMutation > migration.indexOf("from public.daily_send_schedule as schedules"));
  assert.ok(firstMutation > migration.indexOf("from public.contact_campaign_enrollments as enrollments"));
  assert.ok(firstMutation > migration.indexOf("Draft % does not match its schedule campaign and step."));
  assert.doesNotMatch(migration, /exception\s+when/i);
});

test("database function is service-role-only with a fixed secure search path", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /language plpgsql\s+security definer\s+set search_path = pg_catalog, pg_temp/);
  assert.match(migration, /owner to postgres/);
  assert.match(
    migration,
    /revoke all on function public\.mark_email_draft_manually_sent\(uuid, timestamptz, text\)\s+from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function public\.mark_email_draft_manually_sent\(uuid, timestamptz, text\)\s+to service_role/,
  );
});

test("application uses only the atomic RPC for manual-send progression", async () => {
  const source = await readFile(new URL("./email-drafts.ts", import.meta.url), "utf8");
  const markStart = source.indexOf("export async function markManuallySent");
  const markEnd = source.indexOf("async function updateDraftStatus", markStart);
  const markSource = source.slice(markStart, markEnd);

  assert.match(markSource, /\.rpc\("mark_email_draft_manually_sent"/);
  assert.match(markSource, /data\.length === 1/);
  assert.match(markSource, /Atomic manual-send operation returned no recognized result/);
  assert.doesNotMatch(markSource, /\.from\("email_drafts"\)|\.from\("contact_campaign_enrollments"\)/);
  assert.doesNotMatch(
    source,
    /current_step_number|last_sent_step_number|next_step_due_at/,
  );
});

test("scheduler loads manually sent history and exposes completed schedules", async () => {
  const [scheduleSource, draftSource] = await Promise.all([
    readFile(new URL("./campaign-schedule.ts", import.meta.url), "utf8"),
    readFile(new URL("./email-drafts.ts", import.meta.url), "utf8"),
  ]);

  assert.match(scheduleSource, /getManuallySentProgressions/);
  assert.match(scheduleSource, /\.eq\("status", "manually_sent"\)/);
  assert.match(scheduleSource, /excludePreviouslyManuallySentEnrollments/);
  assert.match(scheduleSource, /\["scheduled", "skipped", "manually_sent"\]/);
  assert.match(draftSource, /"manually_sent",/);
});
