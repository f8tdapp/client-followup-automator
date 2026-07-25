import assert from "node:assert/strict";
import test from "node:test";
import {
  applySchedulingPolicy,
  generateUnlessPlanExists,
  loadAllDeterministicPages,
  persistScheduleOutcomes,
  runTwoPhaseGeneration,
} from "./schedule-policy.ts";

function candidates(step, count, options = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${options.prefix ?? `s${step}`}-${String(index).padStart(4, "0")}`,
    enrollmentId: `enrollment-${step}-${index}`,
    contactId: `contact-${step}-${index}`,
    campaignId: "campaign-1",
    campaignStepId: `step-${step}`,
    current_step: step,
    next_send_date: options.dueDate ?? `2026-07-${String((index % 28) + 1).padStart(2, "0")}`,
    brokerDomain: options.domain ?? `domain-${step}-${index}.example`,
    brokerDomainLimit: options.domainLimit ?? 25,
    restriction: options.restriction ?? { kind: "safe" },
  }));
}

function runPolicy(rows, overrides = {}) {
  return applySchedulingPolicy(rows, {
    totalDailyLimit: 25,
    newContactsPerDay: 8,
    ...overrides,
  });
}

test("production policy gives later steps priority and caps total at 25", () => {
  const result = runPolicy([
    ...candidates(1, 12),
    ...candidates(2, 10),
    ...candidates(3, 10),
  ]);

  assert.equal(result.outcomes.filter((row) => row.action === "scheduled").length, 25);
  assert.deepEqual(
    result.outcomes.slice(0, 20).map((row) => row.current_step),
    [...Array(10).fill(3), ...Array(10).fill(2)],
  );
});

test("production policy uses oldest due date and stable ID within a step", () => {
  const rows = [
    ...candidates(2, 1, { prefix: "later", dueDate: "2026-07-03" }),
    ...candidates(2, 1, { prefix: "b", dueDate: "2026-07-01" }),
    ...candidates(2, 1, { prefix: "a", dueDate: "2026-07-01" }),
  ];
  const result = runPolicy(rows);

  assert.deepEqual(
    result.outcomes.map((row) => row.id),
    ["a-0000", "b-0000", "later-0000"],
  );
});

test("production policy caps Email 1 at 8", () => {
  const result = runPolicy(candidates(1, 20));

  assert.equal(result.outcomes.filter((row) => row.action === "scheduled").length, 8);
  assert.equal(
    result.outcomes.filter(
      (row) => row.safetyStatus === "new_contact_limit_reached",
    ).length,
    12,
  );
});

test("follow-ups consume capacity before Email 1", () => {
  const result = runPolicy([...candidates(1, 8), ...candidates(2, 22)]);
  const scheduled = result.outcomes.filter((row) => row.action === "scheduled");

  assert.equal(scheduled.length, 25);
  assert.equal(scheduled.filter((row) => row.current_step === 1).length, 3);
});

test("suppression and broker-domain restrictions affect production policy", () => {
  const stopped = candidates(3, 1, {
    restriction: {
      kind: "stop",
      reason: "Unsubscribed.",
      safetyStatus: "unsubscribed",
    },
  });
  const snoozed = candidates(2, 1, {
    restriction: {
      kind: "roll_forward",
      reason: "Snoozed.",
      safetyStatus: "snoozed",
    },
  });
  const domainRows = candidates(2, 4, {
    prefix: "domain",
    domain: "broker.example",
    domainLimit: 2,
  });
  const result = runPolicy([...domainRows, ...stopped, ...snoozed]);

  assert.equal(
    result.outcomes.filter(
      (row) => row.safetyStatus === "broker_domain_limit_reached",
    ).length,
    2,
  );
  assert.equal(
    result.outcomes.find((row) => row.safetyStatus === "unsubscribed")?.action,
    "stop",
  );
  assert.equal(
    result.outcomes.find((row) => row.safetyStatus === "snoozed")?.action,
    "roll_forward",
  );
});

test("more than 250 due enrollments are all accounted for", () => {
  const result = runPolicy(candidates(3, 601));

  assert.equal(result.outcomes.length, 601);
  assert.equal(result.outcomes.filter((row) => row.action === "scheduled").length, 25);
  assert.equal(
    result.outcomes.filter(
      (row) => row.safetyStatus === "campaign_limit_reached",
    ).length,
    576,
  );
});

test("deterministic pagination loads every row beyond 250", async () => {
  const source = Array.from({ length: 601 }, (_, index) => index);
  const calls = [];
  const rows = await loadAllDeterministicPages(async (from, to) => {
    calls.push([from, to]);
    return source.slice(from, to + 1);
  }, 250);

  assert.deepEqual(calls, [
    [0, 249],
    [250, 499],
    [500, 749],
  ]);
  assert.deepEqual(rows, source);
});

test("multiple campaigns load every page before the first write", async () => {
  const events = [];
  const result = await runTwoPhaseGeneration({
    prepare: async () => {
      const campaigns = [];

      for (const campaignId of ["campaign-a", "campaign-b"]) {
        const rows = await loadAllDeterministicPages(async (from, to) => {
          events.push(`read:${campaignId}:${from}-${to}`);
          return from === 0
            ? Array.from({ length: 250 }, (_, index) => index)
            : [250];
        }, 250);
        campaigns.push({ campaignId, rows });
      }

      return campaigns;
    },
    persist: async (prepared) => {
      events.push("write:first");
      return prepared;
    },
  });

  assert.equal(result.length, 2);
  assert.deepEqual(events, [
    "read:campaign-a:0-249",
    "read:campaign-a:250-499",
    "read:campaign-b:0-249",
    "read:campaign-b:250-499",
    "write:first",
  ]);
});

test("Campaign B page failure causes zero writes for every campaign", async () => {
  let writes = 0;

  await assert.rejects(
    runTwoPhaseGeneration({
      prepare: async () => {
        await loadAllDeterministicPages(async () => [1], 250);
        await loadAllDeterministicPages(async () => {
          throw new Error("Campaign B failed");
        }, 250);
      },
      persist: async () => {
        writes += 1;
      },
    }),
    /Campaign B failed/,
  );

  assert.equal(writes, 0);
});

test("campaign-step repairs wait until every campaign enrollment page loads", async () => {
  const events = [];

  await runTwoPhaseGeneration({
    prepare: async () => {
      events.push("repair:calculated");
      events.push("read:campaign-a");
      events.push("read:campaign-b");
      return { repairs: ["step-1"] };
    },
    persist: async ({ repairs }) => {
      events.push(`repair:persisted:${repairs[0]}`);
    },
  });

  assert.deepEqual(events, [
    "repair:calculated",
    "read:campaign-a",
    "read:campaign-b",
    "repair:persisted:step-1",
  ]);
});

test("601+ enrollments across multiple campaigns are fully accounted for", async () => {
  const prepared = await runTwoPhaseGeneration({
    prepare: async () => [
      candidates(3, 301, { prefix: "campaign-a" }),
      candidates(2, 302, { prefix: "campaign-b" }),
    ],
    persist: async (campaignRows) =>
      campaignRows.flatMap((rows) => runPolicy(rows).outcomes),
  });

  assert.equal(prepared.length, 603);
  assert.equal(
    prepared.filter((outcome) => outcome.action === "scheduled").length,
    50,
  );
});

test("production persistence boundary writes every outcome and applies mutations", async () => {
  const policy = runPolicy([
    ...candidates(2, 2, {
      prefix: "domain",
      domain: "broker.example",
      domainLimit: 1,
    }),
    ...candidates(3, 1, {
      restriction: {
        kind: "stop",
        reason: "Unsubscribed.",
        safetyStatus: "unsubscribed",
      },
    }),
  ]);
  const writes = [];
  const rollForwards = [];
  const stops = [];

  await persistScheduleOutcomes(policy.outcomes, {
    writeSchedule: async (outcome) => writes.push(outcome.id),
    rollForwardEnrollment: async (outcome) =>
      rollForwards.push(outcome.enrollmentId),
    stopEnrollment: async (outcome) => stops.push(outcome.enrollmentId),
  });

  assert.equal(writes.length, policy.outcomes.length);
  assert.equal(rollForwards.length, 1);
  assert.equal(stops.length, 1);
});

test("an existing plan is returned unchanged with no mutations", async () => {
  const existingSchedule = [{ id: "schedule-1", status: "scheduled" }];
  const existingDrafts = [{ id: "draft-1", schedule_id: "schedule-1" }];
  const plan = {
    schedule: existingSchedule,
    counts: { total: 1 },
    drafts: existingDrafts,
  };
  let generationCalls = 0;

  const result = await generateUnlessPlanExists({
    hasExistingPlan: async () => true,
    loadExistingPlan: async () => plan,
    generateNewPlan: async () => {
      generationCalls += 1;
      throw new Error("must not generate");
    },
  });

  assert.strictEqual(result, plan);
  assert.strictEqual(result.schedule, existingSchedule);
  assert.strictEqual(result.drafts, existingDrafts);
  assert.equal(generationCalls, 0);
});

test("a rerun performs no enrollment roll-forwards or other mutations", async () => {
  let scheduleWrites = 0;
  let enrollmentWrites = 0;

  await generateUnlessPlanExists({
    hasExistingPlan: async () => true,
    loadExistingPlan: async () => ({ schedule: [{ id: "existing" }] }),
    generateNewPlan: async () => {
      scheduleWrites += 1;
      enrollmentWrites += 1;
      return { schedule: [] };
    },
  });

  assert.equal(scheduleWrites, 0);
  assert.equal(enrollmentWrites, 0);
});

test("repeated generation returns identical rows and counts", async () => {
  let storedPlan;
  let generationCalls = 0;
  const run = () =>
    generateUnlessPlanExists({
      hasExistingPlan: async () => Boolean(storedPlan),
      loadExistingPlan: async () => structuredClone(storedPlan),
      generateNewPlan: async () => {
        generationCalls += 1;
        storedPlan = {
          schedule: [{ id: "schedule-1", step: 3 }],
          counts: { email3: 1, total: 1 },
        };
        return structuredClone(storedPlan);
      },
    });

  const first = await run();
  const second = await run();

  assert.deepEqual(second, first);
  assert.equal(generationCalls, 1);
});
