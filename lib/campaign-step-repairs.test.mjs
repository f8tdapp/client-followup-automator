import assert from "node:assert/strict";
import test from "node:test";
import {
  createVirtualRepairedSteps,
  getDefaultCampaignStep,
  mergeCampaignSteps,
  planCampaignStepRepairs,
} from "./campaign-step-repairs.ts";

const updatedAt = "2026-08-01T12:00:00.000Z";
const campaign = { id: "campaign-1" };

function step(number, overrides = {}) {
  return {
    id: `database-uuid-${number}`,
    campaign_id: campaign.id,
    step_number: number,
    delay_days: number === 1 ? 0 : number === 2 ? 14 : 30,
    subject_template: `Subject ${number}`,
    body_template: `Body ${number}`,
    status: "active",
    ...overrides,
  };
}

test("pure repair planning covers missing Email 1-3 without writes", () => {
  const source = [];
  const repairs = planCampaignStepRepairs([campaign], source, updatedAt);
  const virtual = createVirtualRepairedSteps(source, repairs);

  assert.deepEqual(repairs.map((row) => row.step_number), [1, 2, 3]);
  assert.ok(
    virtual.every((row) =>
      row.id.startsWith("forecast-virtual-step:campaign-1:"),
    ),
  );
  assert.deepEqual(source, []);
});

test("Email 4+ placeholder and blank steps are never rewritten", () => {
  const laterSteps = [
    step(4, {
      delay_days: 7,
      subject_template: "Email 4: placeholder",
      body_template: "Keep Email 4",
      status: "active",
    }),
    step(5, {
      delay_days: 11,
      subject_template: "",
      body_template: "",
      status: "inactive",
    }),
  ];
  const snapshot = structuredClone(laterSteps);
  const repairs = planCampaignStepRepairs([campaign], laterSteps, updatedAt);

  assert.deepEqual(repairs.map((row) => row.step_number), [1, 2, 3]);
  assert.deepEqual(laterSteps, snapshot);
  assert.equal(new Set(repairs.map((row) => `${row.campaign_id}:${row.step_number}`)).size, repairs.length);
});

test("valid Email 4 survives mixed input ordering with missing starter steps", () => {
  const email4 = step(4, {
    delay_days: 9,
    subject_template: "Fourth touch",
    body_template: "Still original",
    status: "active",
  });
  const existing = [email4, step(2), step(1)].reverse();
  const repairs = planCampaignStepRepairs([campaign], existing, updatedAt);
  const merged = mergeCampaignSteps(
    existing,
    createVirtualRepairedSteps(existing, repairs),
  );

  assert.deepEqual(
    merged.find((row) => row.step_number === 4),
    email4,
  );
  assert.deepEqual(repairs.map((row) => row.step_number), [3]);
});

test("unsupported default campaign steps fail safely", () => {
  assert.throws(() => getDefaultCampaignStep(4), RangeError);
  assert.throws(() => getDefaultCampaignStep(0), RangeError);
});

test("repair planning preserves database ID for placeholder repair and virtualizes only missing rows", () => {
  const existing = [
    step(1),
    step(2, { subject_template: "Email 2: placeholder" }),
  ];
  const repairs = planCampaignStepRepairs([campaign], existing, updatedAt);
  const virtual = createVirtualRepairedSteps(existing, repairs);
  const merged = mergeCampaignSteps(existing, virtual);

  assert.equal(
    merged.find((row) => row.step_number === 2).id,
    "database-uuid-2",
  );
  assert.equal(
    merged.find((row) => row.step_number === 3).id,
    "forecast-virtual-step:campaign-1:3",
  );
  assert.deepEqual(existing[1], step(2, { subject_template: "Email 2: placeholder" }));
});
