import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../supabase/migrations/015_atomic_manual_send_hotfix.sql",
  import.meta.url,
);

const ids = {
  campaign: "00000000-0000-4000-8000-000000000001",
  contact: "00000000-0000-4000-8000-000000000002",
  enrollment: "00000000-0000-4000-8000-000000000003",
  step1: "00000000-0000-4000-8000-000000000004",
  step2: "00000000-0000-4000-8000-000000000005",
  schedule: "00000000-0000-4000-8000-000000000006",
  draft: "00000000-0000-4000-8000-000000000007",
};

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon noinherit;
    create role authenticated noinherit;
    create role service_role noinherit;

    create table public.campaigns (
      id uuid primary key
    );

    create table public.hubspot_contacts (
      id uuid primary key
    );

    create table public.campaign_steps (
      id uuid primary key,
      campaign_id uuid not null references public.campaigns(id),
      step_number integer not null,
      delay_days integer not null default 0,
      subject_template text not null default '',
      body_template text not null default '',
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table public.contact_campaign_enrollments (
      id uuid primary key,
      contact_id uuid not null references public.hubspot_contacts(id),
      campaign_id uuid not null references public.campaigns(id),
      current_step integer not null default 1,
      status text not null default 'active',
      next_send_date date not null,
      last_sent_at timestamptz,
      completed_at timestamptz,
      stopped_reason text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (contact_id, campaign_id)
    );

    create table public.daily_send_schedule (
      id uuid primary key,
      contact_id uuid not null references public.hubspot_contacts(id),
      campaign_id uuid not null references public.campaigns(id),
      campaign_step_id uuid not null references public.campaign_steps(id),
      scheduled_date date not null,
      broker_domain text not null default 'example.com',
      status text not null default 'scheduled',
      reason text not null default 'Ready for Email 1.',
      safety_status text not null default 'safe',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table public.email_drafts (
      id uuid primary key,
      schedule_id uuid not null references public.daily_send_schedule(id),
      campaign_id uuid references public.campaigns(id),
      campaign_step_id uuid references public.campaign_steps(id),
      step_number integer,
      status text not null,
      manually_sent_at timestamptz,
      manually_sent_note text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    grant all privileges on all tables in schema public to service_role;
  `);
  await db.exec(await readFile(migrationUrl, "utf8"));
  return db;
}

async function seedDraft(db, { finalStep = false } = {}) {
  await db.query("insert into public.campaigns (id) values ($1)", [ids.campaign]);
  await db.query("insert into public.hubspot_contacts (id) values ($1)", [ids.contact]);
  await db.query(
    "insert into public.campaign_steps (id,campaign_id,step_number,delay_days) values ($1,$2,$3,$4)",
    [finalStep ? ids.step2 : ids.step1, ids.campaign, finalStep ? 2 : 1, 0],
  );
  if (!finalStep) {
    await db.query(
      "insert into public.campaign_steps (id,campaign_id,step_number,delay_days) values ($1,$2,2,3)",
      [ids.step2, ids.campaign],
    );
  }
  await db.query(
    "insert into public.contact_campaign_enrollments (id,contact_id,campaign_id,current_step,next_send_date) values ($1,$2,$3,$4,'2026-08-01')",
    [ids.enrollment, ids.contact, ids.campaign, finalStep ? 2 : 1],
  );
  await db.query(
    "insert into public.daily_send_schedule (id,contact_id,campaign_id,campaign_step_id,scheduled_date) values ($1,$2,$3,$4,'2026-09-04')",
    [ids.schedule, ids.contact, ids.campaign, finalStep ? ids.step2 : ids.step1],
  );
  await db.query(
    "insert into public.email_drafts (id,schedule_id,campaign_id,campaign_step_id,step_number,status) values ($1,$2,$3,$4,$5,'approved')",
    [ids.draft, ids.schedule, ids.campaign, finalStep ? ids.step2 : ids.step1, finalStep ? 2 : 1],
  );
}

async function recordSent(db, sentAt = "2026-09-04T10:00:00.000Z") {
  return db.query(
    "select * from public.mark_email_draft_manually_sent($1,$2,$3)",
    [ids.draft, sentAt, "Sent in Gmail"],
  );
}

test("atomic migration advances Email 1, completes schedule, and never advances twice", async () => {
  const db = await createDatabase();
  try {
    await seedDraft(db);

    const first = await recordSent(db);
    assert.equal(first.rows[0].result, "recorded");

    const state = await db.query(`
      select
        drafts.status as draft_status,
        drafts.manually_sent_at,
        schedules.status as schedule_status,
        enrollments.status as enrollment_status,
        enrollments.current_step,
        enrollments.last_sent_at,
        enrollments.next_send_date
      from public.email_drafts drafts
      join public.daily_send_schedule schedules on schedules.id = drafts.schedule_id
      join public.contact_campaign_enrollments enrollments
        on enrollments.contact_id = schedules.contact_id
       and enrollments.campaign_id = schedules.campaign_id
      where drafts.id = $1
    `, [ids.draft]);
    assert.deepEqual(
      {
        ...state.rows[0],
        manually_sent_at: state.rows[0].manually_sent_at.toISOString(),
        last_sent_at: state.rows[0].last_sent_at.toISOString(),
        next_send_date: state.rows[0].next_send_date.toISOString().slice(0, 10),
      },
      {
        draft_status: "manually_sent",
        manually_sent_at: "2026-09-04T10:00:00.000Z",
        schedule_status: "manually_sent",
        enrollment_status: "active",
        current_step: 2,
        last_sent_at: "2026-09-04T10:00:00.000Z",
        next_send_date: "2026-09-07",
      },
    );

    const retry = await recordSent(db, "2026-09-05T10:00:00.000Z");
    assert.equal(retry.rows[0].result, "already_recorded");
    const afterRetry = await db.query(
      "select current_step,last_sent_at,next_send_date from public.contact_campaign_enrollments where id=$1",
      [ids.enrollment],
    );
    assert.equal(afterRetry.rows[0].current_step, 2);
    assert.equal(afterRetry.rows[0].last_sent_at.toISOString(), "2026-09-04T10:00:00.000Z");
    assert.equal(
      afterRetry.rows[0].next_send_date.toISOString().slice(0, 10),
      "2026-09-07",
    );
  } finally {
    await db.close();
  }
});

test("atomic migration completes the final campaign step", async () => {
  const db = await createDatabase();
  try {
    await seedDraft(db, { finalStep: true });
    const result = await recordSent(db);
    assert.equal(result.rows[0].result, "recorded");

    const enrollment = await db.query(
      "select status,current_step,last_sent_at,completed_at from public.contact_campaign_enrollments where id=$1",
      [ids.enrollment],
    );
    assert.equal(enrollment.rows[0].status, "completed");
    assert.equal(enrollment.rows[0].current_step, 2);
    assert.equal(enrollment.rows[0].last_sent_at.toISOString(), "2026-09-04T10:00:00.000Z");
    assert.equal(enrollment.rows[0].completed_at.toISOString(), "2026-09-04T10:00:00.000Z");
  } finally {
    await db.close();
  }
});

test("retry repairs the confirmed legacy partial-write state exactly once", async () => {
  const db = await createDatabase();
  try {
    await seedDraft(db);
    await db.query(
      "update public.email_drafts set status='manually_sent',manually_sent_at=$1 where id=$2",
      ["2026-08-30T09:05:25.000Z", ids.draft],
    );

    const repaired = await recordSent(db, "2026-09-04T10:00:00.000Z");
    assert.equal(repaired.rows[0].result, "repaired");
    const enrollment = await db.query(
      "select current_step,last_sent_at,next_send_date from public.contact_campaign_enrollments where id=$1",
      [ids.enrollment],
    );
    assert.equal(enrollment.rows[0].current_step, 2);
    assert.equal(enrollment.rows[0].last_sent_at.toISOString(), "2026-08-30T09:05:25.000Z");
    assert.equal(
      enrollment.rows[0].next_send_date.toISOString().slice(0, 10),
      "2026-09-02",
    );

    const retry = await recordSent(db, "2026-09-05T10:00:00.000Z");
    assert.equal(retry.rows[0].result, "already_recorded");
    assert.equal(retry.rows[0].enrollment_step, 2);
  } finally {
    await db.close();
  }
});

test("any enrollment failure rolls back draft and schedule mutations", async () => {
  const db = await createDatabase();
  try {
    await seedDraft(db);
    await db.exec(`
      create function pg_temp.reject_enrollment_update()
      returns trigger
      language plpgsql
      as $$ begin raise exception 'injected enrollment failure'; end $$;
      create trigger reject_enrollment_update
      before update on public.contact_campaign_enrollments
      for each row execute function pg_temp.reject_enrollment_update();
    `);

    await assert.rejects(recordSent(db), /injected enrollment failure/);

    const draft = await db.query(
      "select status,manually_sent_at from public.email_drafts where id=$1",
      [ids.draft],
    );
    const schedule = await db.query(
      "select status from public.daily_send_schedule where id=$1",
      [ids.schedule],
    );
    assert.deepEqual(draft.rows[0], { status: "approved", manually_sent_at: null });
    assert.equal(schedule.rows[0].status, "scheduled");
  } finally {
    await db.close();
  }
});

test("browser roles cannot execute the RPC while service_role can", async () => {
  const db = await createDatabase();
  try {
    await seedDraft(db);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(recordSent(db), /permission denied/);
      await db.exec("reset role");
    }

    await db.exec("set role service_role");
    const result = await recordSent(db);
    assert.equal(result.rows[0].result, "recorded");
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});
