import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  parseBounceEmailInput,
  summarizeBounceResults,
} from "./bounce-recording.ts";

const migrationUrl = new URL(
  "../supabase/migrations/017_atomic_manual_bounce.sql",
  import.meta.url,
);

const ids = {
  campaign: "00000000-0000-4000-8000-000000000201",
  contact: "00000000-0000-4000-8000-000000000202",
  enrollment: "00000000-0000-4000-8000-000000000203",
  step: "00000000-0000-4000-8000-000000000204",
  schedule: "00000000-0000-4000-8000-000000000205",
  draft: "00000000-0000-4000-8000-000000000206",
  sentSchedule: "00000000-0000-4000-8000-000000000207",
  sentDraft: "00000000-0000-4000-8000-000000000208",
  otherContact: "00000000-0000-4000-8000-000000000209",
  otherEnrollment: "00000000-0000-4000-8000-000000000210",
  otherSchedule: "00000000-0000-4000-8000-000000000211",
  otherDraft: "00000000-0000-4000-8000-000000000212",
};

const bouncedEmail = "agent@brokerage.com";
const otherEmail = "keeper@brokerage.com";

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
      is_unsubscribed boolean not null default false,
      updated_at timestamptz not null default now()
    );
    create table public.campaign_steps (
      id uuid primary key,
      campaign_id uuid not null references public.campaigns(id)
    );
    create table public.contact_campaign_enrollments (
      id uuid primary key,
      contact_id uuid not null references public.hubspot_contacts(id),
      campaign_id uuid not null references public.campaigns(id),
      status text not null default 'active',
      stopped_reason text,
      completed_at timestamptz,
      updated_at timestamptz not null default now()
    );
    create table public.daily_send_schedule (
      id uuid primary key,
      contact_id uuid not null references public.hubspot_contacts(id),
      campaign_id uuid not null references public.campaigns(id),
      campaign_step_id uuid not null references public.campaign_steps(id),
      status text not null default 'scheduled',
      reason text not null default 'Ready.',
      safety_status text not null default 'safe',
      updated_at timestamptz not null default now()
    );
    create table public.email_drafts (
      id uuid primary key,
      schedule_id uuid not null references public.daily_send_schedule(id),
      status text not null default 'draft',
      approved_at timestamptz,
      skipped_at timestamptz,
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

async function seed(db) {
  await db.query("insert into public.campaigns (id) values ($1)", [ids.campaign]);
  await db.query("insert into public.campaign_steps (id,campaign_id) values ($1,$2)", [ids.step, ids.campaign]);
  // Stored with mixed case and whitespace, as HubSpot sometimes returns it.
  await db.query("insert into public.hubspot_contacts (id,email) values ($1,$2)", [ids.contact, "  Agent@Brokerage.com "]);
  await db.query("insert into public.hubspot_contacts (id,email) values ($1,$2)", [ids.otherContact, otherEmail]);
  await db.query("insert into public.contact_campaign_enrollments (id,contact_id,campaign_id) values ($1,$2,$3)", [ids.enrollment, ids.contact, ids.campaign]);
  await db.query("insert into public.contact_campaign_enrollments (id,contact_id,campaign_id) values ($1,$2,$3)", [ids.otherEnrollment, ids.otherContact, ids.campaign]);
  await db.query("insert into public.daily_send_schedule (id,contact_id,campaign_id,campaign_step_id) values ($1,$2,$3,$4)", [ids.schedule, ids.contact, ids.campaign, ids.step]);
  await db.query("insert into public.email_drafts (id,schedule_id,status) values ($1,$2,'approved')", [ids.draft, ids.schedule]);
  await db.query("insert into public.daily_send_schedule (id,contact_id,campaign_id,campaign_step_id,status) values ($1,$2,$3,$4,'manually_sent')", [ids.sentSchedule, ids.contact, ids.campaign, ids.step]);
  await db.query("insert into public.email_drafts (id,schedule_id,status) values ($1,$2,'manually_sent')", [ids.sentDraft, ids.sentSchedule]);
  await db.query("insert into public.daily_send_schedule (id,contact_id,campaign_id,campaign_step_id) values ($1,$2,$3,$4)", [ids.otherSchedule, ids.otherContact, ids.campaign, ids.step]);
  await db.query("insert into public.email_drafts (id,schedule_id,status) values ($1,$2,'draft')", [ids.otherDraft, ids.otherSchedule]);
}

function markDraftBounced(db, kind = "address_not_found") {
  return db.query(
    "select * from public.mark_email_draft_contact_bounced($1,$2,$3,$4)",
    [ids.draft, kind, "owner@example.com", "2026-10-26T09:00:00.000Z"],
  );
}

function recordBounces(db, emails, kind = "blocked") {
  return db.query(
    "select * from public.record_contact_bounces($1,$2,$3,$4)",
    [emails, kind, "owner@example.com", "2026-10-26T09:00:00.000Z"],
  );
}

async function contactState(db, contactId) {
  const result = await db.query(`
    select
      (select status from public.contact_campaign_enrollments where contact_id=$1) as enrollment_status,
      (select count(*)::int from public.contact_suppression_rules
        where contact_id=$1 and suppression_type='bounced' and active) as bounce_rules,
      (select count(*)::int from public.email_drafts d
        join public.daily_send_schedule s on s.id=d.schedule_id
        where s.contact_id=$1 and d.status in ('draft','approved')) as open_drafts,
      (select count(*)::int from public.email_drafts d
        join public.daily_send_schedule s on s.id=d.schedule_id
        where s.contact_id=$1 and d.status='manually_sent') as sent_drafts
  `, [contactId]);
  return result.rows[0];
}

test("marking a draft bounced suppresses the contact, stops the campaign and keeps sent history", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const first = await markDraftBounced(db);
    assert.equal(first.rows[0].result, "recorded");
    assert.equal(first.rows[0].contact_id, ids.contact);
    assert.equal(first.rows[0].stopped_enrollments, 1);
    assert.equal(first.rows[0].skipped_schedules, 1);
    assert.equal(first.rows[0].skipped_drafts, 1);

    assert.deepEqual(await contactState(db, ids.contact), {
      enrollment_status: "stopped",
      bounce_rules: 1,
      open_drafts: 0,
      sent_drafts: 1,
    });

    const rule = await db.query("select reason, source from public.contact_suppression_rules where contact_id=$1", [ids.contact]);
    assert.deepEqual(rule.rows[0], {
      reason: "Bounce (address not found) confirmed in PipelineCue by owner@example.com",
      source: "pipelinecue_manual",
    });
    const schedule = await db.query("select status, safety_status from public.daily_send_schedule where id=$1", [ids.schedule]);
    assert.deepEqual(schedule.rows[0], { status: "skipped", safety_status: "bounced" });

    // Bouncing a contact never touches anyone else.
    assert.deepEqual(await contactState(db, ids.otherContact), {
      enrollment_status: "active",
      bounce_rules: 0,
      open_drafts: 1,
      sent_drafts: 0,
    });

    const retry = await markDraftBounced(db);
    assert.equal(retry.rows[0].result, "already_recorded");
    const count = await db.query("select count(*)::int as count from public.contact_suppression_rules");
    assert.equal(count.rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test("recording bounces by address matches case-insensitively and reports unknown addresses", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const result = await recordBounces(db, [
      " AGENT@brokerage.com",
      "agent@brokerage.com",
      "nobody@elsewhere.com",
    ]);
    assert.deepEqual(result.rows, [
      {
        email: bouncedEmail,
        result: "recorded",
        matched_contacts: 1,
        stopped_enrollments: 1,
        skipped_schedules: 1,
        skipped_drafts: 1,
      },
      {
        email: "nobody@elsewhere.com",
        result: "not_found",
        matched_contacts: 0,
        stopped_enrollments: 0,
        skipped_schedules: 0,
        skipped_drafts: 0,
      },
    ]);
    const rule = await db.query("select reason from public.contact_suppression_rules where contact_id=$1", [ids.contact]);
    assert.equal(rule.rows[0].reason, "Bounce (message blocked by recipient server) confirmed in PipelineCue by owner@example.com");
    assert.equal((await contactState(db, ids.otherContact)).enrollment_status, "active");

    const retry = await recordBounces(db, [bouncedEmail]);
    assert.equal(retry.rows[0].result, "already_recorded");
  } finally {
    await db.close();
  }
});

test("an existing unsubscribe does not count as a bounce", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await db.query("insert into public.contact_suppression_rules (contact_id,suppression_type) values ($1,'unsubscribed')", [ids.contact]);
    const result = await recordBounces(db, [bouncedEmail], "mailbox_full");
    assert.equal(result.rows[0].result, "recorded");
  } finally {
    await db.close();
  }
});

test("invalid input is rejected and nothing is recorded", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await assert.rejects(recordBounces(db, []), /At least one email address/);
    await assert.rejects(recordBounces(db, [bouncedEmail, "not-an-email"]), /Invalid email address/);
    await assert.rejects(recordBounces(db, [bouncedEmail], "angry"), /Unsupported bounce kind/);
    const many = Array.from({ length: 201 }, (_, index) => `agent${index}@example.com`);
    await assert.rejects(recordBounces(db, many), /at most 200/);
    const count = await db.query("select count(*)::int as count from public.contact_suppression_rules");
    assert.equal(count.rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test("a downstream failure rolls the whole bounce batch back", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await db.exec(`
      create function pg_temp.reject_draft_update() returns trigger language plpgsql
      as $$ begin raise exception 'injected draft failure'; end $$;
      create trigger reject_draft_update before update on public.email_drafts
      for each row execute function pg_temp.reject_draft_update();
    `);
    await assert.rejects(recordBounces(db, [bouncedEmail, otherEmail]), /injected draft failure/);
    assert.deepEqual(await contactState(db, ids.contact), {
      enrollment_status: "active",
      bounce_rules: 0,
      open_drafts: 1,
      sent_drafts: 1,
    });
    assert.equal((await contactState(db, ids.otherContact)).bounce_rules, 0);
  } finally {
    await db.close();
  }
});

test("browser roles cannot record bounces or call the internal helper", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(markDraftBounced(db), /permission denied/);
      await assert.rejects(recordBounces(db, [bouncedEmail]), /permission denied/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    await assert.rejects(
      db.query("select * from public.pipelinecue_apply_bounce_suppression($1,'other','x',now())", [ids.contact]),
      /permission denied/,
    );
    const allowed = await recordBounces(db, [bouncedEmail]);
    assert.equal(allowed.rows[0].result, "recorded");
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});

test("pasted bounce notices yield only the bounced contact addresses", () => {
  const pasted = `
    Mail Delivery Subsystem <mailer-daemon@googlemail.com>
    Address not found
    Your message wasn't delivered to Suzanne@VanderBlue.com because the address couldn't be found.
    From: TJ Muldoon <tj@listingmediact.com>
    Message blocked: Your message to martina.burin@raveis.com has been blocked.
    martina.burin@raveis.com, orlando.diaz@cbrealty.com
    postmaster@raveis.com
  `;
  assert.deepEqual(parseBounceEmailInput(pasted, ["listingmediact.com"]), [
    "martina.burin@raveis.com",
    "orlando.diaz@cbrealty.com",
    "suzanne@vanderblue.com",
  ]);
  assert.deepEqual(parseBounceEmailInput("  \n "), []);
});

test("bounce summaries count each outcome", () => {
  const summary = summarizeBounceResults([
    { email: "a@x.com", result: "recorded", matched_contacts: 1, stopped_enrollments: 1, skipped_schedules: 1, skipped_drafts: 1 },
    { email: "b@x.com", result: "already_recorded", matched_contacts: 1, stopped_enrollments: 0, skipped_schedules: 0, skipped_drafts: 0 },
    { email: "c@x.com", result: "not_found", matched_contacts: 0, stopped_enrollments: 0, skipped_schedules: 0, skipped_drafts: 0 },
  ]);
  assert.equal(summary.recorded, 1);
  assert.equal(summary.alreadyRecorded, 1);
  assert.deepEqual(summary.notFound, ["c@x.com"]);
  assert.match(summary.message, /HubSpot was not changed/);
});

test("the owner-only application path confirms the action and uses only the atomic RPCs", async () => {
  const [page, route, library, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/email-drafts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./email-drafts.ts", import.meta.url), "utf8"),
    readFile(migrationUrl, "utf8"),
  ]);

  assert.match(page, /Mark Bounced/);
  assert.match(page, /Record Bounces/);
  assert.match(route, /"mark_bounced"/);
  assert.match(route, /"record_bounces"/);
  assert.match(route, /authorizeOwner/);
  assert.match(library, /\.rpc\("mark_email_draft_contact_bounced"/);
  assert.match(library, /\.rpc\("record_contact_bounces"/);
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = pg_catalog, pg_temp/);
  assert.match(migration, /from public, anon, authenticated;/);
  assert.match(migration, /to service_role/);
});
