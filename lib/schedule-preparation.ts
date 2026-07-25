import {
  mergeCampaignSteps,
  type RepairableCampaignStep,
} from "./campaign-step-repairs.ts";
import { normalizeDailyLimit } from "./schedule-policy.ts";
import { applyGlobalSchedulingPolicy } from "./schedule-policy.ts";
import type {
  CampaignScheduleLimits,
  ScheduleCandidate,
  ScheduleOutcome,
} from "./schedule-policy.ts";
import {
  evaluateScheduleSafety,
  type SafetyCampaign,
  type SafetyContact,
  type SafetyRule,
} from "./schedule-safety.ts";

export type PreparationCampaign = SafetyCampaign & {
  id: string;
  daily_limit: number;
  daily_send_limit: number | null;
  new_contacts_per_day: number | null;
  broker_domain_daily_limit: number | null;
};

export type PreparationContact = SafetyContact & {
  id: string;
  raw_properties: Record<string, string | null | undefined>;
};

export type PreparationEnrollment = {
  id: string;
  contact_id: string;
  campaign_id: string;
  current_step: number;
  next_send_date: string;
  status: string;
};

export type PreparationSuppression = SafetyRule & {
  contact_id: string;
};

export type PreparationStop = {
  enrollmentId: string;
  contactId: string;
  campaignId: string;
  stepNumber: number;
  action: "stop";
  reason: "Missing or inactive campaign step.";
  safetyStatus: "missing_campaign_step";
  constraintCategory: "terminalSuppression";
};

export type PreparedScheduleCandidates = {
  steps: RepairableCampaignStep[];
  activeSteps: RepairableCampaignStep[];
  candidates: ScheduleCandidate[];
  stops: PreparationStop[];
  campaignLimits: Map<string, CampaignScheduleLimits>;
  accountDailyLimit: number;
};

export type ProductionCampaignInput = {
  campaign: PreparationCampaign;
  enrollments: PreparationEnrollment[];
  contacts: Map<string, PreparationContact>;
  suppressionRules: Map<string, PreparationSuppression[]>;
};

export function allocatePreparedDailyGeneration(input: {
  campaigns: PreparationCampaign[];
  existingSteps: RepairableCampaignStep[];
  persistedRepairedSteps: RepairableCampaignStep[];
  campaignInputs: ProductionCampaignInput[];
  existingAccountScheduled: number;
  existingCampaignScheduled: ReadonlyMap<string, number>;
  existingCampaignNewContacts: ReadonlyMap<string, number>;
  brokerDomainCounts: ReadonlyMap<string, number>;
  domainLimits: ReadonlyMap<string, number>;
  accountDailyLimit: number;
  date: string;
  evaluatedAt: string;
  defaultTotalLimit: number;
  defaultNewContactLimit: number;
}) {
  const preparation = prepareScheduleCandidates({
    campaigns: input.campaigns,
    existingSteps: input.existingSteps,
    repairedSteps: input.persistedRepairedSteps,
    enrollments: input.campaignInputs.flatMap((row) => row.enrollments),
    contacts: Array.from(
      new Map(
        input.campaignInputs.flatMap((row) =>
          Array.from(row.contacts.values()).map(
            (contact) => [contact.id, contact] as const,
          ),
        ),
      ).values(),
    ),
    suppressions: input.campaignInputs.flatMap((row) =>
      Array.from(row.suppressionRules.values()).flat(),
    ),
    date: input.date,
    evaluatedAt: input.evaluatedAt,
    domainLimits: input.domainLimits,
    accountDailyLimit: input.accountDailyLimit,
    defaultTotalLimit: input.defaultTotalLimit,
    defaultNewContactLimit: input.defaultNewContactLimit,
  });
  const allocation = applyGlobalSchedulingPolicy(preparation.candidates, {
    accountDailyLimit: preparation.accountDailyLimit,
    campaignLimits: preparation.campaignLimits,
    existingAccountScheduled: input.existingAccountScheduled,
    existingCampaignScheduled: input.existingCampaignScheduled,
    existingCampaignNewContacts: input.existingCampaignNewContacts,
    brokerDomainCounts: input.brokerDomainCounts,
  });
  return { preparation, allocation, stops: preparation.stops };
}

export function prepareScheduleCandidates(input: {
  campaigns: PreparationCampaign[];
  existingSteps: RepairableCampaignStep[];
  repairedSteps: RepairableCampaignStep[];
  enrollments: PreparationEnrollment[];
  contacts: PreparationContact[];
  suppressions: PreparationSuppression[];
  date: string;
  evaluatedAt: string;
  domainLimits: ReadonlyMap<string, number>;
  accountDailyLimit: number;
  defaultTotalLimit: number;
  defaultNewContactLimit: number;
}): PreparedScheduleCandidates {
  const steps = mergeCampaignSteps(input.existingSteps, input.repairedSteps);
  const activeSteps = steps.filter((step) => step.status === "active");
  const campaigns = new Map(input.campaigns.map((row) => [row.id, row]));
  const contacts = new Map(input.contacts.map((row) => [row.id, row]));
  const suppressions = new Map<string, PreparationSuppression[]>();
  for (const rule of input.suppressions) {
    const rows = suppressions.get(rule.contact_id) ?? [];
    rows.push(rule);
    suppressions.set(rule.contact_id, rows);
  }
  const candidates: ScheduleCandidate[] = [];
  const stops: PreparationStop[] = [];

  for (const enrollment of input.enrollments) {
    const campaign = campaigns.get(enrollment.campaign_id);
    const contact = contacts.get(enrollment.contact_id);
    const step = activeSteps.find(
      (row) =>
        row.campaign_id === enrollment.campaign_id &&
        row.step_number === enrollment.current_step,
    );
    if (!campaign || !contact || !step || enrollment.status !== "active") {
      stops.push({
        enrollmentId: enrollment.id,
        contactId: enrollment.contact_id,
        campaignId: enrollment.campaign_id,
        stepNumber: enrollment.current_step,
        action: "stop",
        reason: "Missing or inactive campaign step.",
        safetyStatus: "missing_campaign_step",
        constraintCategory: "terminalSuppression",
      });
      continue;
    }
    const brokerDomain = getBrokerDomain(contact);
    const safety = evaluateScheduleSafety(
      contact,
      suppressions.get(contact.id) ?? [],
      campaign,
      input.date,
      input.evaluatedAt,
    );
    candidates.push({
      id: enrollment.id,
      enrollmentId: enrollment.id,
      contactId: contact.id,
      campaignId: campaign.id,
      campaignStepId: step.id,
      current_step: step.step_number,
      next_send_date: enrollment.next_send_date,
      brokerDomain,
      brokerDomainLimit:
        input.domainLimits.get(brokerDomain) ??
        campaign.broker_domain_daily_limit ??
        3,
      restriction: safety.safe
        ? { kind: "safe" }
        : {
            kind: safety.terminal ? "stop" : "roll_forward",
            reason: safety.reason,
            safetyStatus: safety.safetyStatus,
          },
    });
  }

  return {
    steps,
    activeSteps,
    candidates,
    stops,
    campaignLimits: new Map(
      input.campaigns.map((campaign) => [
        campaign.id,
        {
          totalDailyLimit: normalizeDailyLimit(
            campaign.daily_send_limit ?? campaign.daily_limit,
            input.defaultTotalLimit,
          ),
          newContactsPerDay: normalizeDailyLimit(
            campaign.new_contacts_per_day,
            input.defaultNewContactLimit,
          ),
        },
      ]),
    ),
    accountDailyLimit: normalizeDailyLimit(
      input.accountDailyLimit,
      input.defaultTotalLimit,
    ),
  };
}

export function getNextActiveStep(
  activeSteps: RepairableCampaignStep[],
  campaignId: string,
  currentStep: number,
) {
  return activeSteps
    .filter((step) => step.campaign_id === campaignId)
    .sort((left, right) => left.step_number - right.step_number)
    .find((step) => step.step_number > currentStep);
}

export function getNextProjectedDueDate(
  scheduledDate: string,
  nextStep: RepairableCampaignStep | undefined,
) {
  return nextStep ? addDays(scheduledDate, nextStep.delay_days) : null;
}

export function getOutcomeConstraintCategory(
  outcome: Pick<ScheduleOutcome, "action" | "safetyStatus">,
) {
  if (outcome.action === "stop") return "terminalSuppression" as const;
  if (outcome.safetyStatus === "account_limit_reached") {
    return "accountCapacityOverflow" as const;
  }
  if (outcome.safetyStatus === "campaign_limit_reached") {
    return "campaignCapacityOverflow" as const;
  }
  if (outcome.safetyStatus === "new_contact_limit_reached") {
    return "newContactIntake" as const;
  }
  if (outcome.safetyStatus === "broker_domain_limit_reached") {
    return "brokerDomain" as const;
  }
  if (outcome.action === "roll_forward") return "safetyEligibility" as const;
  return null;
}

export function getBrokerDomain(contact: PreparationContact) {
  const raw = contact.raw_properties ?? {};
  return (
    normalizeDomain(
      raw.company_domain ??
        raw.domain ??
        raw.website ??
        raw.hs_email_domain,
    ) ??
    normalizeDomain(contact.email?.split("@")[1]) ??
    "unknown-domain"
  );
}

function normalizeDomain(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  try {
    const parsed = new URL(
      normalized.startsWith("http") ? normalized : `https://${normalized}`,
    );
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return normalized.replace(/^www\./, "").split("/")[0] || null;
  }
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
