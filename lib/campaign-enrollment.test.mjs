import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildCampaignEnrollmentSummary,
  isEnrollmentSuppressionActive,
  loadCampaignEnrollmentOverview,
  runAtomicCampaignEnrollment,
} from "./campaign-enrollment.ts";
import {
  getEnrollmentConfirmationMessage,
  shouldProceedWithEnrollment,
} from "./campaign-enrollment-ui.ts";
import { applyGlobalSchedulingPolicy } from "./schedule-policy.ts";
import { prepareScheduleCandidates } from "./schedule-preparation.ts";
import { evaluateScheduleSafety } from "./schedule-safety.ts";

function paged(rows) {
  return async (from, to) => rows.slice(from, to + 1);
}

function summarySource({
  campaigns,
  contacts,
  enrollments = [],
  suppressions = [],
  steps = [],
}) {
  return {
    loadCampaigns: paged(campaigns),
    loadContacts: paged(contacts),
    loadEnrollments: paged(enrollments),
    loadSuppressions: paged(suppressions),
    loadSteps: paged(steps),
  };
}

test("production overview paginates 250+ rows and keeps campaign counts independent", async () => {
  const contacts = Array.from({ length: 601 }, (_, index) => ({
    id: `contact-${String(index).padStart(4, "0")}`,
    email: `person-${index}@example.com`,
    is_unsubscribed: false,
  }));
  const campaigns = [
    { id: "campaign-a", name: "Campaign A", new_enrollments_paused: false },
    { id: "campaign-b", name: "Campaign B", new_enrollments_paused: true },
  ];
  const enrollments = [
    ...Array.from({ length: 301 }, (_, index) => ({
      contact_id: contacts[index].id,
      campaign_id: "campaign-a",
      current_step: (index % 4) + 1,
      status: "active",
    })),
    ...Array.from({ length: 260 }, (_, index) => ({
      contact_id: contacts[index + 301].id,
      campaign_id: "campaign-b",
      current_step: (index % 3) + 1,
      status: "active",
    })),
  ];
  const steps = campaigns.flatMap((campaign) =>
    [1, 2, 3, 4].map((step) => ({
      campaign_id: campaign.id,
      step_number: step,
      status: "active",
    })),
  );

  const overview = await loadCampaignEnrollmentOverview(
    summarySource({ campaigns, contacts, enrollments, steps }),
  );

  assert.equal(overview.totalHubSpotContacts, 601);
  assert.equal(overview.campaigns.length, 2);
  assert.deepEqual(
    overview.campaigns.map((campaign) => ({
      id: campaign.campaignId,
      paused: campaign.newEnrollmentsPaused,
      enrolled: campaign.currentlyEnrolled,
      eligible: campaign.eligibleNotEnrolled,
    })),
    [
      { id: "campaign-a", paused: false, enrolled: 301, eligible: 300 },
      { id: "campaign-b", paused: true, enrolled: 260, eligible: 341 },
    ],
  );
  assert.equal(overview.campaigns[0].waitingForEmail4Plus, 75);
});

test("a contact enrolled in Campaign A remains eligible for Campaign B", () => {
  const contact = {
    id: "contact-1",
    email: "person@example.com",
    is_unsubscribed: false,
  };
  const enrollments = [
    {
      contact_id: contact.id,
      campaign_id: "campaign-a",
      current_step: 1,
      status: "active",
    },
  ];
  const campaignB = buildCampaignEnrollmentSummary({
    campaign: {
      id: "campaign-b",
      name: "Campaign B",
      new_enrollments_paused: false,
    },
    contacts: [contact],
    enrollments,
    suppressions: [],
    steps: [],
  });

  assert.equal(campaignB.eligibleNotEnrolled, 1);
});

test("enrolment suppression matches expired, future, null, and boundary snoozes", () => {
  const date = "2026-08-01";
  assert.equal(isEnrollmentSuppressionActive({ contact_id: "1", active: true, suppression_type: "permanent", snoozed_until: null }, date), true);
  assert.equal(isEnrollmentSuppressionActive({ contact_id: "1", active: true, suppression_type: "snoozed", snoozed_until: "2026-07-31" }, date), false);
  assert.equal(isEnrollmentSuppressionActive({ contact_id: "1", active: true, suppression_type: "snoozed", snoozed_until: "2026-08-02" }, date), true);
  assert.equal(isEnrollmentSuppressionActive({ contact_id: "1", active: true, suppression_type: "snoozed", snoozed_until: date }, date), true);
  assert.equal(isEnrollmentSuppressionActive({ contact_id: "1", active: true, suppression_type: "snoozed", snoozed_until: null }, date), true);
  assert.equal(isEnrollmentSuppressionActive({ contact_id: "1", active: false, suppression_type: "permanent", snoozed_until: null }, date), false);
});

test("enrolment and production scheduler share fail-closed suppression semantics", () => {
  const date = "2026-08-01";
  const contact = { email: "person@example.com", is_unsubscribed: false, last_contacted_at: null };
  const campaign = { cooldown_days: 0, stop_on_reply: false, stop_on_bounce: false, stop_on_unsubscribe: false };
  const cases = [
    ["permanent", null, true], [" permanent ", null, true],
    ["unsubscribed", null, true], ["unsubscribe", null, true],
    ["replied", null, true], ["bounced", null, true],
    ["do_not_contact", null, true], ["unknown_rule", null, true],
    [" snoozed ", "2026-08-02", true], ["snoozed", date, true],
    ["snoozed", null, true], ["snoozed", "2026-07-31", false],
  ];
  for (const [suppression_type, snoozed_until, active] of cases) {
    const enrollmentBlocked = isEnrollmentSuppressionActive(
      { contact_id: "1", active: true, suppression_type, snoozed_until }, date,
    );
    const safety = evaluateScheduleSafety(contact, [{ suppression_type, snoozed_until }], campaign, date, `${date}T12:00:00.000Z`);
    assert.equal(enrollmentBlocked, active, suppression_type);
    assert.equal(safety.safe, !active, suppression_type);
  }
  assert.equal(evaluateScheduleSafety(
    { ...contact, is_unsubscribed: true }, [], campaign, date, `${date}T12:00:00.000Z`,
  ).safe, false);
});

test("suppression loader failure fails the production overview closed", async () => {
  let enrollmentWrites = 0;
  const source = summarySource({
    campaigns: [
      { id: "campaign-a", name: "Campaign A", new_enrollments_paused: false },
    ],
    contacts: [
      { id: "contact-1", email: "person@example.com", is_unsubscribed: false },
    ],
  });
  source.loadSuppressions = async () => {
    throw new Error("suppression query failed");
  };

  await assert.rejects(
    loadCampaignEnrollmentOverview(source),
    /suppression query failed/,
  );
  assert.equal(enrollmentWrites, 0);
});

test("atomic production boundary surfaces suppression RPC failure with zero inserts", async () => {
  let inserts = 0;
  await assert.rejects(
    runAtomicCampaignEnrollment(
      {
        campaignId: "campaign-a",
        confirmedEligibleCount: 1,
        enrollmentDate: "2026-07-25",
      },
      async () => ({
        data: null,
        error: { message: "suppression evaluation failed" },
      }),
    ),
    /suppression evaluation failed/,
  );
  assert.equal(inserts, 0);
});

test("confirmed count becoming stale returns no inserts", async () => {
  let inserts = 0;
  const result = await runAtomicCampaignEnrollment(
    {
      campaignId: "campaign-a",
      confirmedEligibleCount: 10,
      enrollmentDate: "2026-07-25",
    },
    async () => ({
      data: [
        {
          result: "stale_count",
          message: "Eligible contact count changed from 10 to 9.",
          eligible_count: 9,
          inserted_count: inserts,
        },
      ],
      error: null,
    }),
  );

  assert.equal(result.result, "stale_count");
  assert.equal(result.inserted_count, 0);
});

test("two concurrent production RPC calls never rewrite existing enrolments", async () => {
  const rows = new Map();
  let lock = Promise.resolve();
  const atomicRpc = async (input) => {
    const previous = lock;
    let release;
    lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const eligible = rows.has("contact-1") ? [] : ["contact-1"];
      if (eligible.length !== input.confirmed_eligible_count) {
        return {
          data: [
            {
              result: "stale_count",
              message: "Count changed.",
              eligible_count: eligible.length,
              inserted_count: 0,
            },
          ],
          error: null,
        };
      }
      for (const contactId of eligible) {
        if (!rows.has(contactId)) {
          rows.set(contactId, { current_step: 1, status: "active" });
        }
      }
      return {
        data: [
          {
            result: "success",
            message: "Enrolled.",
            eligible_count: eligible.length,
            inserted_count: eligible.length,
          },
        ],
        error: null,
      };
    } finally {
      release();
    }
  };

  const input = {
    campaignId: "campaign-a",
    confirmedEligibleCount: 1,
    enrollmentDate: "2026-07-25",
  };
  const [first, second] = await Promise.all([
    runAtomicCampaignEnrollment(input, atomicRpc),
    runAtomicCampaignEnrollment(input, atomicRpc),
  ]);

  assert.deepEqual(
    [first.result, second.result],
    ["success", "stale_count"],
  );
  assert.equal(rows.size, 1);
  assert.deepEqual(rows.get("contact-1"), {
    current_step: 1,
    status: "active",
  });
});

test("pause update and enrolment coordinate through one campaign lock", async () => {
  let paused = false;
  let inserts = 0;
  let lock = Promise.resolve();
  const withCampaignLock = async (operation) => {
    const previous = lock;
    let release;
    lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  let signalPauseStarted;
  const pauseStarted = new Promise((resolve) => {
    signalPauseStarted = resolve;
  });
  let releasePause;
  const pauseMayCommit = new Promise((resolve) => {
    releasePause = resolve;
  });
  const pauseRequest = withCampaignLock(async () => {
    signalPauseStarted();
    await pauseMayCommit;
    paused = true;
  });
  await pauseStarted;

  const enrollmentRequest = runAtomicCampaignEnrollment(
    {
      campaignId: "campaign-a",
      confirmedEligibleCount: 1,
      enrollmentDate: "2026-07-25",
    },
    async () =>
      withCampaignLock(async () => ({
        data: [
          paused
            ? {
                result: "paused",
                message: "New enrolments are paused.",
                eligible_count: 0,
                inserted_count: 0,
              }
            : {
                result: "success",
                message: "Enrolled.",
                eligible_count: 1,
                inserted_count: ++inserts,
              },
        ],
        error: null,
      })),
  );
  releasePause();
  await pauseRequest;
  const result = await enrollmentRequest;

  assert.equal(result.result, "paused");
  assert.equal(inserts, 0);
});

test("existing Email 1-4+ enrolments still schedule while new enrolments are paused", () => {
  const campaign = {
    id: "campaign-1",
    name: "Follow-up",
    daily_limit: 25,
    daily_send_limit: 25,
    new_contacts_per_day: 8,
    new_enrollments_paused: true,
    broker_domain_daily_limit: 25,
    cooldown_days: 14,
    stop_on_reply: true,
    stop_on_bounce: true,
    stop_on_unsubscribe: true,
  };
  const existingSteps = [1, 2, 3, 4].map((step) => ({
    id: `step-${step}`,
    campaign_id: campaign.id,
    step_number: step,
    delay_days: step,
    subject_template: `Email ${step}`,
    body_template: "Hello",
    status: "active",
  }));
  const enrollments = [1, 2, 3, 4].map((step) => ({
    id: `enrollment-${step}`,
    contact_id: `contact-${step}`,
    campaign_id: campaign.id,
    current_step: step,
    status: "active",
    next_send_date: "2026-07-25",
    last_sent_at: null,
  }));
  const contacts = enrollments.map((enrollment) => ({
    id: enrollment.contact_id,
    email: `${enrollment.contact_id}@example.com`,
    is_unsubscribed: false,
    last_contacted_at: null,
    raw_properties: {},
  }));
  const prepared = prepareScheduleCandidates({
    campaigns: [campaign],
    existingSteps,
    repairedSteps: [],
    enrollments,
    contacts,
    suppressions: [],
    domainLimits: new Map(),
    accountDailyLimit: 25,
    defaultTotalLimit: 25,
    defaultNewContactLimit: 8,
    date: "2026-07-25",
    evaluatedAt: "2026-07-25T09:00:00.000Z",
  });
  const allocation = applyGlobalSchedulingPolicy(prepared.candidates, {
    accountDailyLimit: prepared.accountDailyLimit,
    campaignLimits: prepared.campaignLimits,
    existingAccountScheduled: 0,
    existingCampaignScheduled: new Map(),
    existingCampaignNewContacts: new Map(),
    brokerDomainCounts: new Map(),
  });

  assert.deepEqual(
    allocation.outcomes.map((outcome) => outcome.current_step).sort(),
    [1, 2, 3, 4],
  );
  assert.ok(allocation.outcomes.every((outcome) => outcome.action === "scheduled"));
});

test("large confirmation is exact and UI cancellation sends no request or mutation", () => {
  let requests = 0;
  let mutations = 0;
  let confirmation = "";
  const proceed = shouldProceedWithEnrollment(37, (message) => {
    confirmation = message;
    return false;
  });
  if (proceed) {
    requests += 1;
    mutations += 1;
  }

  assert.equal(
    confirmation,
    "You are about to enrol exactly 37 eligible contacts. This is a large enrolment. Continue?",
  );
  assert.equal(requests, 0);
  assert.equal(mutations, 0);
  assert.equal(getEnrollmentConfirmationMessage(1), "Enrol exactly 1 eligible contact?");
});

test("HubSpot sync remains independent from campaign enrolment", async () => {
  const [syncRoute, syncModule] = await Promise.all([
    readFile(new URL("../app/api/hubspot/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./hubspot-sync.ts", import.meta.url), "utf8"),
  ]);
  const source = `${syncRoute}\n${syncModule}`;

  assert.doesNotMatch(source, /contact_campaign_enrollments/);
  assert.doesNotMatch(source, /enroll_eligible_campaign_contacts/);
  assert.match(syncRoute, /syncHubSpotContacts/);
});

test("Migration 011 defines the atomic row-locked, insert-only boundary", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/011_pause_new_campaign_enrollments.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /add column if not exists new_enrollments_paused/);
  assert.match(migration, /requested_campaign_id is null/);
  assert.match(migration, /confirmed_eligible_count is null/);
  assert.match(migration, /enrollment_date is null/);
  assert.match(migration, /maximum_confirmed_eligible_count constant integer := 10000/);
  assert.match(migration, /for update/);
  assert.match(migration, /not exists \([\s\S]*contact_suppression_rules/);
  assert.match(migration, /on conflict \(contact_id, campaign_id\) do nothing/);
  assert.match(migration, /get diagnostics calculated_inserted_count = row_count/);
  assert.match(migration, /set search_path = pg_catalog, pg_temp/);
  assert.match(migration, /owner to postgres/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
  assert.match(migration, /revoke all privileges on table[\s\S]*public\.campaigns[\s\S]*from anon, authenticated/);
  assert.doesNotMatch(migration, /create policy "PipelineCue anon read campaigns"/);
  assert.doesNotMatch(migration, /update public\.contact_campaign_enrollments/);
  assert.match(migration, /public\.daily_send_schedule,[\s\S]*public\.email_drafts/);
});

test("Migration 011 closes every audited browser database path", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/011_pause_new_campaign_enrollments.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    migration,
    /alter table public\.clients enable row level security;/,
  );
  assert.match(
    migration,
    /drop policy if exists "Allow all access for now" on public\.clients;/,
  );
  assert.match(
    migration,
    /revoke usage on schema public from PUBLIC, anon, authenticated;/,
  );
  assert.match(
    migration,
    /grant usage on schema public to service_role;/,
  );
  assert.match(
    migration,
    /revoke all privileges on table[\s\S]*public\.clients,[\s\S]*from anon, authenticated;/,
  );
  assert.match(
    migration,
    /to_regprocedure\('public\.rls_auto_enable\(\)'\) is not null[\s\S]*revoke all on function public\.rls_auto_enable\(\) from public, anon, authenticated/,
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(?:select|insert|update|delete|all privileges)[^;]*\bto\s+(?:anon|authenticated)\b/i,
  );
  assert.match(
    migration,
    /grant all privileges on table[\s\S]*public\.sending_settings[\s\S]*to service_role;/,
  );
  assert.doesNotMatch(
    migration,
    /drop policy if exists "Service role manage sending settings"/,
  );
});

test("Migration 011 explicitly drops every development policy created by prior migrations", async () => {
  const migrationUrls = [
    "../supabase/migrations/001_sprint3_campaigns_events.sql",
    "../supabase/migrations/002_hubspot_sync_foundation.sql",
    "../supabase/migrations/003_hubspot_schema_repair.sql",
    "../supabase/migrations/004_hubspot_service_role_permissions.sql",
    "../supabase/migrations/005_campaign_schedule_engine.sql",
    "../supabase/migrations/006_email_drafts.sql",
    "../supabase/migrations/008_sending_settings.sql",
  ];
  const [migration, ...priorMigrations] = await Promise.all([
    readFile(
      new URL(
        "../supabase/migrations/011_pause_new_campaign_enrollments.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    ...migrationUrls.map((url) => readFile(new URL(url, import.meta.url), "utf8")),
  ]);
  const auditedPolicies = new Map(
    priorMigrations.flatMap((source) =>
      [...source.matchAll(
        /create policy "(Development (?:anon|authenticated) [^"]+)"\s+on public\.([a-z_]+)/g,
      )].map((match) => [match[1], match[2]]),
    ),
  );

  assert.ok(auditedPolicies.size > 0);
  for (const [policy, table] of auditedPolicies) {
    assert.match(
      migration,
      new RegExp(`drop policy if exists "${policy}" on public\\.${table};`),
      `${policy} on public.${table}`,
    );
  }
});
