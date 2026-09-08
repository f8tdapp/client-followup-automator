import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../supabase/migrations/016_atomic_manual_unsubscribe.sql",
  import.meta.url,
);

const ids = {
  campaign: "00000000-0000-4000-8000-000000000101",
  contact: "00000000-0000-4000-8000-000000000102",
  enrollment: "00000000-0000-4000-8000-000000000103",
  step: "00000000-0000-4000-8000-000000000104",
  schedule: "00000000-0000-4000-8000-000000000105",
  draft: "00000000-0000-4000-8000-000000000106",
  sentSchedule: "00000000-0000-4000-8000-000000000107",
  sentDraft: "00000000-0000-4000-8000-000000000108",
};

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon noinherit;
    create role authenticated noinherit;
    create role service_role noinherit;
    create table public.campaigns (id uuid primary key);
    create table public.hubspot_contacts (
      id uuid primary key,
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
  await db.query("insert into public.hubspot_contacts (id) values ($1)", [ids.contact]);
  await db.query("insert into public.campaign_steps (id,campaign_id) values ($1,$2)", [ids.step, ids.campaign]);
  await db.query("insert into public.contact_campaign_enrollments (id,contact_id,campaign_id) values ($1,$2,$3)", [ids.enrollment, ids.contact, ids.campaign]);
  await db.query("insert into public.daily_send_schedule (id,contact_id,campaign_id,campaign_step_id) values ($1,$2,$3,$4)", [ids.schedule, ids.contact, ids.campaign, ids.step]);
  await db.query("insert into public.email_drafts (id,schedule_id,status) values ($1,$2,'approved')", [ids.draft, ids.schedule]);
  await db.query("insert into public.daily_send_schedule (id,contact_id,campaign_id,campaign_step_id,status) values ($1,$2,$3,$4,'manually_sent')", [ids.sentSchedule, ids.contact, ids.campaign, ids.step]);
  await db.query("insert into public.email_drafts (id,schedule_id,status) values ($1,$2,'manually_sent')", [ids.sentDraft, ids.sentSchedule]);
}

async function unsubscribe(db) {
  return db.query(
    "select * from public.mark_email_draft_contact_unsubscribed($1,$2,$3)",
    [ids.draft, "owner@example.com", "2026-09-08T14:00:00.000Z"],
  );
}

test("manual unsubscribe atomically suppresses, stops, and clears pending outreach", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const first = await unsubscribe(db);
    assert.equal(first.rows[0].result, "recorded");
    assert.equal(first.rows[0].stopped_enrollments, 1);
    assert.equal(first.rows[0].skipped_schedules, 1);
    assert.equal(first.rows[0].skipped_drafts, 1);

    const state = await db.query(`
      select contacts.is_unsubscribed, enrollments.status as enrollment_status,
        schedules.status as schedule_status, schedules.safety_status,
        drafts.status as draft_status, suppressions.suppression_type,
        suppressions.source, suppressions.reason
      from public.hubspot_contacts contacts
      join public.contact_campaign_enrollments enrollments on enrollments.contact_id=contacts.id
      join public.daily_send_schedule schedules on schedules.contact_id=contacts.id
      join public.email_drafts drafts on drafts.schedule_id=schedules.id
      join public.contact_suppression_rules suppressions on suppressions.contact_id=contacts.id
      where contacts.id=$1 and drafts.id=$2
    `, [ids.contact, ids.draft]);
    assert.deepEqual(state.rows[0], {
      is_unsubscribed: true,
      enrollment_status: "stopped",
      schedule_status: "skipped",
      safety_status: "unsubscribed",
      draft_status: "skipped",
      suppression_type: "unsubscribed",
      source: "pipelinecue_manual",
      reason: "Unsubscribe confirmed in PipelineCue by owner@example.com",
    });
    const sentHistory = await db.query(`
      select drafts.status as draft_status, schedules.status as schedule_status
      from public.email_drafts drafts
      join public.daily_send_schedule schedules on schedules.id=drafts.schedule_id
      where drafts.id=$1
    `, [ids.sentDraft]);
    assert.deepEqual(sentHistory.rows[0], {
      draft_status: "manually_sent",
      schedule_status: "manually_sent",
    });

    const retry = await unsubscribe(db);
    assert.equal(retry.rows[0].result, "already_recorded");
    const count = await db.query("select count(*)::int as count from public.contact_suppression_rules");
    assert.equal(count.rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test("browser roles cannot execute manual unsubscribe", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(unsubscribe(db), /permission denied/);
      await db.exec("reset role");
    }
  } finally {
    await db.close();
  }
});

test("a downstream failure rolls the entire unsubscribe operation back", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await db.exec(`
      create function pg_temp.reject_schedule_update() returns trigger language plpgsql
      as $$ begin raise exception 'injected schedule failure'; end $$;
      create trigger reject_schedule_update before update on public.daily_send_schedule
      for each row execute function pg_temp.reject_schedule_update();
    `);
    await assert.rejects(unsubscribe(db), /injected schedule failure/);
    const contact = await db.query("select is_unsubscribed from public.hubspot_contacts where id=$1", [ids.contact]);
    const enrollment = await db.query("select status from public.contact_campaign_enrollments where id=$1", [ids.enrollment]);
    const suppressions = await db.query("select count(*)::int as count from public.contact_suppression_rules");
    assert.equal(contact.rows[0].is_unsubscribed, false);
    assert.equal(enrollment.rows[0].status, "active");
    assert.equal(suppressions.rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test("the owner-only application path confirms the action and uses only the atomic RPC", async () => {
  const [page, route, library, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/email-drafts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./email-drafts.ts", import.meta.url), "utf8"),
    readFile(migrationUrl, "utf8"),
  ]);

  assert.match(page, /Mark Unsubscribed/);
  assert.match(page, /window\.confirm/);
  assert.match(page, /It does not update HubSpot/);
  assert.match(route, /authorizeOwner/);
  assert.match(route, /authorization\.user\.email/);
  assert.match(library, /\.rpc\("mark_email_draft_contact_unsubscribed"/);
  assert.doesNotMatch(library, /\.from\("contact_suppression_rules"\)/);
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = pg_catalog, pg_temp/);
  assert.match(migration, /from public, anon, authenticated/);
  assert.match(migration, /to service_role/);
});
