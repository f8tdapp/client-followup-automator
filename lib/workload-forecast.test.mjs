import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkloadForecast,
  createForecastRequestContext,
  getWorkloadForecast,
  loadAndBuildWorkloadForecast,
  loadWorkloadForecastInput,
} from "./workload-forecast.ts";
import { createWorkloadForecastGetHandler } from "../app/api/workload-forecast/route.ts";

const startDate = "2026-08-01";

function campaign(id = "campaign-1", overrides = {}) {
  return {
    id,
    name: id,
    daily_limit: 25,
    daily_send_limit: 25,
    new_contacts_per_day: 8,
    broker_domain_daily_limit: 25,
    cooldown_days: 14,
    stop_on_reply: true,
    stop_on_bounce: true,
    stop_on_unsubscribe: true,
    ...overrides,
  };
}

function steps(campaignId = "campaign-1", count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${campaignId}-step-${index + 1}`,
    campaign_id: campaignId,
    step_number: index + 1,
    delay_days: index === 0 ? 0 : index === 1 ? 2 : 3,
    subject_template: `Subject ${index + 1}`,
    body_template: `Body ${index + 1}`,
    status: "active",
  }));
}

function enrollment(index, step = 1, campaignId = "campaign-1", due = startDate) {
  return {
    id: `${campaignId}-enrollment-${index}`,
    contact_id: `${campaignId}-contact-${index}`,
    campaign_id: campaignId,
    current_step: step,
    next_send_date: due,
    status: "active",
  };
}

function contact(index, campaignId = "campaign-1", overrides = {}) {
  return {
    id: `${campaignId}-contact-${index}`,
    email: `contact-${index}@domain-${campaignId}-${index}.example`,
    is_unsubscribed: false,
    last_contacted_at: null,
    raw_properties: {},
    ...overrides,
  };
}

function inputFor(enrollments, overrides = {}) {
  const campaignIds = Array.from(
    new Set(enrollments.map((row) => row.campaign_id)),
  );
  return {
    campaigns: campaignIds.map((id) => campaign(id)),
    steps: campaignIds.flatMap((id) => steps(id)),
    enrollments,
    contacts: enrollments.map((row, index) =>
      contact(index, row.campaign_id, { id: row.contact_id }),
    ),
    suppressions: [],
    futureSchedule: [],
    domainLimits: {},
    accountDailyLimit: 25,
    ...overrides,
  };
}

test("initial Email 1 ramp respects eight new contacts per day", () => {
  const forecast = buildWorkloadForecast(
    inputFor(Array.from({ length: 20 }, (_, index) => enrollment(index))),
    startDate,
    3,
  );

  assert.equal(forecast.days[0].stepCounts["1"], 8);
  assert.equal(forecast.days[0].projectedOverflow, 0);
  assert.equal(forecast.days[0].constraints.newContactIntake, 12);
  assert.equal(forecast.days[0].status, "Available capacity");
  assert.equal(forecast.days[1].stepCounts["1"], 8);
  assert.equal(forecast.days[2].stepCounts["1"], 4);
});

test("Email 2 and Email 3 become due from projected send date plus next-step delay", () => {
  const forecast = buildWorkloadForecast(
    inputFor(Array.from({ length: 8 }, (_, index) => enrollment(index))),
    startDate,
    7,
  );

  assert.equal(forecast.days[2].stepCounts["2"], 8);
  assert.equal(forecast.days[5].stepCounts["3"], 8);
});

test("later steps receive priority over Email 1", () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, index) => enrollment(index, 3)),
    ...Array.from({ length: 10 }, (_, index) =>
      enrollment(index + 20, 1),
    ),
  ];
  const forecast = buildWorkloadForecast(inputFor(rows), startDate, 1);

  assert.equal(forecast.days[0].stepCounts["3"], 20);
  assert.equal(forecast.days[0].stepCounts["1"], 5);
});

test("existing future schedule rows consume capacity", () => {
  const rows = Array.from({ length: 10 }, (_, index) => enrollment(index, 2));
  const fixedEnrollments = Array.from({ length: 20 }, (_, index) =>
    enrollment(index + 10, 3),
  );
  const combined = [...rows, ...fixedEnrollments];
  const base = inputFor(combined);
  const futureSchedule = fixedEnrollments.map((row, index) => ({
    id: `schedule-${index}`,
    contact_id: row.contact_id,
    campaign_id: row.campaign_id,
    campaign_step_id: "campaign-1-step-3",
    scheduled_date: startDate,
    broker_domain: `fixed-${index}.example`,
    status: "scheduled",
  }));
  const forecast = buildWorkloadForecast(
    { ...base, futureSchedule },
    startDate,
    1,
  );

  assert.equal(forecast.days[0].totalProjected, 25);
  assert.equal(forecast.days[0].projectedOverflow, 5);
});

test("total scheduled workload remains capped at 25", () => {
  const forecast = buildWorkloadForecast(
    inputFor(Array.from({ length: 40 }, (_, index) => enrollment(index, 2))),
    startDate,
    1,
  );

  assert.equal(forecast.days[0].totalProjected, 25);
});

test("overflow rolls into following forecast dates", () => {
  const forecast = buildWorkloadForecast(
    inputFor(Array.from({ length: 30 }, (_, index) => enrollment(index, 2))),
    startDate,
    2,
  );

  assert.equal(forecast.days[0].projectedOverflow, 5);
  assert.equal(forecast.days[1].rolledForwardBacklog, 5);
  assert.equal(forecast.days[1].stepCounts["2"], 5);
});

test("terminally suppressed contacts are excluded", () => {
  const rows = [enrollment(0), enrollment(1)];
  const base = inputFor(rows);
  const forecast = buildWorkloadForecast(
    {
      ...base,
      suppressions: [
        {
          contact_id: rows[0].contact_id,
          suppression_type: "replied",
          snoozed_until: null,
        },
      ],
    },
    startDate,
    1,
  );

  assert.equal(forecast.days[0].totalProjected, 1);
  assert.equal(forecast.days[0].constraints.terminalSuppression, 1);
  assert.equal(forecast.days[0].constraints.accountCapacityOverflow, 0);
});

test("multiple campaigns share the account capacity", () => {
  const rows = [
    ...Array.from({ length: 25 }, (_, index) =>
      enrollment(index, 2, "campaign-a"),
    ),
    ...Array.from({ length: 25 }, (_, index) =>
      enrollment(index, 2, "campaign-b"),
    ),
  ];
  const forecast = buildWorkloadForecast(inputFor(rows), startDate, 1);

  assert.equal(forecast.days[0].dailyCapacity, 25);
  assert.equal(forecast.days[0].totalProjected, 25);
  assert.equal(forecast.days[0].constraints.accountCapacityOverflow, 25);
});

test("Campaign B Email 3 receives forecast account capacity before Campaign A Email 1", () => {
  const rows = [
    ...Array.from({ length: 25 }, (_, index) =>
      enrollment(index, 1, "campaign-a"),
    ),
    ...Array.from({ length: 10 }, (_, index) =>
      enrollment(index, 3, "campaign-b"),
    ),
  ];
  const base = inputFor(rows);
  base.campaigns = [
    campaign("campaign-a", { new_contacts_per_day: 25 }),
    campaign("campaign-b"),
  ];
  const forecast = buildWorkloadForecast(base, startDate, 1);

  assert.equal(forecast.days[0].stepCounts["3"], 10);
  assert.equal(forecast.days[0].stepCounts["1"], 15);
  assert.equal(forecast.days[0].constraints.accountCapacityOverflow, 10);
  assert.equal(forecast.days[0].constraints.newContactIntake, 0);
});

test("more than 250 enrollments are all forecast", () => {
  const rows = Array.from({ length: 300 }, (_, index) => enrollment(index, 2));
  const forecast = buildWorkloadForecast(
    inputFor(rows, { steps: steps("campaign-1", 2) }),
    startDate,
    20,
  );

  assert.equal(forecast.summary.totalForecastWorkload, 300);
});

test("forecast results are deterministic", () => {
  const source = inputFor(
    Array.from({ length: 60 }, (_, index) =>
      enrollment(index, (index % 3) + 1),
    ),
  );

  assert.deepEqual(
    buildWorkloadForecast(source, startDate, 30),
    buildWorkloadForecast(source, startDate, 30),
  );
});

test("loading and refreshing the forecast performs zero persistence mutations", async () => {
  const source = inputFor([enrollment(0)]);
  const snapshot = structuredClone(source);
  let reads = 0;

  await loadAndBuildWorkloadForecast(async () => {
    reads += 1;
    return source;
  }, startDate);
  await loadAndBuildWorkloadForecast(async () => {
    reads += 1;
    return source;
  }, startDate);

  assert.equal(reads, 2);
  assert.deepEqual(source, snapshot);
});

test("backlog remaining after day 30 is reported", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => enrollment(index, 2));
  const forecast = buildWorkloadForecast(
    inputFor(rows, { steps: steps("campaign-1", 2) }),
    startDate,
    30,
  );

  assert.equal(forecast.summary.projectedBacklogAfter30Days, 250);
});

test("existing scheduled rows advance later steps without duplicating the scheduled step", () => {
  const row = enrollment(0, 1);
  const base = inputFor([row]);
  const forecast = buildWorkloadForecast(
    {
      ...base,
      futureSchedule: [{
        id: "scheduled-email-1",
        contact_id: row.contact_id,
        campaign_id: row.campaign_id,
        campaign_step_id: "campaign-1-step-1",
        scheduled_date: startDate,
        broker_domain: "scheduled.example",
        status: "scheduled",
      }],
    },
    startDate,
    4,
  );

  assert.equal(forecast.days[0].stepCounts["1"], 1);
  assert.equal(forecast.days[2].stepCounts["2"], 1);
  assert.equal(
    forecast.days.reduce((total, day) => total + (day.stepCounts["1"] ?? 0), 0),
    1,
  );
});

test("existing rows consume campaign and broker capacity", () => {
  const due = enrollment(0, 2);
  const fixed = enrollment(1, 2);
  const base = inputFor([due, fixed]);
  base.contacts[0].email = "due@broker.example";
  base.contacts[1].email = "fixed@broker.example";
  base.domainLimits = { "broker.example": 1 };
  base.futureSchedule = [{
    id: "fixed",
    contact_id: fixed.contact_id,
    campaign_id: fixed.campaign_id,
    campaign_step_id: "campaign-1-step-2",
    scheduled_date: startDate,
    broker_domain: "broker.example",
    status: "scheduled",
  }];
  const forecast = buildWorkloadForecast(base, startDate, 1);

  assert.equal(forecast.days[0].totalProjected, 1);
  assert.equal(forecast.days[0].constraints.brokerDomain, 1);
  assert.equal(forecast.days[0].constraints.accountCapacityOverflow, 0);
});

test("campaigns with more than three steps project every configured step", () => {
  const row = enrollment(0);
  const forecast = buildWorkloadForecast(
    inputFor([row], { steps: steps("campaign-1", 4) }),
    startDate,
    10,
  );

  assert.deepEqual(forecast.stepNumbers, [1, 2, 3, 4]);
  assert.equal(forecast.days[8].stepCounts["4"], 1);
});

test("missing email and snooze outcomes are separate from account overflow", () => {
  const rows = [enrollment(0), enrollment(1)];
  const base = inputFor(rows);
  base.contacts[0].email = null;
  base.suppressions = [{
    contact_id: rows[1].contact_id,
    suppression_type: "snoozed",
    snoozed_until: "2026-08-02",
  }];
  const forecast = buildWorkloadForecast(base, startDate, 4);

  assert.equal(forecast.days[0].constraints.safetyEligibility, 2);
  assert.equal(forecast.days[0].constraints.accountCapacityOverflow, 0);
  assert.equal(forecast.days[1].constraints.safetyEligibility, 2);
  assert.equal(forecast.days[2].stepCounts["1"], 1);
});

test("snooze follows coordinator roll-forward semantics on every active day", () => {
  const row = enrollment(0);
  const base = inputFor([row]);
  base.suppressions = [{
    contact_id: row.contact_id,
    suppression_type: "snoozed",
    snoozed_until: "2026-08-02",
    reason: "Paused by user.",
  }];
  const forecast = buildWorkloadForecast(base, startDate, 4);

  assert.equal(forecast.days[0].constraints.safetyEligibility, 1);
  assert.equal(forecast.days[1].constraints.safetyEligibility, 1);
  assert.equal(forecast.days[2].stepCounts["1"], 1);
  assert.equal(forecast.days[0].projectedOverflow, 0);
});

test("virtual legacy repairs cover missing starter-step combinations deterministically", () => {
  const scenarios = [
    [],
    steps().filter((step) => step.step_number !== 2),
    steps().filter((step) => step.step_number !== 3),
    [
      steps()[0],
      { ...steps()[1], subject_template: "Email 2: placeholder" },
    ],
  ];

  for (const [index, existingSteps] of scenarios.entries()) {
    const row = enrollment(index, 1);
    const source = inputFor([row], { steps: existingSteps });
    const first = buildWorkloadForecast(source, startDate, 30);
    const second = buildWorkloadForecast(source, startDate, 30);

    assert.deepEqual(first.stepNumbers, [1, 2, 3]);
    assert.deepEqual(first, second);
    assert.equal(first.days[0].stepCounts["1"], 1);
    assert.equal(
      first.days.reduce((total, day) => total + (day.stepCounts["2"] ?? 0), 0),
      1,
    );
  }
});

function duplicateScheduleRows(row, scheduleDates) {
  return scheduleDates.map((scheduledDate, index) => ({
    id: `duplicate-${String(index).padStart(2, "0")}`,
    contact_id: row.contact_id,
    campaign_id: row.campaign_id,
    campaign_step_id: "campaign-1-step-1",
    scheduled_date: scheduledDate,
    broker_domain: "duplicates.example",
    status: "scheduled",
  }));
}

test("duplicate existing rows all consume capacity but advance only canonical earliest row", () => {
  const row = enrollment(0, 1);
  const base = inputFor([row]);
  const duplicates = duplicateScheduleRows(row, [
    "2026-08-02",
    "2026-08-01",
    "2026-08-03",
  ]);
  const forward = buildWorkloadForecast(
    { ...base, futureSchedule: duplicates },
    startDate,
    18,
  );
  const reversed = buildWorkloadForecast(
    { ...base, futureSchedule: [...duplicates].reverse() },
    startDate,
    18,
  );

  assert.deepEqual(forward, reversed);
  assert.equal(
    forward.days.reduce((total, day) => total + (day.stepCounts["1"] ?? 0), 0),
    3,
  );
  assert.equal(
    forward.days.reduce((total, day) => total + (day.stepCounts["2"] ?? 0), 0),
    1,
  );
  assert.equal(forward.days[2].stepCounts["2"], 1);
});

test("later existing step suppresses duplicate progression from Email 1", () => {
  const row = enrollment(0, 1);
  const base = inputFor([row]);
  const futureSchedule = [
    ...duplicateScheduleRows(row, ["2026-08-01", "2026-08-02"]),
    {
      id: "existing-email-2",
      contact_id: row.contact_id,
      campaign_id: row.campaign_id,
      campaign_step_id: "campaign-1-step-2",
      scheduled_date: "2026-08-04",
      broker_domain: "duplicates.example",
      status: "scheduled",
    },
  ];
  const forecast = buildWorkloadForecast(
    { ...base, futureSchedule },
    startDate,
    30,
  );

  assert.equal(
    forecast.days.reduce((total, day) => total + (day.stepCounts["2"] ?? 0), 0),
    1,
  );
  assert.equal(forecast.days[0].totalProjected, 1);
  assert.equal(forecast.days[1].totalProjected, 1);
  assert.equal(forecast.days[3].totalProjected, 1);
});

test("cooldown uses the captured request time on every projected date", () => {
  const row = enrollment(0);
  const base = inputFor([row]);
  base.contacts[0].last_contacted_at = "2026-07-18T18:00:00.000Z";

  const beforeExpiry = buildWorkloadForecast(
    base,
    createForecastRequestContext("2026-08-01T12:00:00.000Z", 2),
  );
  const afterExpiry = buildWorkloadForecast(
    base,
    createForecastRequestContext("2026-08-01T20:00:00.000Z", 2),
  );

  assert.equal(beforeExpiry.days[0].constraints.safetyEligibility, 1);
  assert.equal(beforeExpiry.days[1].stepCounts["1"], 1);
  assert.equal(afterExpiry.days[0].stepCounts["1"], 1);
});

test("empty forecast has no busiest date, reduction, or capacity warning", () => {
  const forecast = buildWorkloadForecast(
    {
      campaigns: [],
      steps: [],
      enrollments: [],
      contacts: [],
      suppressions: [],
      futureSchedule: [],
      domainLimits: {},
      accountDailyLimit: 25,
    },
    startDate,
    30,
  );

  assert.equal(forecast.summary.busiestDate, null);
  assert.equal(forecast.recommendation, "No projected workload.");
  assert.ok(forecast.days.every((day) => day.status === "Available capacity"));
});

test("recommendations identify the constrained campaign", () => {
  const rows = Array.from({ length: 80 }, (_, index) =>
    enrollment(index, 1, "campaign-a"),
  );
  const base = inputFor(rows);
  base.campaigns[0] = campaign("campaign-a", {
    name: "Real Estate Agent Follow-Up",
    new_contacts_per_day: 8,
  });
  const forecast = buildWorkloadForecast(base, startDate, 3);

  assert.match(
    forecast.recommendation,
    /Reduce Real Estate Agent Follow-Up from 8 to \d+ new contacts per day/,
  );
});

function createReadOnlySupabaseFixture(futureRowCount = 251, enrollmentRows = []) {
  const futureRows = Array.from({ length: futureRowCount }, (_, index) => ({
    id: `schedule-${String(index).padStart(4, "0")}`,
    contact_id: `contact-${index}`,
    campaign_id: "campaign-1",
    campaign_step_id: "campaign-1-step-1",
    scheduled_date: startDate,
    broker_domain: `domain-${index}.example`,
    status: "scheduled",
  }));
  const contacts = futureRows.map((row, index) =>
    contact(index, "campaign-1", { id: row.contact_id }),
  );
  const calls = [];
  let writes = 0;

  const supabase = {
    from(table) {
      const state = { table, range: null, contactIds: null, upperDueDate: null };
      const query = {
        select() { calls.push(`select:${table}`); return query; },
        eq() { return query; },
        gte(column, value) { calls.push(`gte:${column}:${value}`); return query; },
        lte(column, value) {
          calls.push(`lte:${column}:${value}`);
          if (column === "next_send_date") state.upperDueDate = value;
          return query;
        },
        order() { return query; },
        limit() { return query; },
        in(column, values) {
          if (column === "id") state.contactIds = values;
          return query;
        },
        range(from, to) { state.range = [from, to]; return query; },
        insert() { writes += 1; throw new Error("write attempted"); },
        update() { writes += 1; throw new Error("write attempted"); },
        upsert() { writes += 1; throw new Error("write attempted"); },
        delete() { writes += 1; throw new Error("write attempted"); },
        async returns() {
          if (table === "campaigns") return { data: [campaign()], error: null };
          if (table === "sending_settings") {
            return { data: [{ daily_send_limit: 25 }], error: null };
          }
          if (table === "campaign_steps") {
            return { data: steps("campaign-1", 2), error: null };
          }
          if (table === "broker_domain_limits") return { data: [], error: null };
          if (table === "contact_campaign_enrollments") {
            const [from, to] = state.range;
            return {
              data: enrollmentRows
                .filter((row) => row.next_send_date <= state.upperDueDate)
                .slice(from, to + 1),
              error: null,
            };
          }
          if (table === "daily_send_schedule") {
            const [from, to] = state.range;
            return { data: futureRows.slice(from, to + 1), error: null };
          }
          if (table === "hubspot_contacts") {
            return {
              data: contacts.filter((row) => state.contactIds.includes(row.id)),
              error: null,
            };
          }
          if (table === "contact_suppression_rules") {
            return { data: [], error: null };
          }
          throw new Error(`Unexpected read: ${table}`);
        },
      };
      return query;
    },
    rpc() { writes += 1; throw new Error("write-producing RPC attempted"); },
  };

  return { supabase, calls, get writes() { return writes; } };
}

test("production loader paginates bounded future rows and performs zero writes", async () => {
  const fixture = createReadOnlySupabaseFixture();
  const context = createForecastRequestContext(
    "2026-08-01T12:00:00.000Z",
    30,
  );
  const input = await loadWorkloadForecastInput(context, fixture.supabase);

  assert.equal(input.futureSchedule.length, 251);
  assert.ok(fixture.calls.includes("gte:scheduled_date:2026-08-01"));
  assert.ok(fixture.calls.includes("lte:scheduled_date:2026-08-30"));
  assert.equal(
    fixture.calls.filter((call) => call === "select:daily_send_schedule").length,
    2,
  );
  assert.equal(fixture.writes, 0);
});

test("active enrolments beyond the horizon are excluded before contact lookups", async () => {
  const inside = enrollment(900, 1, "campaign-1", "2026-08-30");
  const outside = enrollment(901, 1, "campaign-1", "2026-08-31");
  const fixture = createReadOnlySupabaseFixture(0, [inside, outside]);
  const context = createForecastRequestContext(
    "2026-08-01T12:00:00.000Z",
    30,
  );
  const input = await loadWorkloadForecastInput(context, fixture.supabase);

  assert.deepEqual(input.enrollments.map((row) => row.id), [inside.id]);
  assert.ok(fixture.calls.includes("lte:next_send_date:2026-08-30"));
  assert.equal(input.contacts.some((row) => row.id === outside.contact_id), false);
  assert.equal(fixture.writes, 0);
});

test("production forecast dependency and GET refresh remain read-only", async () => {
  const fixture = createReadOnlySupabaseFixture(2);
  const context = createForecastRequestContext(
    "2026-08-01T12:00:00.000Z",
    30,
  );
  const load = () => getWorkloadForecast(context, fixture.supabase);
  const GET = createWorkloadForecastGetHandler(load);

  const first = await GET();
  const second = await GET();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(fixture.writes, 0);
});
