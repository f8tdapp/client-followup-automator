import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  formatPercent,
  getBounceRate,
  getEmailDomain,
  isContactOutcome,
  summarizeOutcomeResults,
} from "./results-summary.ts";

const migrationUrl = new URL(
  "../supabase/migrations/018_results_and_contact_outcomes.sql",
  import.meta.url,
);

const ids = {
  campaign: "00000000-0000-4000-8000-000000000301",
  step1: "00000000-0000-4000-8000-000000000302",
  step2: "00000000-0000-4000-8000-000000000303",
  ann: "00000000-0000-4000-8000-000000000311",
  ben: "00000000-0000-4000-8000-000000000312",
  cat: "00000000-0000-4000-8000-000000000313",
  dan: "00000000-0000-4000-8000-000000000314",
};

const annEmail = "ann@brokerage.com";
const benEmail = "ben@other.com";

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon noinherit;
    create role authenticated noinherit;
    create role service_role noinherit;
    create table public.campaigns (id uuid primary key);
    create table public.hubspot_contacts (
      id uuid primary key,
      email text,
      first_name text,
      last_name text,
      company text,
      is_unsubscribed boolean not null default false,
      updated_at timestamptz not null default now()
    );
    create table public.campaign_steps (
      id uuid primary key,
      campaign_id uuid not null references public.campaigns(id)
    );
    create table public.contact_campaign_enrollments (
      id uuid primary key default gen_random_uuid(),
      contact_id uuid not null references public.hubspot_contacts(id),
      campaign_id uuid not null references public.campaigns(id),
      status text not null default 'active',
      stopped_reason text,
      completed_at timestamptz,
      updated_at timestamptz not null default now()
    );
    create table public.daily_send_schedule (
      id uuid primary key default gen_random_uuid(),
      contact_id uuid not null references public.hubspot_contacts(id),
      campaign_id uuid not null references public.campaigns(id),
      campaign_step_id uuid not null references public.campaign_steps(id),
      status text not null default 'scheduled',
      reason text not null default 'Ready.',
      safety_status text not null default 'safe',
      updated_at timestamptz not null default now()
    );
    create table public.email_drafts (
      id uuid primary key default gen_random_uuid(),
      schedule_id uuid not null references public.daily_send_schedule(id),
      status text not null default 'draft',
      step_number integer,
      approved_at timestamptz,
      skipped_at timestamptz,
      manually_sent_at timestamptz,
      updated_at timestamptz not null default now()
    );
    create table public.contact_suppression_rules (
      id uuid primary key default gen_random_uuid(),
      contact_id uuid not null references public.hubspot_contacts(id),
      suppression_type text not null,
      reason text,
      source text not null default 'manual',
      active boolean not null default true,
      snoozed_until date,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    grant all privileges on all tables in schema public to service_role;
  `);
  await db.exec(await readFile(migrationUrl, "utf8"));
  return db;
}

async function addSend(db, contactId, stepId, stepNumber, sentAt) {
  const schedule = await db.query(
    "insert into public.daily_send_schedule (contact_id,campaign_id,campaign_step_id,status) values ($1,$2,$3,'manually_sent') returning id",
    [contactId, ids.campaign, stepId],
  );
  await db.query(
    "insert into public.email_drafts (schedule_id,status,step_number,manually_sent_at) values ($1,'manually_sent',$2,$3)",
    [schedule.rows[0].id, stepNumber, sentAt],
  );
}

async function addPending(db, contactId, stepId, stepNumber, draftStatus) {
  const schedule = await db.query(
    "insert into public.daily_send_schedule (contact_id,campaign_id,campaign_step_id) values ($1,$2,$3) returning id",
    [contactId, ids.campaign, stepId],
  );
  await db.query(
    "insert into public.email_drafts (schedule_id,status,step_number) values ($1,$2,$3)",
    [schedule.rows[0].id, draftStatus, stepNumber],
  );
}

async function seed(db) {
  await db.query("insert into public.campaigns (id) values ($1)", [ids.campaign]);
  await db.query("insert into public.campaign_steps (id,campaign_id) values ($1,$2),($3,$2)", [ids.step1, ids.campaign, ids.step2]);
  await db.query(
    `insert into public.hubspot_contacts (id,email,first_name,last_name) values
      ($1,' Ann@Brokerage.com ','Ann','Agent'),
      ($2,$5,'Ben','Broker'),
      ($3,'cat@brokerage.com','Cat','Closer'),
      ($4,'dan@other.com','Dan','Done')`,
    [ids.ann, ids.ben, ids.cat, ids.dan, benEmail],
  );
  await db.query(
    `insert into public.contact_campaign_enrollments (contact_id,campaign_id,status) values
      ($1,$5,'active'),($2,$5,'active'),($3,$5,'stopped'),($4,$5,'completed')`,
    [ids.ann, ids.ben, ids.cat, ids.dan, ids.campaign],
  );
  await addSend(db, ids.ann, ids.step1, 1, "2026-09-01T10:00:00Z");
  await addPending(db, ids.ann, ids.step2, 2, "approved");
  await addSend(db, ids.ben, ids.step1, 1, "2026-09-02T10:00:00Z");
  await addSend(db, ids.ben, ids.step2, 2, "2026-09-16T10:00:00Z");
  await addPending(db, ids.ben, ids.step2, 3, "draft");
  await addSend(db, ids.cat, ids.step1, 1, "2026-09-03T10:00:00Z");
  await db.query(
    "insert into public.contact_suppression_rules (contact_id,suppression_type,reason,source) values ($1,'bounced','Bounce (address not found) confirmed in PipelineCue by owner@example.com','pipelinecue_manual')",
    [ids.cat],
  );
}

function record(db, emails, outcome = "unsubscribed", note = null) {
  return db.query(
    "select * from public.record_contact_outcomes($1,$2,$3,$4,$5)",
    [emails, outcome, note, "owner@example.com", "2026-10-26T09:00:00.000Z"],
  );
}

async function summary(db) {
  const result = await db.query("select public.pipelinecue_results_summary() as summary");
  return result.rows[0].summary;
}

async function contactState(db, contactId) {
  const result = await db.query(`
    select
      (select is_unsubscribed from public.hubspot_contacts where id=$1) as is_unsubscribed,
      (select status from public.contact_campaign_enrollments where contact_id=$1) as enrollment_status,
      (select string_agg(suppression_type, ',' order by suppression_type) from public.contact_suppression_rules where contact_id=$1 and active) as suppressions,
      (select count(*)::int from public.daily_send_schedule where contact_id=$1 and status in ('scheduled','drafted','reviewed')) as pending_schedules,
      (select count(*)::int from public.email_drafts d join public.daily_send_schedule s on s.id=d.schedule_id
        where s.contact_id=$1 and d.status in ('draft','approved')) as open_drafts,
      (select count(*)::int from public.email_drafts d join public.daily_send_schedule s on s.id=d.schedule_id
        where s.contact_id=$1 and d.status='manually_sent') as sent_drafts
  `, [contactId]);
  return result.rows[0];
}

test("recording an unsubscribe by address stops everything pending and keeps sent history", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const first = await record(db, ["ANN@brokerage.com", "nobody@elsewhere.com"]);
    assert.deepEqual(first.rows, [
      { email: annEmail, result: "recorded", matched_contacts: 1, stopped_enrollments: 1, skipped_schedules: 1, skipped_drafts: 1 },
      { email: "nobody@elsewhere.com", result: "not_found", matched_contacts: 0, stopped_enrollments: 0, skipped_schedules: 0, skipped_drafts: 0 },
    ]);
    assert.deepEqual(await contactState(db, ids.ann), {
      is_unsubscribed: true,
      enrollment_status: "stopped",
      suppressions: "unsubscribed",
      pending_schedules: 0,
      open_drafts: 0,
      sent_drafts: 1,
    });
    const schedule = await db.query("select safety_status from public.daily_send_schedule where contact_id=$1 and status='skipped'", [ids.ann]);
    assert.equal(schedule.rows[0].safety_status, "unsubscribed");

    // Nobody else is touched.
    assert.equal((await contactState(db, ids.ben)).enrollment_status, "active");

    const retry = await record(db, [annEmail]);
    assert.equal(retry.rows[0].result, "already_recorded");
    const count = await db.query("select count(*)::int as count from public.contact_suppression_rules where contact_id=$1", [ids.ann]);
    assert.equal(count.rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test("a reply is recorded with its note and does not mark the contact unsubscribed", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const result = await record(db, [benEmail], "replied", "  Wants pricing  ");
    assert.equal(result.rows[0].result, "recorded");
    const state = await contactState(db, ids.ben);
    assert.equal(state.is_unsubscribed, false);
    assert.equal(state.enrollment_status, "stopped");
    assert.equal(state.suppressions, "replied");
    assert.equal(state.sent_drafts, 2);
    const rule = await db.query("select reason, source from public.contact_suppression_rules where contact_id=$1", [ids.ben]);
    assert.deepEqual(rule.rows[0], {
      reason: "Replied: Wants pricing. Recorded in PipelineCue by owner@example.com",
      source: "pipelinecue_manual",
    });

    const dnc = await record(db, [annEmail], "do_not_contact");
    assert.equal(dnc.rows[0].result, "recorded");
    assert.equal((await contactState(db, ids.ann)).suppressions, "do_not_contact");
    assert.equal((await contactState(db, ids.ann)).is_unsubscribed, false);
  } finally {
    await db.close();
  }
});

test("invalid input is rejected and nothing is recorded", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await assert.rejects(record(db, []), /At least one email address/);
    await assert.rejects(record(db, [annEmail, "not-an-email"]), /Invalid email address/);
    await assert.rejects(record(db, [annEmail], "bounced"), /Unsupported outcome/);
    const many = Array.from({ length: 201 }, (_, index) => `agent${index}@example.com`);
    await assert.rejects(record(db, many), /at most 200/);
    const count = await db.query("select count(*)::int as count from public.contact_suppression_rules where suppression_type <> 'bounced'");
    assert.equal(count.rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test("a downstream failure rolls the whole batch back", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await db.exec(`
      create function pg_temp.reject_draft_update() returns trigger language plpgsql
      as $$ begin raise exception 'injected draft failure'; end $$;
      create trigger reject_draft_update before update on public.email_drafts
      for each row execute function pg_temp.reject_draft_update();
    `);
    await assert.rejects(record(db, [annEmail, benEmail]), /injected draft failure/);
    assert.deepEqual(await contactState(db, ids.ann), {
      is_unsubscribed: false,
      enrollment_status: "active",
      suppressions: null,
      pending_schedules: 1,
      open_drafts: 1,
      sent_drafts: 1,
    });
    assert.equal((await contactState(db, ids.ben)).suppressions, null);
  } finally {
    await db.close();
  }
});

test("the results summary counts sends, bounces, outcomes and brokerages", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await record(db, [benEmail], "replied");
    const result = await summary(db);

    assert.equal(result.agents_emailed, 3);
    assert.equal(result.emails_sent, 4);
    assert.deepEqual(result.sent_by_step, [{ step: 1, sent: 3 }, { step: 2, sent: 1 }]);
    assert.equal(result.agents_completed, 1);
    assert.equal(result.bounced_emailed, 1);
    assert.deepEqual(result.outcome_counts, { bounced: 1, replied: 1 });
    assert.deepEqual(result.bounce_kinds, { "address not found": 1 });
    assert.equal(result.first_sent_at.slice(0, 10), "2026-09-01");
    assert.equal(result.last_sent_at.slice(0, 10), "2026-09-16");
    assert.deepEqual(result.by_domain, [
      { domain: "brokerage.com", agents_emailed: 2, bounced: 1, blocked: 0 },
      { domain: "other.com", agents_emailed: 1, bounced: 0, blocked: 0 },
    ]);
    assert.deepEqual(
      result.stopped_contacts.map((row) => [row.name, row.outcome]).sort(),
      [["Ben Broker", "replied"], ["Cat Closer", "bounced"]],
    );
    assert.deepEqual(result.health, { duplicate_step_sends: 0, stopped_still_active: 0 });
  } finally {
    await db.close();
  }
});

test("the safety check flags duplicates and stopped contacts that are still active", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // A suppression added outside PipelineCue's atomic functions leaves Ann active.
    await db.query("insert into public.contact_suppression_rules (contact_id,suppression_type) values ($1,'unsubscribed')", [ids.ann]);
    await addSend(db, ids.ben, ids.step1, 1, "2026-09-20T10:00:00Z");
    const result = await summary(db);
    assert.deepEqual(result.health, { duplicate_step_sends: 1, stopped_still_active: 1 });
  } finally {
    await db.close();
  }
});

test("browser roles cannot read results or record outcomes, and the helper is internal", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(record(db, [annEmail]), /permission denied/);
      await assert.rejects(summary(db), /permission denied/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    await assert.rejects(
      db.query("select * from public.pipelinecue_apply_outcome_suppression($1,'replied',null,'x',now())", [ids.ann]),
      /permission denied/,
    );
    assert.equal((await summary(db)).agents_emailed, 3);
    assert.equal((await record(db, [annEmail])).rows[0].result, "recorded");
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});

test("results helpers compute rates, domains and messages", () => {
  assert.equal(getBounceRate({ agents_emailed: 183, bounced_emailed: 26 }).toFixed(3), "0.142");
  assert.equal(getBounceRate({ agents_emailed: 0, bounced_emailed: 0 }), null);
  assert.equal(formatPercent(0.1420765), "14.2%");
  assert.equal(formatPercent(null), "–");
  assert.equal(getEmailDomain(" TJ@ListingMediaCT.com "), "listingmediact.com");
  assert.equal(getEmailDomain("no-at-sign"), null);
  assert.equal(getEmailDomain(undefined), null);
  assert.equal(isContactOutcome("replied"), true);
  assert.equal(isContactOutcome("bounced"), false);
  const summaryText = summarizeOutcomeResults([
    { email: "a@x.com", result: "recorded", matched_contacts: 1, stopped_enrollments: 1, skipped_schedules: 0, skipped_drafts: 0 },
    { email: "b@x.com", result: "not_found", matched_contacts: 0, stopped_enrollments: 0, skipped_schedules: 0, skipped_drafts: 0 },
  ], "replied");
  assert.deepEqual(summaryText.notFound, ["b@x.com"]);
  assert.match(summaryText.message, /Recorded as replied: 1 new/);
  assert.match(summaryText.message, /HubSpot was not changed/);
});

test("the owner-only application path uses only the atomic RPCs and no hard-coded sender domain", async () => {
  const [page, route, draftsRoute, library, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/results/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/email-drafts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./results.ts", import.meta.url), "utf8"),
    readFile(migrationUrl, "utf8"),
  ]);

  assert.match(page, /"Results"/);
  assert.match(page, /function ResultsView/);
  assert.match(page, /window\.confirm/);
  assert.doesNotMatch(page, /ownSendingDomains = \["listingmediact\.com"\]/);
  assert.match(route, /authorizeOwner/);
  assert.match(route, /authorization\.user\.email/);
  assert.match(draftsRoute, /ownerDomain/);
  assert.match(library, /\.rpc\("record_contact_outcomes"/);
  assert.match(library, /"pipelinecue_results_summary"/);
  assert.doesNotMatch(library, /\.from\("contact_suppression_rules"\)/);
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = pg_catalog, pg_temp/);
  assert.match(migration, /from public, anon, authenticated;/);
  assert.match(migration, /from public, anon, authenticated, service_role;/);
});
