import assert from "node:assert/strict";
import test from "node:test";
import { planCampaignStepRepairs } from "./campaign-step-repairs.ts";
import {
  allocatePreparedDailyGeneration,
  getNextActiveStep,
  getNextProjectedDueDate,
  getOutcomeConstraintCategory,
} from "./schedule-preparation.ts";
import {
  buildWorkloadForecast,
  createForecastRequestContext,
} from "./workload-forecast.ts";

const date = "2026-08-01";
const requestedAt = "2026-08-01T12:00:00.000Z";

function campaign(id, overrides = {}) {
  return {
    id,
    name: id,
    daily_limit: 25,
    daily_send_limit: 25,
    new_contacts_per_day: 8,
    broker_domain_daily_limit: 3,
    cooldown_days: 14,
    stop_on_reply: true,
    stop_on_bounce: true,
    stop_on_unsubscribe: true,
    ...overrides,
  };
}

function step(campaignId, number, overrides = {}) {
  return {
    id: `${campaignId}-step-${number}`,
    campaign_id: campaignId,
    step_number: number,
    delay_days: number === 1 ? 0 : number * 2,
    subject_template: `Subject ${number}`,
    body_template: `Body ${number}`,
    status: "active",
    ...overrides,
  };
}

function contact(id, domain = "example.com", overrides = {}) {
  return {
    id,
    email: `${id}@${domain}`,
    is_unsubscribed: false,
    last_contacted_at: null,
    raw_properties: {},
    ...overrides,
  };
}

function enrollment(id, campaignId, currentStep) {
  return {
    id,
    contact_id: id,
    campaign_id: campaignId,
    current_step: currentStep,
    next_send_date: date,
    status: "active",
  };
}

function semanticCandidate(row, activeSteps) {
  const nextStep = getNextActiveStep(
    activeSteps,
    row.campaignId,
    row.current_step,
  );
  return {
    contactId: row.contactId,
    campaignId: row.campaignId,
    stepNumber: row.current_step,
    restrictionKind: row.restriction.kind,
    reason:
      row.restriction.kind === "safe" ? null : row.restriction.reason,
    safetyStatus:
      row.restriction.kind === "safe" ? "safe" : row.restriction.safetyStatus,
    brokerDomain: row.brokerDomain,
    brokerLimit: row.brokerDomainLimit,
    nextProjectedDueDate: getNextProjectedDueDate(date, nextStep),
  };
}

test("runtime production and forecast preparation remain semantically identical", () => {
  const campaigns = [
    campaign("priority"),
    campaign("campaign-full", { daily_send_limit: 1 }),
    campaign("0-new-full", { new_contacts_per_day: 1 }),
    campaign("account"),
    campaign("safety"),
    campaign("legacy"),
  ];
  const existingSteps = campaigns.flatMap((row) => [
    step(row.id, 1),
    ...(row.id === "legacy" ? [] : [step(row.id, 2)]),
    step(row.id, 3),
    step(row.id, 4, { delay_days: 9 }),
  ]);
  const repairs = planCampaignStepRepairs(campaigns, existingSteps, requestedAt);
  const productionRepairs = repairs.map((repair) => ({
    ...repair,
    id: `database-${repair.campaign_id}-${repair.step_number}`,
  }));
  const enrollments = [
    enrollment("priority-followup", "priority", 4),
    enrollment("campaign-capacity", "campaign-full", 3),
    enrollment("broker-capacity", "priority", 3),
    enrollment("missing-email", "safety", 2),
    enrollment("cooldown", "safety", 2),
    enrollment("terminal", "safety", 2),
    enrollment("snoozed", "safety", 2),
    enrollment("legacy-repaired", "legacy", 2),
    enrollment("new-intake", "0-new-full", 1),
    enrollment("account-1", "account", 1),
    enrollment("account-2", "account", 1),
    enrollment("account-overflow", "account", 1),
  ];
  const contacts = enrollments.map((row) => {
    if (row.id === "missing-email") return contact(row.id, "example.com", { email: null });
    if (row.id === "cooldown") {
      return contact(row.id, "example.com", {
        last_contacted_at: "2026-07-25T12:00:00.000Z",
      });
    }
    if (row.id === "broker-capacity") return contact(row.id, "broker.example");
    return contact(row.id);
  });
  const suppressions = [
    {
      contact_id: "terminal",
      suppression_type: "replied",
      snoozed_until: null,
      reason: "Replied.",
    },
    {
      contact_id: "snoozed",
      suppression_type: "snoozed",
      snoozed_until: date,
      reason: "Paused.",
    },
  ];
  const fixedRows = [
    {
      id: "fixed-campaign",
      contact_id: "fixed-campaign-contact",
      campaign_id: "campaign-full",
      campaign_step_id: "campaign-full-step-2",
      scheduled_date: date,
      broker_domain: "fixed.example",
      status: "scheduled",
    },
    {
      id: "fixed-new",
      contact_id: "fixed-new-contact",
      campaign_id: "0-new-full",
      campaign_step_id: "0-new-full-step-1",
      scheduled_date: date,
      broker_domain: "fixed-new.example",
      status: "scheduled",
    },
    {
      id: "fixed-broker",
      contact_id: "fixed-broker-contact",
      campaign_id: "priority",
      campaign_step_id: "priority-step-2",
      scheduled_date: date,
      broker_domain: "broker.example",
      status: "scheduled",
    },
  ];
  const production = allocatePreparedDailyGeneration({
    campaigns,
    existingSteps,
    persistedRepairedSteps: productionRepairs,
    campaignInputs: campaigns.map((campaignRow) => {
      const campaignEnrollments = enrollments.filter(
        (row) => row.campaign_id === campaignRow.id,
      );
      const campaignContacts = contacts.filter((row) =>
        campaignEnrollments.some((enrollmentRow) => enrollmentRow.contact_id === row.id),
      );
      return {
        campaign: campaignRow,
        enrollments: campaignEnrollments,
        contacts: new Map(campaignContacts.map((row) => [row.id, row])),
        suppressionRules: new Map(
          campaignContacts.map((row) => [
            row.id,
            suppressions.filter((rule) => rule.contact_id === row.id),
          ]),
        ),
      };
    }),
    existingAccountScheduled: 3,
    existingCampaignScheduled: new Map([
      ["campaign-full", 1],
      ["0-new-full", 1],
      ["priority", 1],
    ]),
    existingCampaignNewContacts: new Map([["0-new-full", 1]]),
    brokerDomainCounts: new Map([["broker.example", 1]]),
    domainLimits: new Map([["broker.example", 1]]),
    accountDailyLimit: 6,
    date,
    evaluatedAt: requestedAt,
    defaultTotalLimit: 25,
    defaultNewContactLimit: 8,
  });
  let firstDay;
  const forecast = buildWorkloadForecast(
    {
      campaigns,
      steps: existingSteps,
      enrollments,
      contacts: [
        ...contacts,
        contact("fixed-campaign-contact", "fixed.example"),
        contact("fixed-new-contact", "fixed-new.example"),
        contact("fixed-broker-contact", "broker.example"),
      ],
      suppressions,
      futureSchedule: fixedRows,
      domainLimits: { "broker.example": 1 },
      accountDailyLimit: 6,
    },
    createForecastRequestContext(requestedAt, 1),
    1,
    (observation) => {
      firstDay = observation;
    },
  );

  assert.deepEqual(
    firstDay.candidates.map((row) =>
      semanticCandidate(row, production.preparation.activeSteps),
    ).sort((left, right) => left.contactId.localeCompare(right.contactId)),
    production.preparation.candidates.map((row) =>
      semanticCandidate(row, production.preparation.activeSteps),
    ).sort((left, right) => left.contactId.localeCompare(right.contactId)),
  );
  assert.deepEqual(firstDay.stops, production.stops);
  const semanticOutcomes = (result) =>
    result.outcomes.map((row) => ({
      contactId: row.contactId,
      campaignId: row.campaignId,
      stepNumber: row.current_step,
      outcome: row.action,
      reason: row.reason,
      safetyStatus: row.safetyStatus,
      constraintCategory: getOutcomeConstraintCategory(row),
    }));

  assert.deepEqual(
    semanticOutcomes({ outcomes: firstDay.outcomes }),
    semanticOutcomes(production.allocation),
  );
  const outcomes = new Map(
    semanticOutcomes({ outcomes: firstDay.outcomes }).map((row) => [row.contactId, row]),
  );
  assert.equal(outcomes.get("priority-followup").outcome, "scheduled");
  assert.equal(
    outcomes.get("campaign-capacity").constraintCategory,
    "campaignCapacityOverflow",
  );
  assert.equal(
    outcomes.get("broker-capacity").constraintCategory,
    "brokerDomain",
  );
  assert.equal(
    outcomes.get("new-intake").constraintCategory,
    "newContactIntake",
  );
  assert.equal(
    outcomes.get("account-overflow").constraintCategory,
    "accountCapacityOverflow",
  );
  assert.equal(
    outcomes.get("missing-email").constraintCategory,
    "safetyEligibility",
  );
  assert.equal(outcomes.get("snoozed").safetyStatus, "snoozed");
  assert.equal(outcomes.get("cooldown").safetyStatus, "contacted_too_recently");
  assert.equal(outcomes.get("terminal").constraintCategory, "terminalSuppression");
  assert.equal(
    semanticCandidate(
      firstDay.candidates.find((row) => row.contactId === "legacy-repaired"),
      production.preparation.activeSteps,
    ).nextProjectedDueDate,
    "2026-08-07",
  );
  assert.equal(
    firstDay.nextProjectedDueDates[
      firstDay.candidates.find((row) => row.contactId === "legacy-repaired").id
    ],
    "2026-08-07",
  );

  const constraintCounts = semanticOutcomes({ outcomes: firstDay.outcomes }).reduce(
    (counts, row) => {
      if (row.constraintCategory) {
        counts[row.constraintCategory] =
          (counts[row.constraintCategory] ?? 0) + 1;
      }
      return counts;
    },
    {},
  );
  assert.ok(constraintCounts.accountCapacityOverflow >= 1);
  assert.equal(constraintCounts.campaignCapacityOverflow, 1);
  assert.equal(constraintCounts.newContactIntake, 1);
  assert.equal(constraintCounts.brokerDomain, 1);
  assert.equal(firstDay.constraints.accountCapacityOverflow, constraintCounts.accountCapacityOverflow);
  assert.equal(firstDay.constraints.campaignCapacityOverflow, 1);
  assert.equal(firstDay.constraints.newContactIntake, 1);
  assert.equal(firstDay.constraints.brokerDomain, 1);
  assert.equal(forecast.days[0].totalProjected, 6);
});

test("inactive current steps stop while future progression skips to the next active step", () => {
  const campaigns = [campaign("inactive")];
  const existingSteps = [
    step("inactive", 1),
    step("inactive", 2, {
      status: "inactive",
      subject_template: "Email 2: placeholder",
    }),
    step("inactive", 3),
    step("inactive", 4, { status: "inactive" }),
    step("inactive", 5),
  ];
  const currentInactive = enrollment("current-inactive", "inactive", 2);
  const inactiveLater = enrollment("inactive-later", "inactive", 4);
  const prepared = allocatePreparedDailyGeneration({
    campaigns,
    existingSteps,
    persistedRepairedSteps: [],
    campaignInputs: [{
      campaign: campaigns[0],
      enrollments: [currentInactive, inactiveLater],
      contacts: new Map([
        ["current-inactive", contact("current-inactive")],
        ["inactive-later", contact("inactive-later")],
      ]),
      suppressionRules: new Map(),
    }],
    existingAccountScheduled: 0,
    existingCampaignScheduled: new Map(),
    existingCampaignNewContacts: new Map(),
    brokerDomainCounts: new Map(),
    date,
    evaluatedAt: requestedAt,
    domainLimits: new Map(),
    accountDailyLimit: 25,
    defaultTotalLimit: 25,
    defaultNewContactLimit: 8,
  });

  assert.deepEqual(
    prepared.stops.map((row) => row.safetyStatus),
    ["missing_campaign_step", "missing_campaign_step"],
  );
  assert.equal(
    getNextActiveStep(prepared.preparation.activeSteps, "inactive", 1).step_number,
    3,
  );
  assert.equal(
    getNextActiveStep(prepared.preparation.activeSteps, "inactive", 3).step_number,
    5,
  );
  assert.equal(
    planCampaignStepRepairs(campaigns, existingSteps, requestedAt).some(
      (row) => row.step_number === 2 || row.step_number === 4,
    ),
    false,
  );
});
