import { getSupabaseAdmin } from "./supabase-admin.ts";
import {
  applyGlobalSchedulingPolicy,
  DEFAULT_NEW_CONTACTS_PER_DAY,
  DEFAULT_TOTAL_DAILY_LIMIT,
  loadAllDeterministicPages,
  normalizeDailyLimit,
} from "./schedule-policy.ts";
import type { ScheduleCandidate } from "./schedule-policy.ts";
import { evaluateScheduleSafety } from "./schedule-safety.ts";
import {
  createVirtualRepairedSteps,
  planCampaignStepRepairs,
} from "./campaign-step-repairs.ts";
import type { RepairableCampaignStep } from "./campaign-step-repairs.ts";
import {
  getNextActiveStep,
  getNextProjectedDueDate,
  getOutcomeConstraintCategory,
  prepareScheduleCandidates,
} from "./schedule-preparation.ts";
import type { PreparationStop } from "./schedule-preparation.ts";

export type ForecastCampaign = {
  id: string;
  name: string;
  daily_limit: number;
  daily_send_limit: number | null;
  new_contacts_per_day: number | null;
  broker_domain_daily_limit: number | null;
  cooldown_days: number;
  stop_on_reply: boolean | null;
  stop_on_bounce: boolean | null;
  stop_on_unsubscribe: boolean | null;
};

export type ForecastStep = {
  id: string;
  campaign_id: string;
  step_number: number;
  delay_days: number;
  subject_template: string;
  body_template: string;
  status?: string;
};

export type ForecastEnrollment = {
  id: string;
  contact_id: string;
  campaign_id: string;
  current_step: number;
  next_send_date: string;
  status: string;
};

export type ForecastContact = {
  id: string;
  email: string | null;
  is_unsubscribed: boolean;
  last_contacted_at: string | null;
  raw_properties: Record<string, string | null | undefined>;
};

export type ForecastSuppression = {
  contact_id: string;
  suppression_type: string;
  snoozed_until: string | null;
  reason?: string | null;
};

export type ForecastScheduleRow = {
  id: string;
  contact_id: string;
  campaign_id: string;
  campaign_step_id: string;
  scheduled_date: string;
  broker_domain: string;
  status: string;
  campaign_steps?: { step_number: number } | null;
};

export type WorkloadForecastInput = {
  campaigns: ForecastCampaign[];
  steps: ForecastStep[];
  enrollments: ForecastEnrollment[];
  contacts: ForecastContact[];
  suppressions: ForecastSuppression[];
  futureSchedule: ForecastScheduleRow[];
  domainLimits: Record<string, number>;
  accountDailyLimit: number;
};

export type ForecastConstraintCounts = {
  accountCapacityOverflow: number;
  campaignCapacityOverflow: number;
  newContactIntake: number;
  brokerDomain: number;
  safetyEligibility: number;
  terminalSuppression: number;
};

export type WorkloadForecastDay = {
  date: string;
  stepCounts: Record<string, number>;
  originallyDue: number;
  rolledForwardBacklog: number;
  totalProjected: number;
  dailyCapacity: number;
  remainingCapacity: number;
  projectedOverflow: number;
  constraints: ForecastConstraintCounts;
  status: "Available capacity" | "Near capacity" | "Over capacity";
};

export type ForecastRequestContext = {
  requestedAt: string;
  startDate: string;
  endDate: string;
  dayCount: number;
};

export type WorkloadForecast = {
  startDate: string;
  endDate: string;
  days: WorkloadForecastDay[];
  stepNumbers: number[];
  summary: {
    totalForecastWorkload: number;
    busiestDate: string | null;
    busiestDateCount: number;
    overCapacityDates: number;
    projectedBacklogAfter30Days: number;
  };
  recommendation: string;
};

export type ForecastAllocationObservation = {
  date: string;
  candidates: ScheduleCandidate[];
  outcomes: ReturnType<typeof applyGlobalSchedulingPolicy>["outcomes"];
  stops: PreparationStop[];
  constraints: ForecastConstraintCounts;
  nextProjectedDueDates: Record<string, string | null>;
};

type ForecastWorkItem = {
  id: string;
  enrollmentId: string;
  contactId: string;
  campaignId: string;
  stepId: string;
  stepNumber: number;
  dueDate: string;
  brokerDomain: string;
  source: "original" | "projected";
  rollCount: number;
  advancesProgression?: boolean;
  initialRestriction?: ScheduleCandidate["restriction"];
};

export async function getWorkloadForecast(
  context = createForecastRequestContext(),
  supabase = getSupabaseAdmin(),
) {
  return buildWorkloadForecast(
    await loadWorkloadForecastInput(context, supabase),
    context,
  );
}

export function buildWorkloadForecast(
  input: WorkloadForecastInput,
  contextOrStartDate: ForecastRequestContext | string,
  dayCount = 30,
  observeAllocation?: (observation: ForecastAllocationObservation) => void,
): WorkloadForecast {
  const context =
    typeof contextOrStartDate === "string"
      ? createForecastRequestContext(
          `${contextOrStartDate}T12:00:00.000Z`,
          dayCount,
        )
      : contextOrStartDate;
  const { startDate } = context;
  const campaignsById = new Map(input.campaigns.map((row) => [row.id, row]));
  const contactsById = new Map(input.contacts.map((row) => [row.id, row]));
  const normalizedSteps = input.steps.map((step) => ({
    ...step,
    status: step.status ?? "active",
  }));
  const plannedRepairs = planCampaignStepRepairs(
    input.campaigns,
    normalizedSteps,
    context.requestedAt,
  );
  const preparation = prepareScheduleCandidates({
    campaigns: input.campaigns,
    existingSteps: normalizedSteps,
    repairedSteps: createVirtualRepairedSteps(normalizedSteps, plannedRepairs),
    enrollments: input.enrollments,
    contacts: input.contacts,
    suppressions: input.suppressions,
    date: startDate,
    evaluatedAt: context.requestedAt,
    domainLimits: new Map(Object.entries(input.domainLimits)),
    accountDailyLimit: input.accountDailyLimit,
    defaultTotalLimit: DEFAULT_TOTAL_DAILY_LIMIT,
    defaultNewContactLimit: DEFAULT_NEW_CONTACTS_PER_DAY,
  });
  const effectiveSteps = preparation.steps;
  const stepsById = new Map(effectiveSteps.map((row) => [row.id, row]));
  const stepsByCampaign = new Map<
    string,
    (typeof preparation.activeSteps)[number][]
  >();
  const suppressionsByContact = new Map<string, ForecastSuppression[]>();

  for (const step of preparation.activeSteps) {
    const rows = stepsByCampaign.get(step.campaign_id) ?? [];
    rows.push(step);
    stepsByCampaign.set(
      step.campaign_id,
      rows.sort((left, right) => left.step_number - right.step_number),
    );
  }

  for (const suppression of input.suppressions) {
    const rows = suppressionsByContact.get(suppression.contact_id) ?? [];
    rows.push(suppression);
    suppressionsByContact.set(suppression.contact_id, rows);
  }

  const scheduledKeys = new Set(
    input.futureSchedule
      .filter((row) => row.status === "scheduled")
      .map((row) => `${row.contact_id}:${row.campaign_id}:${row.campaign_step_id}`),
  );
  const pending: ForecastWorkItem[] = [];
  const missingStepStopsByDate = new Map<string, number>();

  for (const stopped of preparation.stops) {
    const enrollment = input.enrollments.find(
      (row) => row.id === stopped.enrollmentId,
    );
    if (enrollment) {
      const restrictionDate =
        enrollment.next_send_date < startDate
          ? startDate
          : enrollment.next_send_date;
      if (restrictionDate <= context.endDate) {
        missingStepStopsByDate.set(
          restrictionDate,
          (missingStepStopsByDate.get(restrictionDate) ?? 0) + 1,
        );
      }
    }
  }

  for (const candidate of preparation.candidates) {
    if (
      scheduledKeys.has(
        `${candidate.contactId}:${candidate.campaignId}:${candidate.campaignStepId}`,
      )
    ) {
      continue;
    }

    pending.push({
      id: candidate.id,
      enrollmentId: candidate.enrollmentId,
      contactId: candidate.contactId,
      campaignId: candidate.campaignId,
      stepId: candidate.campaignStepId,
      stepNumber: candidate.current_step,
      dueDate: candidate.next_send_date,
      brokerDomain: candidate.brokerDomain,
      source: "original",
      rollCount: 0,
      initialRestriction: candidate.restriction,
    });
  }

  const fixedByDate = new Map<string, ForecastWorkItem[]>();

  const scheduledRows = input.futureSchedule
    .filter((schedule) => schedule.status === "scheduled")
    .sort(
      (left, right) =>
        left.scheduled_date.localeCompare(right.scheduled_date) ||
        left.id.localeCompare(right.id),
    );
  const canonicalProgressionIds = new Set<string>();
  const progressionKeys = new Set<string>();
  for (const row of scheduledRows) {
    const key = `${row.contact_id}:${row.campaign_id}:${row.campaign_step_id}`;
    if (!progressionKeys.has(key)) {
      progressionKeys.add(key);
      canonicalProgressionIds.add(row.id);
    }
  }

  for (const row of scheduledRows) {
    const campaign = campaignsById.get(row.campaign_id);
    const step = stepsById.get(row.campaign_step_id);
    const stepNumber = step?.step_number ?? row.campaign_steps?.step_number;

    if (!campaign || !stepNumber) {
      continue;
    }
    const rows = fixedByDate.get(row.scheduled_date) ?? [];
    rows.push({
      id: `schedule:${row.id}`,
      enrollmentId: `schedule:${row.id}`,
      contactId: row.contact_id,
      campaignId: row.campaign_id,
      stepId: row.campaign_step_id,
      stepNumber,
      dueDate: row.scheduled_date,
      brokerDomain: row.broker_domain,
      source: "original",
      rollCount: 0,
      advancesProgression: canonicalProgressionIds.has(row.id),
    });
    fixedByDate.set(row.scheduled_date, rows);
  }

  const days: WorkloadForecastDay[] = [];
  const allStepNumbers = Array.from(
    new Set(effectiveSteps.map((step) => step.step_number)),
  ).sort((left, right) => left - right);
  const endDate = context.endDate;

  for (let offset = 0; offset < context.dayCount; offset += 1) {
    const date = addDays(startDate, offset);
    const fixed = fixedByDate.get(date) ?? [];
    const dailyCapacity = preparation.accountDailyLimit;
    const stepCounts: Record<string, number> = {};
    const originallyDue =
      pending.filter(
        (item) =>
          (offset === 0 ? item.dueDate <= date : item.dueDate === date) &&
          item.rollCount === 0,
      ).length + fixed.length;
    const rolledForwardBacklog = pending.filter(
      (item) => item.dueDate <= date && item.rollCount > 0,
    ).length;
    let totalProjected = fixed.length;
    const constraints: ForecastConstraintCounts = {
      accountCapacityOverflow: Math.max(0, fixed.length - dailyCapacity),
      campaignCapacityOverflow: 0,
      newContactIntake: 0,
      brokerDomain: 0,
      safetyEligibility: 0,
      terminalSuppression: missingStepStopsByDate.get(date) ?? 0,
    };
    const domainCounts = new Map<string, number>();

    for (const item of fixed) {
      stepCounts[String(item.stepNumber)] =
        (stepCounts[String(item.stepNumber)] ?? 0) + 1;
      domainCounts.set(
        item.brokerDomain,
        (domainCounts.get(item.brokerDomain) ?? 0) + 1,
      );
      if (item.advancesProgression !== false) {
        enqueueNextStep(pending, item, date, stepsByCampaign, scheduledKeys);
      }
    }

    const dueItems = pending.filter((item) => item.dueDate <= date);
    const itemsById = new Map(dueItems.map((item) => [item.id, item]));
    const campaignLimits = preparation.campaignLimits;
    const existingCampaignScheduled = new Map<string, number>();
    const existingCampaignNewContacts = new Map<string, number>();

    for (const item of fixed) {
      existingCampaignScheduled.set(
        item.campaignId,
        (existingCampaignScheduled.get(item.campaignId) ?? 0) + 1,
      );
      if (item.stepNumber === 1) {
        existingCampaignNewContacts.set(
          item.campaignId,
          (existingCampaignNewContacts.get(item.campaignId) ?? 0) + 1,
        );
      }
    }

    for (const [campaignId, count] of existingCampaignScheduled) {
      constraints.campaignCapacityOverflow += Math.max(
        0,
        count - (campaignLimits.get(campaignId)?.totalDailyLimit ?? 0),
      );
    }

    const candidates: ScheduleCandidate[] = dueItems.map((item) => {
      const campaign = campaignsById.get(item.campaignId)!;
      return {
        id: item.id,
        enrollmentId: item.enrollmentId,
        contactId: item.contactId,
        campaignId: item.campaignId,
        campaignStepId: item.stepId,
        current_step: item.stepNumber,
        next_send_date: item.dueDate,
        brokerDomain: item.brokerDomain,
        brokerDomainLimit:
          input.domainLimits[item.brokerDomain] ??
          campaign.broker_domain_daily_limit ??
          3,
        restriction:
          date === startDate && item.rollCount === 0 && item.initialRestriction
            ? item.initialRestriction
            : getForecastRestriction(
                contactsById.get(item.contactId),
                suppressionsByContact.get(item.contactId) ?? [],
                campaign,
                date,
                context,
              ),
      };
    });
    const result = applyGlobalSchedulingPolicy(candidates, {
      accountDailyLimit: dailyCapacity,
      campaignLimits,
      existingAccountScheduled: fixed.length,
      existingCampaignScheduled,
      existingCampaignNewContacts,
      brokerDomainCounts: domainCounts,
    });

    for (const outcome of result.outcomes) {
        const item = itemsById.get(outcome.id);
        if (!item) continue;

        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);

        if (outcome.action === "scheduled") {
          totalProjected += 1;
          stepCounts[String(item.stepNumber)] =
            (stepCounts[String(item.stepNumber)] ?? 0) + 1;
          enqueueNextStep(pending, item, date, stepsByCampaign, scheduledKeys);
        } else {
          const category = getOutcomeConstraintCategory(outcome);
          if (category) constraints[category] += 1;
          if (outcome.action === "stop") continue;
          pending.push({
            ...item,
            dueDate: addDays(date, 1),
            rollCount: item.rollCount + 1,
          });
        }
      }

    domainCounts.clear();
    for (const [domain, count] of result.brokerDomainCounts) {
      domainCounts.set(domain, count);
    }

    const projectedOverflow = constraints.accountCapacityOverflow;
    const remainingCapacity = Math.max(0, dailyCapacity - totalProjected);
    const day: WorkloadForecastDay = {
      date,
      stepCounts,
      originallyDue,
      rolledForwardBacklog,
      totalProjected,
      dailyCapacity,
      remainingCapacity,
      projectedOverflow,
      status:
        constraints.accountCapacityOverflow > 0
          ? "Over capacity"
          : dailyCapacity > 0 && totalProjected >= dailyCapacity * 0.8
            ? "Near capacity"
            : "Available capacity",
      constraints,
    };
    days.push(day);
    observeAllocation?.({
      date,
      candidates,
      outcomes: result.outcomes,
      stops: offset === 0 ? preparation.stops : [],
      constraints: { ...constraints },
      nextProjectedDueDates: Object.fromEntries(
        result.outcomes.map((outcome) => {
          if (outcome.action === "roll_forward") {
            return [outcome.id, addDays(date, 1)];
          }
          if (outcome.action === "stop") return [outcome.id, null];
          return [
            outcome.id,
            getNextProjectedDueDate(
              date,
              getNextActiveStep(
                preparation.activeSteps,
                outcome.campaignId,
                outcome.current_step,
              ),
            ),
          ];
        }),
      ),
    });
  }

  const totalForecastWorkload = days.reduce(
    (total, day) => total + day.totalProjected,
    0,
  );
  const busiest = days.reduce<WorkloadForecastDay | null>(
    (current, day) =>
      !current || day.totalProjected > current.totalProjected ? day : current,
    null,
  );
  const backlog = pending.filter(
    (item) => item.dueDate <= addDays(endDate, 1) && item.rollCount > 0,
  ).length;
  const backlogByCampaign = new Map<string, number>();
  const newContactBacklogByCampaign = new Map<string, number>();
  for (const item of pending.filter(
    (row) => row.dueDate <= addDays(endDate, 1) && row.rollCount > 0,
  )) {
    backlogByCampaign.set(
      item.campaignId,
      (backlogByCampaign.get(item.campaignId) ?? 0) + 1,
    );
    if (item.stepNumber === 1) {
      newContactBacklogByCampaign.set(
        item.campaignId,
        (newContactBacklogByCampaign.get(item.campaignId) ?? 0) + 1,
      );
    }
  }
  const busiestBacklogCampaign = [...input.campaigns].sort((left, right) => {
    const countDifference =
      (backlogByCampaign.get(right.id) ?? 0) -
      (backlogByCampaign.get(left.id) ?? 0);
    return countDifference || left.id.localeCompare(right.id);
  })[0];
  const busiestCount = busiest?.totalProjected ?? 0;
  const currentNewContactLimit = busiestBacklogCampaign
    ? normalizeDailyLimit(
        busiestBacklogCampaign.new_contacts_per_day,
        DEFAULT_NEW_CONTACTS_PER_DAY,
      )
    : 0;
  const recommendedNewContactLimit = busiestBacklogCampaign
    ? Math.max(
        1,
        currentNewContactLimit -
          Math.ceil(
            (newContactBacklogByCampaign.get(busiestBacklogCampaign.id) ?? 0) /
              context.dayCount,
          ),
      )
    : 0;
  const hasCapacityConstraint = days.some(
    (day) =>
      day.constraints.accountCapacityOverflow > 0 ||
      day.constraints.campaignCapacityOverflow > 0 ||
      day.constraints.newContactIntake > 0,
  );
  const recommendation =
    totalForecastWorkload === 0 && backlog === 0
      ? "No projected workload."
      : backlog > 0 &&
          busiestBacklogCampaign &&
          hasCapacityConstraint &&
          recommendedNewContactLimit < currentNewContactLimit
        ? `Reduce ${busiestBacklogCampaign.name} from ${currentNewContactLimit} to ${recommendedNewContactLimit} new contacts per day to reduce projected backlog.`
        : backlog > 0 && busiestBacklogCampaign
          ? `${busiestBacklogCampaign.name} has ${
              backlogByCampaign.get(busiestBacklogCampaign.id) ?? 0
            } projected backlog items; review its capacity and eligibility constraints.`
        : "Current campaign intake limits fit the projected account capacity.";

  return {
    startDate,
    endDate,
    days,
    stepNumbers: allStepNumbers,
    summary: {
      totalForecastWorkload,
      busiestDate: busiestCount > 0 ? busiest?.date ?? null : null,
      busiestDateCount: busiestCount,
      overCapacityDates: days.filter(
        (day) => day.constraints.accountCapacityOverflow > 0,
      ).length,
      projectedBacklogAfter30Days: backlog,
    },
    recommendation,
  };
}

export async function loadAndBuildWorkloadForecast(
  load: () => Promise<WorkloadForecastInput>,
  contextOrStartDate: ForecastRequestContext | string,
  dayCount = 30,
) {
  return buildWorkloadForecast(await load(), contextOrStartDate, dayCount);
}

export async function loadWorkloadForecastInput(
  context: ForecastRequestContext,
  supabase = getSupabaseAdmin(),
): Promise<WorkloadForecastInput> {
  const { data: campaigns, error: campaignError } = await supabase
    .from("campaigns")
    .select(
      "id,name,daily_limit,daily_send_limit,new_contacts_per_day,broker_domain_daily_limit,cooldown_days,stop_on_reply,stop_on_bounce,stop_on_unsubscribe",
    )
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .returns<ForecastCampaign[]>();
  if (campaignError) throw campaignError;

  const { data: settingRows, error: settingsError } = await supabase
    .from("sending_settings")
    .select("daily_send_limit")
    .order("created_at", { ascending: true })
    .limit(1)
    .returns<Array<{ daily_send_limit: number }>>();
  if (settingsError) throw settingsError;
  const accountDailyLimit = normalizeDailyLimit(
    settingRows?.[0]?.daily_send_limit,
    DEFAULT_TOTAL_DAILY_LIMIT,
  );

  const campaignIds = (campaigns ?? []).map((campaign) => campaign.id);
  if (campaignIds.length === 0) {
    return {
      campaigns: [],
      steps: [],
      enrollments: [],
      contacts: [],
      suppressions: [],
      futureSchedule: [],
      domainLimits: {},
      accountDailyLimit,
    };
  }

  const [stepsResult, limitsResult] = await Promise.all([
    supabase
      .from("campaign_steps")
      .select(
        "id,campaign_id,step_number,delay_days,subject_template,body_template,status",
      )
      .in("campaign_id", campaignIds)
      .order("step_number", { ascending: true })
      .returns<ForecastStep[]>(),
    supabase
      .from("broker_domain_limits")
      .select("broker_domain,daily_limit")
      .eq("status", "active")
      .returns<Array<{ broker_domain: string; daily_limit: number }>>(),
  ]);
  if (stepsResult.error) throw stepsResult.error;
  if (limitsResult.error) throw limitsResult.error;

  const enrollments = await loadAllDeterministicPages(async (from, to) => {
    const { data, error } = await supabase
      .from("contact_campaign_enrollments")
      .select("id,contact_id,campaign_id,current_step,next_send_date,status")
      .in("campaign_id", campaignIds)
      .eq("status", "active")
      .lte("next_send_date", context.endDate)
      .order("current_step", { ascending: false })
      .order("next_send_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
      .returns<ForecastEnrollment[]>();
    if (error) throw error;
    return data ?? [];
  });

  const futureSchedule = await loadAllDeterministicPages(
    async (from, to) => {
      const { data, error } = await supabase
        .from("daily_send_schedule")
        .select(
          "id,contact_id,campaign_id,campaign_step_id,scheduled_date,broker_domain,status,campaign_steps(step_number)",
        )
        .in("campaign_id", campaignIds)
        .gte("scheduled_date", context.startDate)
        .lte("scheduled_date", context.endDate)
        .eq("status", "scheduled")
        .order("scheduled_date", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<ForecastScheduleRow[]>();
      if (error) throw error;
      return data ?? [];
    },
    250,
  );

  const contactIds = Array.from(
    new Set([
      ...enrollments.map((enrollment) => enrollment.contact_id),
      ...futureSchedule.map((row) => row.contact_id),
    ]),
  );
  const contacts: ForecastContact[] = [];
  const suppressions: ForecastSuppression[] = [];

  for (const chunk of chunkArray(contactIds, 100)) {
    const [contactResult, suppressionResult] = await Promise.all([
      supabase
        .from("hubspot_contacts")
        .select("id,email,is_unsubscribed,last_contacted_at,raw_properties")
        .in("id", chunk)
        .returns<ForecastContact[]>(),
      supabase
        .from("contact_suppression_rules")
        .select("contact_id,suppression_type,snoozed_until,reason")
        .in("contact_id", chunk)
        .eq("active", true)
        .returns<ForecastSuppression[]>(),
    ]);
    if (contactResult.error) throw contactResult.error;
    if (suppressionResult.error) throw suppressionResult.error;
    contacts.push(...(contactResult.data ?? []));
    suppressions.push(...(suppressionResult.data ?? []));
  }

  return {
    campaigns: campaigns ?? [],
    steps: stepsResult.data ?? [],
    enrollments,
    contacts,
    suppressions,
    futureSchedule,
    domainLimits: Object.fromEntries(
      (limitsResult.data ?? []).map((row) => [row.broker_domain, row.daily_limit]),
    ),
    accountDailyLimit,
  };
}

function enqueueNextStep(
  pending: ForecastWorkItem[],
  item: ForecastWorkItem,
  scheduledDate: string,
  stepsByCampaign: Map<string, RepairableCampaignStep[]>,
  scheduledKeys: ReadonlySet<string>,
) {
  const nextStep = getNextActiveStep(
    Array.from(stepsByCampaign.values()).flat(),
    item.campaignId,
    item.stepNumber,
  );
  if (!nextStep) return;
  if (
    scheduledKeys.has(
      `${item.contactId}:${item.campaignId}:${nextStep.id}`,
    )
  ) {
    return;
  }

  pending.push({
    ...item,
    id: `${item.enrollmentId}:step:${nextStep.step_number}`,
    stepId: nextStep.id,
    stepNumber: nextStep.step_number,
    dueDate: getNextProjectedDueDate(scheduledDate, nextStep)!,
    source: "projected",
    rollCount: 0,
  });
}

export function getForecastRestriction(
  contact: ForecastContact | undefined,
  suppressions: ForecastSuppression[],
  campaign: ForecastCampaign,
  date: string,
  context: ForecastRequestContext,
) {
  const safety = evaluateScheduleSafety(
    contact,
    suppressions,
    campaign,
    date,
    projectTimestampForDate(date, context.requestedAt),
  );
  if (safety.safe) return { kind: "safe" as const };
  return {
    kind: safety.terminal ? ("stop" as const) : ("roll_forward" as const),
    reason: safety.reason,
    safetyStatus: safety.safetyStatus,
  };
}

export function createForecastRequestContext(
  requestedAt = new Date().toISOString(),
  dayCount = 30,
): ForecastRequestContext {
  const startDate = requestedAt.slice(0, 10);
  return {
    requestedAt,
    startDate,
    endDate: addDays(startDate, dayCount - 1),
    dayCount,
  };
}

function projectTimestampForDate(date: string, requestedAt: string) {
  return `${date}T${requestedAt.slice(11)}`;
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function chunkArray<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
