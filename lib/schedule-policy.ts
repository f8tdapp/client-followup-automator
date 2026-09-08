export const DEFAULT_TOTAL_DAILY_LIMIT = 25;
export const DEFAULT_NEW_CONTACTS_PER_DAY = 8;
export const MAX_DAILY_LIMIT = 1000;

export type DueEnrollment = {
  current_step: number;
  next_send_date: string;
  id: string;
};

export type ScheduleRestriction =
  | { kind: "safe" }
  | {
      kind: "roll_forward" | "stop";
      reason: string;
      safetyStatus: string;
    };

export type ScheduleCandidate = DueEnrollment & {
  enrollmentId: string;
  contactId: string;
  campaignId: string;
  campaignStepId: string;
  brokerDomain: string;
  brokerDomainLimit: number;
  restriction: ScheduleRestriction;
};

export type ScheduleOutcome = ScheduleCandidate & {
  action: "scheduled" | "roll_forward" | "stop";
  status: "scheduled" | "skipped";
  reason: string;
  safetyStatus: string;
};

export type SchedulePolicyOptions = {
  totalDailyLimit: number;
  newContactsPerDay: number;
  existingScheduled?: number;
  existingNewContacts?: number;
  brokerDomainCounts?: ReadonlyMap<string, number>;
};

export type CampaignScheduleLimits = {
  totalDailyLimit: number;
  newContactsPerDay: number;
};

export type GlobalSchedulePolicyOptions = {
  accountDailyLimit: number;
  campaignLimits: ReadonlyMap<string, CampaignScheduleLimits>;
  existingAccountScheduled?: number;
  existingCampaignScheduled?: ReadonlyMap<string, number>;
  existingCampaignNewContacts?: ReadonlyMap<string, number>;
  brokerDomainCounts?: ReadonlyMap<string, number>;
};

export type ExistingPlanBoundary<T> = {
  hasExistingPlan: () => Promise<boolean>;
  loadExistingPlan: () => Promise<T>;
  generateNewPlan: () => Promise<T>;
};

export type ScheduleOutcomePersistence = {
  writeSchedule: (outcome: ScheduleOutcome) => Promise<void>;
  rollForwardEnrollment: (outcome: ScheduleOutcome) => Promise<void>;
  stopEnrollment: (outcome: ScheduleOutcome) => Promise<void>;
  writeSchedules?: (outcomes: ScheduleOutcome[]) => Promise<void>;
  rollForwardEnrollments?: (outcomes: ScheduleOutcome[]) => Promise<void>;
  stopEnrollments?: (outcomes: ScheduleOutcome[]) => Promise<void>;
};

export type TwoPhaseGenerationBoundary<TPrepared, TResult> = {
  prepare: () => Promise<TPrepared>;
  persist: (prepared: TPrepared) => Promise<TResult>;
};

export function normalizeDailyLimit(
  value: unknown,
  fallback: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(MAX_DAILY_LIMIT, Math.max(1, Math.trunc(parsed)));
}

export function sortDueEnrollments<T extends DueEnrollment>(
  enrollments: T[],
): T[] {
  return [...enrollments].sort((left, right) => {
    if (left.current_step !== right.current_step) {
      return right.current_step - left.current_step;
    }

    const dateComparison = left.next_send_date.localeCompare(right.next_send_date);

    return dateComparison || left.id.localeCompare(right.id);
  });
}

export function applySchedulingPolicy(
  candidates: ScheduleCandidate[],
  options: SchedulePolicyOptions,
) {
  const campaignId = candidates[0]?.campaignId ?? "__single_campaign__";
  const result = applyGlobalSchedulingPolicy(
    candidates.map((candidate) => ({ ...candidate, campaignId })),
    {
      accountDailyLimit: MAX_DAILY_LIMIT,
      campaignLimits: new Map([
        [
          campaignId,
          {
            totalDailyLimit: options.totalDailyLimit,
            newContactsPerDay: options.newContactsPerDay,
          },
        ],
      ]),
      existingAccountScheduled: options.existingScheduled,
      existingCampaignScheduled: new Map([
        [campaignId, options.existingScheduled ?? 0],
      ]),
      existingCampaignNewContacts: new Map([
        [campaignId, options.existingNewContacts ?? 0],
      ]),
      brokerDomainCounts: options.brokerDomainCounts,
    },
  );

  return {
    outcomes: result.outcomes,
    scheduledCount: result.accountScheduledCount,
    newContactCount: result.campaignNewContactCounts.get(campaignId) ?? 0,
    brokerDomainCounts: result.brokerDomainCounts,
  };
}

export function applyGlobalSchedulingPolicy(
  candidates: ScheduleCandidate[],
  options: GlobalSchedulePolicyOptions,
) {
  let accountScheduledCount = options.existingAccountScheduled ?? 0;
  const campaignScheduledCounts = new Map(
    options.existingCampaignScheduled ?? [],
  );
  const campaignNewContactCounts = new Map(
    options.existingCampaignNewContacts ?? [],
  );
  const brokerDomainCounts = new Map(options.brokerDomainCounts ?? []);
  const outcomes: ScheduleOutcome[] = [];

  for (const candidate of sortGlobalScheduleCandidates(candidates)) {
    if (candidate.restriction.kind !== "safe") {
      outcomes.push({
        ...candidate,
        action: candidate.restriction.kind,
        status: "skipped",
        reason: candidate.restriction.reason,
        safetyStatus: candidate.restriction.safetyStatus,
      });
      continue;
    }

    if (accountScheduledCount >= options.accountDailyLimit) {
      outcomes.push({
        ...candidate,
        action: "roll_forward",
        status: "skipped",
        reason: "Account daily send limit reached.",
        safetyStatus: "account_limit_reached",
      });
      continue;
    }

    const limits = options.campaignLimits.get(candidate.campaignId);
    const campaignScheduledCount =
      campaignScheduledCounts.get(candidate.campaignId) ?? 0;
    const campaignNewContactCount =
      campaignNewContactCounts.get(candidate.campaignId) ?? 0;

    if (!limits || campaignScheduledCount >= limits.totalDailyLimit) {
      outcomes.push({
        ...candidate,
        action: "roll_forward",
        status: "skipped",
        reason: "Campaign daily send limit reached.",
        safetyStatus: "campaign_limit_reached",
      });
      continue;
    }

    if (
      candidate.current_step === 1 &&
      campaignNewContactCount >= limits.newContactsPerDay
    ) {
      outcomes.push({
        ...candidate,
        action: "roll_forward",
        status: "skipped",
        reason: "New contacts per day limit reached.",
        safetyStatus: "new_contact_limit_reached",
      });
      continue;
    }

    const brokerCount = brokerDomainCounts.get(candidate.brokerDomain) ?? 0;

    if (brokerCount >= candidate.brokerDomainLimit) {
      outcomes.push({
        ...candidate,
        action: "roll_forward",
        status: "skipped",
        reason: "Broker domain daily limit reached.",
        safetyStatus: "broker_domain_limit_reached",
      });
      continue;
    }

    outcomes.push({
      ...candidate,
      action: "scheduled",
      status: "scheduled",
      reason: `Ready for Email ${candidate.current_step}.`,
      safetyStatus: "safe",
    });
    accountScheduledCount += 1;
    campaignScheduledCounts.set(
      candidate.campaignId,
      campaignScheduledCount + 1,
    );
    campaignNewContactCounts.set(
      candidate.campaignId,
      campaignNewContactCount + (candidate.current_step === 1 ? 1 : 0),
    );
    brokerDomainCounts.set(candidate.brokerDomain, brokerCount + 1);
  }

  return {
    outcomes,
    accountScheduledCount,
    campaignScheduledCounts,
    campaignNewContactCounts,
    brokerDomainCounts,
  };
}

function sortGlobalScheduleCandidates(candidates: ScheduleCandidate[]) {
  return [...candidates].sort((left, right) => {
    if (left.current_step !== right.current_step) {
      return right.current_step - left.current_step;
    }
    const dueComparison = left.next_send_date.localeCompare(right.next_send_date);
    if (dueComparison) return dueComparison;
    return (
      left.campaignId.localeCompare(right.campaignId) ||
      left.enrollmentId.localeCompare(right.enrollmentId) ||
      left.contactId.localeCompare(right.contactId) ||
      left.id.localeCompare(right.id)
    );
  });
}

export async function loadAllDeterministicPages<T>(
  loadPage: (from: number, to: number) => Promise<T[]>,
  pageSize = 250,
) {
  const rows: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const page = await loadPage(from, from + pageSize - 1);
    rows.push(...page);

    if (page.length < pageSize) {
      return rows;
    }
  }
}

export async function generateUnlessPlanExists<T>(
  boundary: ExistingPlanBoundary<T>,
) {
  if (await boundary.hasExistingPlan()) {
    return boundary.loadExistingPlan();
  }

  return boundary.generateNewPlan();
}

export async function persistScheduleOutcomes(
  outcomes: ScheduleOutcome[],
  persistence: ScheduleOutcomePersistence,
) {
  if (
    persistence.writeSchedules &&
    persistence.rollForwardEnrollments &&
    persistence.stopEnrollments
  ) {
    await persistence.writeSchedules(outcomes);
    await persistence.rollForwardEnrollments(
      outcomes.filter((outcome) => outcome.action === "roll_forward"),
    );
    await persistence.stopEnrollments(
      outcomes.filter((outcome) => outcome.action === "stop"),
    );
    return;
  }

  for (const outcome of outcomes) {
    await persistence.writeSchedule(outcome);

    if (outcome.action === "roll_forward") {
      await persistence.rollForwardEnrollment(outcome);
    } else if (outcome.action === "stop") {
      await persistence.stopEnrollment(outcome);
    }
  }
}

export async function runTwoPhaseGeneration<TPrepared, TResult>(
  boundary: TwoPhaseGenerationBoundary<TPrepared, TResult>,
) {
  const prepared = await boundary.prepare();

  return boundary.persist(prepared);
}
