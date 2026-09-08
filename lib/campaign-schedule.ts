import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { allocatePreparedDailyGeneration } from "@/lib/schedule-preparation";
import {
  CampaignEnrollmentConflictError,
  runAtomicCampaignEnrollment,
} from "@/lib/campaign-enrollment";
import {
  getDefaultCampaignStep,
  mergeCampaignSteps,
  planCampaignStepRepairs,
} from "@/lib/campaign-step-repairs";
import {
  DEFAULT_NEW_CONTACTS_PER_DAY,
  DEFAULT_TOTAL_DAILY_LIMIT,
  generateUnlessPlanExists,
  loadAllDeterministicPages,
  normalizeDailyLimit,
  persistScheduleOutcomes,
  runTwoPhaseGeneration,
  type ScheduleOutcome,
} from "@/lib/schedule-policy";
import {
  excludePreviouslyManuallySentEnrollments,
  getManualSendProgressionKey,
} from "@/lib/manual-send-safety";

type CampaignRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  daily_limit: number;
  daily_send_limit: number | null;
  new_contacts_per_day: number | null;
  new_enrollments_paused: boolean | null;
  broker_domain_daily_limit: number | null;
  cooldown_days: number;
  stop_on_reply: boolean | null;
  stop_on_bounce: boolean | null;
  stop_on_unsubscribe: boolean | null;
};

type CampaignStepRow = {
  id: string;
  campaign_id: string;
  step_number: number;
  delay_days: number;
  subject_template: string;
  body_template: string;
  status: string;
};

type CampaignStepRepairRow = {
  campaign_id: string;
  step_number: number;
  delay_days: number;
  subject_template: string;
  body_template: string;
  status: string;
  updated_at: string;
};

type PreparedCampaignInput = {
  campaign: CampaignRow;
  enrollments: EnrollmentRow[];
  contacts: Map<string, HubSpotContactScheduleRow>;
  suppressionRules: Map<string, SuppressionRuleRow[]>;
};

type PreparedDailyGeneration = {
  campaigns: CampaignRow[];
  existingSteps: CampaignStepRow[];
  stepRepairs: CampaignStepRepairRow[];
  campaignInputs: PreparedCampaignInput[];
  existingScheduled: Awaited<ReturnType<typeof getExistingScheduledCounts>>;
  domainLimits: Map<string, number>;
  accountDailyLimit: number;
};

type HubSpotContactScheduleRow = {
  id: string;
  hubspot_contact_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  is_unsubscribed: boolean;
  last_contacted_at: string | null;
  last_engaged_at: string | null;
  raw_properties: Record<string, string | null | undefined>;
};

type EnrollmentRow = {
  id: string;
  contact_id: string;
  campaign_id: string;
  current_step: number;
  status: string;
  next_send_date: string;
  last_sent_at: string | null;
};

type SuppressionRuleRow = {
  contact_id: string;
  suppression_type: string;
  reason: string | null;
  snoozed_until: string | null;
};

type DomainLimitRow = {
  broker_domain: string;
  daily_limit: number;
};

type SupabaseErrorLike = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

export class CampaignScheduleOperationError extends Error {
  details: string;
  supabaseError?: SupabaseErrorLike;
  operation: string;

  constructor(
    message: string,
    details: string,
    operation: string,
    supabaseError?: SupabaseErrorLike,
  ) {
    super(message);
    this.name = "CampaignScheduleOperationError";
    this.details = details;
    this.operation = operation;
    this.supabaseError = supabaseError;
  }
}

export type DailySendPlanRow = {
  id: string;
  scheduled_date: string;
  broker_domain: string;
  status: string;
  reason: string;
  safety_status: string;
  contact_id: string;
  campaign_id: string;
  campaign_step_id: string;
  hubspot_contacts: {
    first_name: string | null;
    last_name: string | null;
    company: string | null;
    email: string | null;
  } | null;
  campaigns: {
    name: string;
  } | null;
  campaign_steps: {
    step_number: number;
  } | null;
};

type DailySendScheduleRow = {
  id: string;
  scheduled_date: string;
  broker_domain: string;
  status: string;
  reason: string;
  safety_status: string;
  contact_id: string;
  campaign_id: string;
  campaign_step_id: string;
};

export type DailySendPlanSummary = {
  scheduledDate: string;
  totalScheduled: number;
  brokerDomainsProtected: number;
  skippedDueToDomainLimits: number;
  dueEmail1: number;
  dueEmail2: number;
  dueEmail3: number;
  totalDailyLimit: number;
  rolledForwardTotalLimit: number;
  rolledForwardNewContactLimit: number;
  rolledForwardSafetyLimit: number;
  stoppedByTerminalSuppression: number;
};

export type DailySendPlanDiagnostics = {
  hasActiveCampaign: boolean;
  activeCampaignCount: number;
  eligibleContactCount: number;
  enrolledContactCount: number;
  hasCampaignSteps: boolean;
  campaignStepCount: number;
  suppressionRulesCount: number;
  reason: string | null;
  diagnosticsError?: string | null;
  diagnosticsWarning?: string | null;
};

export type DailySendPlan = {
  ok?: boolean;
  error?: string;
  details?: string;
  summary: DailySendPlanSummary;
  diagnostics: DailySendPlanDiagnostics;
  schedule: DailySendPlanRow[];
} & DailySendPlanDiagnostics;

const scheduleStatuses = ["scheduled", "skipped", "manually_sent"];
const terminalSuppressionStatuses = new Set([
  "replied",
  "reply",
  "bounced",
  "bounce",
  "unsubscribed",
  "unsubscribe",
  "do_not_contact",
]);
const suppressionDiagnosticsWarning =
  "Could not read contact_suppression_rules diagnostics.";
const contactLookupChunkSize = 25;
const scheduleContactLookupChunkSize = 25;
const dueEnrollmentPageSize = 250;

export function createEmptyDailySendPlan(
  date = getTodayDate(),
  reason: string | null = null,
): DailySendPlan {
  const diagnostics = {
    hasActiveCampaign: false,
    activeCampaignCount: 0,
    eligibleContactCount: 0,
    enrolledContactCount: 0,
    hasCampaignSteps: false,
    campaignStepCount: 0,
    suppressionRulesCount: 0,
    reason,
    diagnosticsError: null,
    diagnosticsWarning: null,
  };

  return {
    ok: reason ? false : true,
    summary: {
      scheduledDate: date,
      totalScheduled: 0,
      brokerDomainsProtected: 0,
      skippedDueToDomainLimits: 0,
      dueEmail1: 0,
      dueEmail2: 0,
      dueEmail3: 0,
      totalDailyLimit: DEFAULT_TOTAL_DAILY_LIMIT,
      rolledForwardTotalLimit: 0,
      rolledForwardNewContactLimit: 0,
      rolledForwardSafetyLimit: 0,
      stoppedByTerminalSuppression: 0,
    },
    diagnostics,
    ...diagnostics,
    schedule: [],
  };
}

export async function generateDailySendSchedule(
  date?: string,
  requestedAt = new Date().toISOString(),
) {
  const scheduledDate = date ?? requestedAt.slice(0, 10);
  return generateUnlessPlanExists({
    hasExistingPlan: () => hasExistingScheduleRows(scheduledDate),
    loadExistingPlan: () => getDailySendPlan(scheduledDate),
    generateNewPlan: () =>
      generateNewDailySendSchedule(scheduledDate, requestedAt),
  });
}

async function generateNewDailySendSchedule(date: string, requestedAt: string) {
  let currentOperation = "generate_today.start";

  logScheduleOperationStart("generate_today.start", {
    scheduledDate: date,
  });

  try {
    currentOperation = "generate_today.load_active_campaigns";
    const campaigns = await runNamedScheduleOperation(
      "generate_today.load_active_campaigns",
      () => getActiveCampaigns(),
    );

    if (campaigns.length === 0) {
      currentOperation = "generate_today.final_load_plan";

      return runNamedScheduleOperation("generate_today.final_load_plan", () =>
        getDailySendPlan(date),
      );
    }

    currentOperation = "generate_today.prepare";
    const brokerDomainCounts = await runTwoPhaseGeneration({
      prepare: () => prepareDailyGeneration(campaigns, date),
      persist: (prepared) =>
        persistPreparedDailyGeneration(prepared, date, requestedAt),
    });

    currentOperation = "generate_today.compute_domain_limits";
    await runNamedScheduleOperation(
      "generate_today.compute_domain_limits",
      async () => {
        const supabaseAdmin = getSupabaseAdmin();
        const { error } = await runScheduleQuery(
          "generate_today.compute_domain_limits",
          () =>
            supabaseAdmin.from("broker_domain_limits").upsert(
              Array.from(brokerDomainCounts.keys()).map((brokerDomain) => ({
                broker_domain: brokerDomain,
                daily_limit: 3,
                updated_at: new Date().toISOString(),
              })),
              { onConflict: "broker_domain" },
            ),
        );

        if (error) {
          throw createCampaignScheduleOperationError(
            "Broker domain limit update failed",
            "generate_today.compute_domain_limits",
            error,
          );
        }
      },
    );

    logScheduleOperationSuccess("generate_today.start", {
      scheduledDate: date,
    });

    currentOperation = "generate_today.final_load_plan";

    return runNamedScheduleOperation("generate_today.final_load_plan", () =>
      getDailySendPlan(date),
    );
  } catch (error) {
    if (error instanceof CampaignScheduleOperationError) {
      throw error;
    }

    throw createCampaignScheduleOperationError(
      "Generate today failed",
      currentOperation,
      getOperationError(error),
    );
  }
}

async function prepareDailyGeneration(
  campaigns: CampaignRow[],
  date: string,
): Promise<PreparedDailyGeneration> {
  const preparedSteps = await prepareCampaignSteps(campaigns);
  const [existingScheduled, domainLimits, accountDailyLimit] = await Promise.all([
    getExistingScheduledCounts(date),
    getBrokerDomainLimits(),
    getAccountDailyLimit(),
  ]);
  const campaignInputs: PreparedCampaignInput[] = [];

  for (const campaign of campaigns) {
    const stepNumbers = [
      ...preparedSteps.existingSteps
        .filter((step) => step.campaign_id === campaign.id)
        .map((step) => step.step_number),
      ...preparedSteps.stepRepairs
        .filter((step) => step.campaign_id === campaign.id)
        .map((step) => step.step_number),
    ];
    const dueEnrollments = await getDueEnrollments(
      campaign.id,
      date,
      Math.max(...stepNumbers, 3),
    );
    const manuallySentProgressions = await getManuallySentProgressions(
      campaign.id,
      dueEnrollments.map((enrollment) => enrollment.contact_id),
    );
    const enrollments = excludePreviouslyManuallySentEnrollments(
      dueEnrollments,
      preparedSteps.existingSteps,
      manuallySentProgressions,
    );
    const contactIds = enrollments.map((enrollment) => enrollment.contact_id);
    const [contacts, suppressionRules] = await Promise.all([
      getContactsById(contactIds),
      getSuppressionRules(contactIds, "generate_today.load_suppression_rules"),
    ]);

    campaignInputs.push(
      Object.freeze({
        campaign,
        enrollments: Object.freeze([...enrollments]) as unknown as EnrollmentRow[],
        contacts,
        suppressionRules,
      }),
    );
  }

  return Object.freeze({
    campaigns: Object.freeze([...campaigns]) as unknown as CampaignRow[],
    existingSteps: Object.freeze([
      ...preparedSteps.existingSteps,
    ]) as unknown as CampaignStepRow[],
    stepRepairs: Object.freeze([
      ...preparedSteps.stepRepairs,
    ]) as unknown as CampaignStepRepairRow[],
    campaignInputs: Object.freeze([
      ...campaignInputs,
    ]) as unknown as PreparedCampaignInput[],
    existingScheduled,
    domainLimits,
    accountDailyLimit,
  });
}

async function persistPreparedDailyGeneration(
  prepared: PreparedDailyGeneration,
  date: string,
  requestedAt: string,
) {
  const repairedSteps = await persistCampaignStepRepairs(prepared.stepRepairs);
  const brokerDomainCounts = new Map(
    prepared.existingScheduled.brokerDomainCounts,
  );
  const campaignCounts = new Map(prepared.existingScheduled.campaignCounts);
  const campaignNewContactCounts = new Map(
    prepared.existingScheduled.campaignNewContactCounts,
  );
  const preparedAllocation = allocatePreparedDailyGeneration({
    campaigns: prepared.campaigns,
    existingSteps: prepared.existingSteps,
    persistedRepairedSteps: repairedSteps,
    campaignInputs: prepared.campaignInputs,
    date,
    evaluatedAt: requestedAt,
    domainLimits: prepared.domainLimits,
    accountDailyLimit: prepared.accountDailyLimit,
    existingAccountScheduled: Array.from(campaignCounts.values()).reduce(
      (total, count) => total + count,
      0,
    ),
    existingCampaignScheduled: campaignCounts,
    existingCampaignNewContacts: campaignNewContactCounts,
    brokerDomainCounts,
    defaultTotalLimit: DEFAULT_TOTAL_DAILY_LIMIT,
    defaultNewContactLimit: DEFAULT_NEW_CONTACTS_PER_DAY,
  });
  await stopEnrollmentsInBatches(preparedAllocation.stops);

  const policyResult = preparedAllocation.allocation;

  await persistScheduleOutcomes(policyResult.outcomes, {
    writeSchedule: (outcome) =>
      upsertScheduleRow({
        contactId: outcome.contactId,
        campaignId: outcome.campaignId,
        campaignStepId: outcome.campaignStepId,
        scheduledDate: date,
        brokerDomain: outcome.brokerDomain,
        status: outcome.status,
        reason: outcome.reason,
        safetyStatus: outcome.safetyStatus,
      }),
    rollForwardEnrollment: (outcome) =>
      rollEnrollmentForward(outcome.enrollmentId, date, 1),
    stopEnrollment: (outcome) =>
      stopEnrollment(outcome.enrollmentId, outcome.safetyStatus),
    writeSchedules: (outcomes) => upsertScheduleRows(outcomes, date),
    rollForwardEnrollments: (outcomes) =>
      rollEnrollmentsForward(outcomes, date, 1),
    stopEnrollments: (outcomes) => stopEnrollmentsInBatches(outcomes),
  });

  brokerDomainCounts.clear();
  for (const [domain, count] of policyResult.brokerDomainCounts) {
    brokerDomainCounts.set(domain, count);
  }

  return brokerDomainCounts;
}

export async function getDailySendPlan(date = getTodayDate()) {
  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("daily_send_schedule.select_today", {
    scheduledDate: date,
  });
  const { data, error } = await runScheduleQuery(
    "daily_send_schedule.select_today",
    () =>
      supabaseAdmin
        .from("daily_send_schedule")
        .select(
          "id,scheduled_date,broker_domain,status,reason,safety_status,contact_id,campaign_id,campaign_step_id",
        )
        .eq("scheduled_date", date)
        .in("status", scheduleStatuses)
        .order("broker_domain", { ascending: true })
        .returns<DailySendScheduleRow[]>(),
  );

  if (error) {
    throw createCampaignScheduleOperationError(
      "Load today's schedule failed",
      "daily_send_schedule.select_today",
      error,
    );
  }
  logScheduleOperationSuccess("daily_send_schedule.select_today", {
    rowCount: data?.length ?? 0,
    statusCounts: countRowsByStatus(data ?? []),
  });

  const rows = await enrichDailySendScheduleRows(data ?? []);
  const scheduledRows = rows.filter((row) => row.status === "scheduled");
  const accountDailyLimit = await getAccountDailyLimit();
  const summary = {
    scheduledDate: date,
    totalScheduled: scheduledRows.length,
    brokerDomainsProtected: new Set(
      rows.map((row) => row.broker_domain).filter(Boolean),
    ).size,
    skippedDueToDomainLimits: rows.filter(
      (row) => row.safety_status === "broker_domain_limit_reached",
    ).length,
    dueEmail1: countStep(scheduledRows, 1),
    dueEmail2: countStep(scheduledRows, 2),
    dueEmail3: countStep(scheduledRows, 3),
    totalDailyLimit: accountDailyLimit,
    rolledForwardTotalLimit: rows.filter(
      (row) =>
        row.safety_status === "account_limit_reached" ||
        row.safety_status === "campaign_limit_reached",
    ).length,
    rolledForwardNewContactLimit: rows.filter(
      (row) => row.safety_status === "new_contact_limit_reached",
    ).length,
    rolledForwardSafetyLimit: rows.filter(
      (row) =>
        row.status !== "scheduled" &&
        row.safety_status !== "account_limit_reached" &&
        row.safety_status !== "campaign_limit_reached" &&
        row.safety_status !== "new_contact_limit_reached" &&
        !terminalSuppressionStatuses.has(row.safety_status),
    ).length,
    stoppedByTerminalSuppression: rows.filter((row) =>
      terminalSuppressionStatuses.has(row.safety_status),
    ).length,
  };
  const diagnostics = await getSafeScheduleDiagnostics(date, summary, rows);

  return {
    summary,
    diagnostics,
    ...diagnostics,
    schedule: rows,
  };
}

export async function createStarterCampaign(date = getTodayDate()) {
  await assertCampaignScheduleSchema();

  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("campaigns.select_starter", {
    campaignName: "Real Estate Agent Follow-Up",
  });
  const { data: existingCampaigns, error: existingError } =
    await runScheduleQuery("campaigns.select_starter", () =>
      supabaseAdmin
        .from("campaigns")
        .select(
          "id,name,description,status,daily_limit,daily_send_limit,new_contacts_per_day,new_enrollments_paused,broker_domain_daily_limit,cooldown_days,stop_on_reply,stop_on_bounce,stop_on_unsubscribe",
        )
        .eq("name", "Real Estate Agent Follow-Up")
        .limit(1)
        .returns<CampaignRow[]>(),
    );

  if (existingError) {
    throw createStarterCampaignError("campaigns.select_starter", existingError);
  }
  logScheduleOperationSuccess("campaigns.select_starter", {
    found: Boolean(existingCampaigns?.[0]),
  });

  let campaign = existingCampaigns?.[0] ?? null;
  const starterCampaignAlreadyExists = Boolean(campaign);

  if (campaign) {
    logScheduleOperationStart("campaigns.update_starter", {
      campaignId: campaign.id,
    });
    const { data, error } = await runScheduleQuery(
      "campaigns.update_starter",
      () =>
        supabaseAdmin
          .from("campaigns")
          .update({
            status: "active",
            daily_limit: 25,
            daily_send_limit: 25,
            new_contacts_per_day: 8,
            broker_domain_daily_limit: 3,
            cooldown_days: 14,
            stop_on_reply: true,
            stop_on_bounce: true,
            stop_on_unsubscribe: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", campaign.id)
          .select(
            "id,name,description,status,daily_limit,daily_send_limit,new_contacts_per_day,new_enrollments_paused,broker_domain_daily_limit,cooldown_days,stop_on_reply,stop_on_bounce,stop_on_unsubscribe",
          )
          .single<CampaignRow>(),
    );

    if (error) {
      throw createStarterCampaignError("campaigns.update_starter", error);
    }
    logScheduleOperationSuccess("campaigns.update_starter", {
      campaignId: data.id,
    });

    campaign = data;
  } else {
    logScheduleOperationStart("campaigns.insert_starter", {
      campaignName: "Real Estate Agent Follow-Up",
    });
    const { data, error } = await runScheduleQuery(
      "campaigns.insert_starter",
      () =>
        supabaseAdmin
          .from("campaigns")
          .insert({
            name: "Real Estate Agent Follow-Up",
            description:
              "A trust-safe three-email follow-up sequence for real estate agent relationships.",
            status: "active",
            daily_limit: 25,
            daily_send_limit: 25,
            new_contacts_per_day: 8,
            broker_domain_daily_limit: 3,
            cooldown_days: 14,
            stop_on_reply: true,
            stop_on_bounce: true,
            stop_on_unsubscribe: true,
            updated_at: new Date().toISOString(),
          })
          .select(
            "id,name,description,status,daily_limit,daily_send_limit,new_contacts_per_day,new_enrollments_paused,broker_domain_daily_limit,cooldown_days,stop_on_reply,stop_on_bounce,stop_on_unsubscribe",
          )
          .single<CampaignRow>(),
    );

    if (error) {
      throw createStarterCampaignError("campaigns.insert_starter", error);
    }
    logScheduleOperationSuccess("campaigns.insert_starter", {
      campaignId: data.id,
    });

    campaign = data;
  }

  await ensureCampaignSteps([campaign]);
  console.info("[campaign-schedule] main action success", {
    action: "create_starter_campaign",
    campaignId: campaign.id,
    starterCampaignAlreadyExists,
  });

  const plan = await getSafeDailySendPlanAfterAction(
    date,
    "Starter campaign ready. Today's send plan could not refresh yet.",
  );

  return {
    ...plan,
    ok: true,
    message: starterCampaignAlreadyExists
      ? "Starter campaign already exists."
      : "Starter campaign created.",
    starterCampaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
    },
  };
}

export async function enrollEligibleContactsInCampaign(
  campaignId: string,
  expectedEligibleCount: number,
  date = getTodayDate(),
) {
  const enrollmentResult = await runAtomicCampaignEnrollment({
    campaignId,
    confirmedEligibleCount: expectedEligibleCount,
    enrollmentDate: date,
  });

  if (
    enrollmentResult.result === "paused" ||
    enrollmentResult.result === "stale_count"
  ) {
    throw new CampaignEnrollmentConflictError(enrollmentResult);
  }

  console.info("[campaign-schedule] main action success", {
    action: "enroll_eligible_contacts",
    campaignId,
    enrollmentResult: enrollmentResult.result,
    enrolledCount: enrollmentResult.inserted_count,
  });

  const plan = await getSafeDailySendPlanAfterAction(
    date,
    "Eligible contacts were enrolled. Today's send plan could not refresh yet.",
  );
  return {
    ...plan,
    enrolledCount: enrollmentResult.inserted_count,
    enrollmentResult,
    message: enrollmentResult.message,
  };
}

export async function resetStarterCampaignCopy(date = getTodayDate()) {
  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("campaign_steps.reset_starter_copy", {
    campaignName: "Real Estate Agent Follow-Up",
  });

  const { data: campaigns, error: campaignError } = await runScheduleQuery(
    "campaign_steps.reset_starter_copy.select_campaign",
    () =>
      supabaseAdmin
        .from("campaigns")
        .select(
          "id,name,description,status,daily_limit,daily_send_limit,new_contacts_per_day,new_enrollments_paused,broker_domain_daily_limit,cooldown_days,stop_on_reply,stop_on_bounce,stop_on_unsubscribe",
        )
        .eq("name", "Real Estate Agent Follow-Up")
        .limit(1)
        .returns<CampaignRow[]>(),
  );

  if (campaignError) {
    throw createCampaignScheduleOperationError(
      "Starter campaign lookup failed",
      "campaign_steps.reset_starter_copy.select_campaign",
      campaignError,
    );
  }

  const campaign = campaigns?.[0];

  if (!campaign) {
    throw createCampaignScheduleOperationError(
      "Starter campaign copy reset failed",
      "campaign_steps.reset_starter_copy.select_campaign",
      { message: "Starter campaign does not exist yet." },
    );
  }

  const rows = [1, 2, 3].map((stepNumber) => ({
    campaign_id: campaign.id,
    ...getDefaultCampaignStep(stepNumber),
    updated_at: new Date().toISOString(),
  }));
  const { error: upsertError } = await runScheduleQuery(
    "campaign_steps.reset_starter_copy.upsert_steps",
    () =>
      supabaseAdmin
        .from("campaign_steps")
        .upsert(rows, { onConflict: "campaign_id,step_number" }),
  );

  if (upsertError) {
    throw createCampaignScheduleOperationError(
      "Starter campaign copy reset failed",
      "campaign_steps.reset_starter_copy.upsert_steps",
      upsertError,
    );
  }
  logScheduleOperationSuccess("campaign_steps.reset_starter_copy", {
    campaignId: campaign.id,
    stepCount: rows.length,
  });

  const plan = await getSafeDailySendPlanAfterAction(
    date,
    "Starter message copy was reset. Today's send plan could not refresh yet.",
  );

  return {
    ...plan,
    ok: true,
    message: "Starter message copy reset.",
    starterCampaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
    },
  };
}

async function getActiveCampaigns() {
  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("diagnostics.active_campaigns");
  const { data, error } = await runScheduleQuery("diagnostics.active_campaigns", () =>
    supabaseAdmin
      .from("campaigns")
      .select(
        "id,name,description,status,daily_limit,daily_send_limit,new_contacts_per_day,new_enrollments_paused,broker_domain_daily_limit,cooldown_days,stop_on_reply,stop_on_bounce,stop_on_unsubscribe",
      )
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .returns<CampaignRow[]>(),
  );

  if (error) {
    throw createCampaignScheduleOperationError(
      "Active campaign diagnostics failed",
      "diagnostics.active_campaigns",
      error,
    );
  }
  logScheduleOperationSuccess("diagnostics.active_campaigns", {
    count: data?.length ?? 0,
  });

  return data ?? [];
}

async function assertCampaignScheduleSchema() {
  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("campaigns.schema_check", {
    columns: [
      "daily_send_limit",
      "new_contacts_per_day",
      "new_enrollments_paused",
      "broker_domain_daily_limit",
      "cooldown_days",
      "stop_on_reply",
      "stop_on_bounce",
      "stop_on_unsubscribe",
    ],
  });
  const { error } = await runScheduleQuery("campaigns.schema_check", () =>
    supabaseAdmin
      .from("campaigns")
      .select(
        "daily_send_limit,new_contacts_per_day,new_enrollments_paused,broker_domain_daily_limit,cooldown_days,stop_on_reply,stop_on_bounce,stop_on_unsubscribe",
      )
      .limit(1),
  );

  if (!error) {
    logScheduleOperationSuccess("campaigns.schema_check");
    return;
  }

  throw createStarterCampaignError("campaigns.schema_check", error);
}

function createStarterCampaignError(operation: string, error: SupabaseErrorLike) {
  return createCampaignScheduleOperationError(
    "Create starter campaign failed",
    operation,
    error,
  );
}

function isMissingCampaignScheduleSchemaError(error: SupabaseErrorLike) {
  const haystack = [
    error.message,
    error.code,
    error.details,
    error.hint,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    haystack.includes("daily_send_limit") ||
    haystack.includes("new_contacts_per_day") ||
    haystack.includes("new_enrollments_paused") ||
    haystack.includes("broker_domain_daily_limit") ||
    haystack.includes("stop_on_reply") ||
    haystack.includes("stop_on_bounce") ||
    haystack.includes("stop_on_unsubscribe") ||
    haystack.includes("campaign_steps") ||
    haystack.includes("schema cache") ||
    haystack.includes("could not find")
  );
}

function createCampaignScheduleOperationError(
  message: string,
  operation: string,
  error: SupabaseErrorLike,
) {
  const details = getCampaignScheduleErrorDetails(operation, error);

  logScheduleOperationError(operation, error, details);

  return new CampaignScheduleOperationError(message, details, operation, error);
}

export function isSuppressionDiagnosticsError(error: unknown) {
  const operation =
    error && typeof error === "object" && "operation" in error
      ? (error as { operation?: unknown }).operation
      : null;

  return (
    operation === "diagnostics.contact_suppression_rules" ||
    (error instanceof CampaignScheduleOperationError &&
      error.operation === "diagnostics.contact_suppression_rules")
  );
}

async function runScheduleQuery<T>(
  operation: string,
  query: () => PromiseLike<T>,
) {
  try {
    return await query();
  } catch (error) {
    const supabaseError = toSupabaseErrorLike(error);
    throw createCampaignScheduleOperationError(
      "Campaign schedule database operation failed",
      operation,
      supabaseError,
    );
  }
}

async function runNamedScheduleOperation<T>(
  operation: string,
  task: () => Promise<T>,
) {
  logScheduleOperationStart(operation);

  try {
    const result = await task();

    logScheduleOperationSuccess(operation);

    return result;
  } catch (error) {
    throw createCampaignScheduleOperationError(
      "Campaign schedule operation failed",
      operation,
      getOperationError(error),
    );
  }
}

function getOperationError(error: unknown): SupabaseErrorLike {
  if (error instanceof CampaignScheduleOperationError) {
    return (
      error.supabaseError ?? {
        message: error.details || error.message,
      }
    );
  }

  return toSupabaseErrorLike(error);
}

function toSupabaseErrorLike(error: unknown): SupabaseErrorLike {
  if (error && typeof error === "object") {
    const maybeError = error as {
      message?: unknown;
      code?: unknown;
      details?: unknown;
      hint?: unknown;
    };

    return {
      message:
        typeof maybeError.message === "string"
          ? maybeError.message
          : "Unknown database error.",
      code: typeof maybeError.code === "string" ? maybeError.code : undefined,
      details:
        typeof maybeError.details === "string" ? maybeError.details : undefined,
      hint: typeof maybeError.hint === "string" ? maybeError.hint : undefined,
    };
  }

  return {
    message: typeof error === "string" ? error : "Unknown database error.",
  };
}

function getCampaignScheduleErrorDetails(
  operation: string,
  error: SupabaseErrorLike,
) {
  const formattedError = formatSupabaseError(error);
  const lowerError = formattedError.toLowerCase();
  const isGenerateTodayOperation = operation.startsWith("generate_today.");

  if (isGenerateTodayOperation && lowerError.includes("bad request")) {
    return `${operation} failed. ${formattedError || "Bad Request"}`;
  }

  if (
    lowerError.includes("schema cache") ||
    lowerError.includes("could not find") ||
    lowerError.includes("bad request")
  ) {
    if (isMissingCampaignScheduleSchemaError(error)) {
      return `${operation} failed. Campaign schedule migration 005 appears to be missing or incomplete. Supabase schema cache may need reload. ${formattedError}`;
    }

    return `${operation} failed. Supabase schema cache may need reload. ${formattedError}`;
  }

  if (isMissingCampaignScheduleSchemaError(error)) {
    return `${operation} failed. Campaign schedule migration 005 appears to be missing or incomplete. ${formattedError}`;
  }

  return `${operation} failed. ${formattedError || "Unknown database error."}`;
}

export function formatSupabaseError(error: SupabaseErrorLike) {
  return [
    error.message ? `message: ${error.message}` : null,
    error.code ? `code: ${error.code}` : null,
    error.details ? `details: ${error.details}` : null,
    error.hint ? `hint: ${error.hint}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function logScheduleOperationStart(
  operation: string,
  metadata: Record<string, unknown> = {},
) {
  console.info("[campaign-schedule] db start", {
    operation,
    ...metadata,
  });
}

function logScheduleOperationSuccess(
  operation: string,
  metadata: Record<string, unknown> = {},
) {
  console.info("[campaign-schedule] db success", {
    operation,
    ...metadata,
  });
}

function logScheduleOperationError(
  operation: string,
  error: SupabaseErrorLike,
  details: string,
) {
  console.error("[campaign-schedule] db error", {
    operation,
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
    safeSummary: details,
  });
}

async function ensureCampaignSteps(campaigns: CampaignRow[]) {
  const prepared = await prepareCampaignSteps(campaigns);
  const repairedSteps = await persistCampaignStepRepairs(prepared.stepRepairs);

  return mergeCampaignSteps(prepared.existingSteps, repairedSteps);
}

async function prepareCampaignSteps(campaigns: CampaignRow[]) {
  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("campaign_steps.select_existing", {
    campaignCount: campaigns.length,
  });
  const { data, error } = await runScheduleQuery(
    "campaign_steps.select_existing",
    () =>
      supabaseAdmin
        .from("campaign_steps")
        .select("*")
        .in(
          "campaign_id",
          campaigns.map((campaign) => campaign.id),
        )
        .returns<CampaignStepRow[]>(),
  );

  if (error) {
    throw createCampaignScheduleOperationError(
      "Campaign steps lookup failed",
      "campaign_steps.select_existing",
      error,
    );
  }
  logScheduleOperationSuccess("campaign_steps.select_existing", {
    existingStepCount: data?.length ?? 0,
  });

  const existingSteps = data ?? [];
  const stepRepairs = planCampaignStepRepairs(
    campaigns,
    existingSteps,
    new Date().toISOString(),
  );

  return { existingSteps, stepRepairs };
}

async function persistCampaignStepRepairs(stepRepairs: CampaignStepRepairRow[]) {
  if (stepRepairs.length === 0) {
    return [];
  }

  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("campaign_steps.upsert_defaults", {
    stepCount: stepRepairs.length,
  });
  const { data: upsertedSteps, error: upsertError } = await runScheduleQuery(
    "campaign_steps.upsert_defaults",
    () =>
      supabaseAdmin
        .from("campaign_steps")
        .upsert(stepRepairs, { onConflict: "campaign_id,step_number" })
        .select("*")
        .returns<CampaignStepRow[]>(),
  );

  if (upsertError) {
    throw createCampaignScheduleOperationError(
      "Campaign steps upsert failed",
      "campaign_steps.upsert_defaults",
      upsertError,
    );
  }
  logScheduleOperationSuccess("campaign_steps.upsert_defaults", {
    upsertedStepCount: upsertedSteps?.length ?? 0,
  });

  return upsertedSteps ?? [];
}

async function getScheduleDiagnostics(
  date: string,
  summary: DailySendPlanSummary,
  scheduleRows: DailySendPlanRow[],
) {
  logScheduleOperationStart("diagnostics.build", {
    scheduledDate: date,
    scheduleRowCount: scheduleRows.length,
  });
  const [campaigns, eligibleContactDiagnostics] = await Promise.all([
    getActiveCampaigns(),
    getEligibleContactDiagnostics(),
  ]);
  const activeCampaignIds = campaigns.map((campaign) => campaign.id);
  const [campaignStepCount, enrolledContactCount] = await Promise.all([
    getCampaignStepCount(activeCampaignIds),
    getEnrolledContactCount(activeCampaignIds),
  ]);

  const diagnostics = {
    hasActiveCampaign: campaigns.length > 0,
    activeCampaignCount: campaigns.length,
    eligibleContactCount: eligibleContactDiagnostics.eligibleContactCount,
    enrolledContactCount,
    hasCampaignSteps: campaignStepCount > 0,
    campaignStepCount,
    suppressionRulesCount: eligibleContactDiagnostics.suppressionRulesCount,
    diagnosticsError: null,
    diagnosticsWarning: eligibleContactDiagnostics.diagnosticsWarning,
    reason: getZeroScheduleReason({
      summary,
      scheduleRows,
      activeCampaignCount: campaigns.length,
      eligibleContactCount: eligibleContactDiagnostics.eligibleContactCount,
      enrolledContactCount,
      campaignStepCount,
      date,
    }),
  };

  logScheduleOperationSuccess("diagnostics.build", {
    activeCampaignCount: diagnostics.activeCampaignCount,
    eligibleContactCount: diagnostics.eligibleContactCount,
    enrolledContactCount: diagnostics.enrolledContactCount,
    campaignStepCount: diagnostics.campaignStepCount,
    suppressionRulesCount: diagnostics.suppressionRulesCount,
    diagnosticsWarning: diagnostics.diagnosticsWarning,
  });

  return diagnostics;
}

async function getSafeScheduleDiagnostics(
  date: string,
  summary: DailySendPlanSummary,
  scheduleRows: DailySendPlanRow[],
): Promise<DailySendPlanDiagnostics> {
  try {
    return await getScheduleDiagnostics(date, summary, scheduleRows);
  } catch (error) {
    if (isSuppressionDiagnosticsError(error)) {
      console.warn("[campaign-schedule] diagnostics.contact_suppression_rules warning", {
        warning: suppressionDiagnosticsWarning,
      });

      return {
        hasActiveCampaign: false,
        activeCampaignCount: 0,
        eligibleContactCount: 0,
        enrolledContactCount: 0,
        hasCampaignSteps: false,
        campaignStepCount: 0,
        suppressionRulesCount: 0,
        diagnosticsError: null,
        diagnosticsWarning: suppressionDiagnosticsWarning,
        reason:
          scheduleRows.length === 0
            ? "No contacts are enrolled yet. Enroll eligible contacts before generating today's plan."
            : null,
      };
    }

    const operation =
      error instanceof CampaignScheduleOperationError
        ? error.operation
        : "diagnostics.build";
    const details =
      error instanceof CampaignScheduleOperationError
        ? error.details
        : error instanceof Error
        ? error.message
        : "Unable to build campaign schedule diagnostics.";

    console.error("[campaign-schedule] diagnostics error", {
      operation,
      error: details,
    });

    return {
      hasActiveCampaign: false,
      activeCampaignCount: 0,
      eligibleContactCount: 0,
      enrolledContactCount: 0,
      hasCampaignSteps: false,
      campaignStepCount: 0,
      suppressionRulesCount: 0,
      diagnosticsError: details,
      diagnosticsWarning: null,
      reason:
        scheduleRows.length === 0
          ? "No contacts are enrolled yet. Enroll eligible contacts before generating today's plan."
          : null,
    };
  }
}

async function getSafeDailySendPlanAfterAction(date: string, reason: string) {
  try {
    return await getDailySendPlan(date);
  } catch (error) {
    if (isSuppressionDiagnosticsError(error)) {
      const plan = createEmptyDailySendPlan(date, null);

      return {
        ...plan,
        ok: true,
        diagnostics: {
          ...plan.diagnostics,
          diagnosticsWarning: suppressionDiagnosticsWarning,
          suppressionRulesCount: 0,
          reason,
        },
        diagnosticsWarning: suppressionDiagnosticsWarning,
        suppressionRulesCount: 0,
        reason,
      };
    }

    const details =
      error instanceof CampaignScheduleOperationError
        ? error.details
        : error instanceof Error
          ? error.message
          : "Unable to reload today's send plan after the campaign schedule action.";

    console.error("[campaign-schedule] post-action plan reload error", {
      operation:
        error instanceof CampaignScheduleOperationError
          ? error.operation
          : "getDailySendPlan",
      error: details,
    });

    return {
      ...createEmptyDailySendPlan(date, null),
      ok: true,
      diagnostics: {
        ...createEmptyDailySendPlan(date).diagnostics,
        diagnosticsError: details,
        reason,
      },
      diagnosticsError: details,
      reason,
    };
  }
}

async function getEligibleContactDiagnostics() {
  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("diagnostics.eligible_contacts");
  const { data: contacts, error } = await runScheduleQuery(
    "diagnostics.eligible_contacts",
    () =>
      supabaseAdmin
        .from("hubspot_contacts")
        .select("id,email,is_unsubscribed")
        .not("email", "is", null)
        .eq("is_unsubscribed", false)
        .returns<
          Array<{ id: string; email: string | null; is_unsubscribed: boolean }>
        >(),
  );

  if (error) {
    throw createCampaignScheduleOperationError(
      "Eligible contact diagnostics failed",
      "diagnostics.eligible_contacts",
      error,
    );
  }

  if (!contacts || contacts.length === 0) {
    logScheduleOperationSuccess("diagnostics.eligible_contacts", {
      count: 0,
      suppressionRulesCount: 0,
    });
    return {
      eligibleContactCount: 0,
      suppressionRulesCount: 0,
      diagnosticsWarning: null,
    };
  }

  const suppressionRules = await getOptionalSuppressionRulesForDiagnostics(
    contacts.map((contact) => contact.id),
  );

  const eligibleContactCount = contacts.filter(
    (contact) => (suppressionRules.rulesByContact.get(contact.id) ?? []).length === 0,
  ).length;
  logScheduleOperationSuccess("diagnostics.eligible_contacts", {
    count: eligibleContactCount,
    suppressionRulesCount: suppressionRules.ruleCount,
    diagnosticsWarning: suppressionRules.warning,
  });

  return {
    eligibleContactCount,
    suppressionRulesCount: suppressionRules.ruleCount,
    diagnosticsWarning: suppressionRules.warning,
  };
}

async function getCampaignStepCount(campaignIds: string[]) {
  if (campaignIds.length === 0) {
    return 0;
  }

  const uniqueCampaignIds = Array.from(new Set(campaignIds));
  const campaignIdChunks = chunkArray(uniqueCampaignIds, contactLookupChunkSize);
  const supabaseAdmin = getSupabaseAdmin();

  logScheduleOperationStart("diagnostics.campaign_step_count", {
    campaignCount: uniqueCampaignIds.length,
    chunkCount: campaignIdChunks.length,
    chunkSize: contactLookupChunkSize,
  });

  let countTotal = 0;

  for (const [chunkIndex, campaignIdChunk] of campaignIdChunks.entries()) {
    const chunkNumber = chunkIndex + 1;
    logScheduleOperationStart("diagnostics.campaign_step_count.chunk", {
      chunkNumber,
      chunkCount: campaignIdChunks.length,
      chunkSize: campaignIdChunk.length,
    });

    const { count, error } = await runScheduleQuery(
      "diagnostics.campaign_step_count",
      () =>
        supabaseAdmin
          .from("campaign_steps")
          .select("id", { count: "exact", head: true })
          .in("campaign_id", campaignIdChunk),
    );

    if (error) {
      throw createCampaignScheduleOperationError(
        "Campaign step diagnostics failed",
        "diagnostics.campaign_step_count",
        error,
      );
    }

    countTotal += count ?? 0;
    logScheduleOperationSuccess("diagnostics.campaign_step_count.chunk", {
      chunkNumber,
      returnedCount: count ?? 0,
    });
  }

  logScheduleOperationSuccess("diagnostics.campaign_step_count", {
    count: countTotal,
  });

  return countTotal;
}

async function getEnrolledContactCount(campaignIds: string[]) {
  if (campaignIds.length === 0) {
    return 0;
  }

  const uniqueCampaignIds = Array.from(new Set(campaignIds));
  const campaignIdChunks = chunkArray(uniqueCampaignIds, contactLookupChunkSize);
  const supabaseAdmin = getSupabaseAdmin();

  logScheduleOperationStart("diagnostics.enrolled_contact_count", {
    campaignCount: uniqueCampaignIds.length,
    chunkCount: campaignIdChunks.length,
    chunkSize: contactLookupChunkSize,
  });

  let countTotal = 0;

  for (const [chunkIndex, campaignIdChunk] of campaignIdChunks.entries()) {
    const chunkNumber = chunkIndex + 1;
    logScheduleOperationStart("diagnostics.enrolled_contact_count.chunk", {
      chunkNumber,
      chunkCount: campaignIdChunks.length,
      chunkSize: campaignIdChunk.length,
    });

    const { count, error } = await runScheduleQuery(
      "diagnostics.enrolled_contact_count",
      () =>
        supabaseAdmin
          .from("contact_campaign_enrollments")
          .select("id", { count: "exact", head: true })
          .in("campaign_id", campaignIdChunk)
          .eq("status", "active"),
    );

    if (error) {
      throw createCampaignScheduleOperationError(
        "Enrollment diagnostics failed",
        "diagnostics.enrolled_contact_count",
        error,
      );
    }

    countTotal += count ?? 0;
    logScheduleOperationSuccess("diagnostics.enrolled_contact_count.chunk", {
      chunkNumber,
      returnedCount: count ?? 0,
    });
  }

  logScheduleOperationSuccess("diagnostics.enrolled_contact_count", {
    count: countTotal,
  });

  return countTotal;
}

function getZeroScheduleReason({
  summary,
  scheduleRows,
  activeCampaignCount,
  eligibleContactCount,
  enrolledContactCount,
  campaignStepCount,
}: {
  summary: DailySendPlanSummary;
  scheduleRows: DailySendPlanRow[];
  activeCampaignCount: number;
  eligibleContactCount: number;
  enrolledContactCount: number;
  campaignStepCount: number;
  date: string;
}) {
  if (summary.totalScheduled > 0) {
    return null;
  }

  if (activeCampaignCount === 0) {
    return "No active campaign yet. Create a starter campaign before generating today's plan.";
  }

  if (campaignStepCount === 0) {
    return "No campaign steps exist yet. Add Email 1, Email 2, and Email 3 before generating today's plan.";
  }

  if (scheduleRows.length > 0) {
    return "No new contacts are due today. Existing scheduled contacts/drafts are shown below.";
  }

  if (eligibleContactCount === 0) {
    return "No new contacts are ready today. Contacts may be protected, recently contacted, or held for a future day.";
  }

  if (enrolledContactCount === 0) {
    return "No contacts are enrolled yet. Enroll eligible HubSpot contacts into the campaign.";
  }

  if (scheduleRows.some((row) => row.safety_status === "broker_domain_limit_reached")) {
    return "Contacts were held for a future day because broker or company domain limits are protecting your sender reputation.";
  }

  return "No enrolled contacts are due today. Enrolled contacts may be waiting for their next Email 2 or Email 3 date.";
}

async function enrichDailySendScheduleRows(
  rows: DailySendScheduleRow[],
): Promise<DailySendPlanRow[]> {
  if (rows.length === 0) {
    return [];
  }

  const supabaseAdmin = getSupabaseAdmin();
  const contactIds = Array.from(new Set(rows.map((row) => row.contact_id)));
  const campaignIds = Array.from(new Set(rows.map((row) => row.campaign_id)));
  const stepIds = Array.from(new Set(rows.map((row) => row.campaign_step_id)));

  const uniqueCampaignIds = Array.from(new Set(campaignIds));
  const uniqueStepIds = Array.from(new Set(stepIds));
  const campaignChunks = chunkArray(uniqueCampaignIds, contactLookupChunkSize);
  const stepChunks = chunkArray(uniqueStepIds, contactLookupChunkSize);

  const campaigns: Array<{ id: string; name: string }> = [];
  const steps: Array<{ id: string; step_number: number }> = [];

  for (const campaignChunk of campaignChunks) {
    const { data, error } = await runScheduleQuery(
      "daily_send_schedule.load_campaigns",
      () =>
        supabaseAdmin
          .from("campaigns")
          .select("id,name")
          .in("id", campaignChunk)
          .returns<Array<{ id: string; name: string }>>(),
    );

    if (error) {
      throw createCampaignScheduleOperationError(
        "Daily send schedule campaign load failed",
        "daily_send_schedule.load_campaigns",
        error,
      );
    }

    campaigns.push(...(data ?? []));
  }

  for (const stepChunk of stepChunks) {
    const { data, error } = await runScheduleQuery(
      "daily_send_schedule.load_steps",
      () =>
        supabaseAdmin
          .from("campaign_steps")
          .select("id,step_number")
          .in("id", stepChunk)
          .returns<Array<{ id: string; step_number: number }>>(),
    );

    if (error) {
      throw createCampaignScheduleOperationError(
        "Daily send schedule step load failed",
        "daily_send_schedule.load_steps",
        error,
      );
    }

    steps.push(...(data ?? []));
  }

  const contacts = await loadDailyScheduleContacts(contactIds);
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const campaignsById = new Map(
    (campaigns ?? []).map((campaign) => [campaign.id, campaign]),
  );
  const stepsById = new Map((steps ?? []).map((step) => [step.id, step]));

  return rows.map((row) => ({
    ...row,
    hubspot_contacts: contactsById.get(row.contact_id) ?? null,
    campaigns: campaignsById.get(row.campaign_id)
      ? { name: campaignsById.get(row.campaign_id)!.name }
      : null,
    campaign_steps: stepsById.get(row.campaign_step_id)
      ? { step_number: stepsById.get(row.campaign_step_id)!.step_number }
      : null,
  }));
}

async function loadDailyScheduleContacts(contactIds: string[]) {
  if (contactIds.length === 0) {
    return [];
  }

  const uniqueContactIds = Array.from(new Set(contactIds));
  const supabaseAdmin = getSupabaseAdmin();
  const contacts: Array<{
    id: string;
    hubspot_contact_id: string | null;
    first_name: string | null;
    last_name: string | null;
    company: string | null;
    email: string | null;
    is_unsubscribed: boolean | null;
  }> = [];
  const contactIdChunks = chunkArray(uniqueContactIds, scheduleContactLookupChunkSize);

  logScheduleOperationStart("daily_send_schedule.load_contacts", {
    contactCount: uniqueContactIds.length,
    chunkCount: contactIdChunks.length,
    chunkSize: scheduleContactLookupChunkSize,
  });

  for (let chunkIndex = 0; chunkIndex < contactIdChunks.length; chunkIndex += 1) {
    const contactIdChunk = contactIdChunks[chunkIndex];

    logScheduleOperationStart("daily_send_schedule.load_contacts.chunk", {
      chunkNumber: chunkIndex + 1,
      chunkCount: contactIdChunks.length,
      chunkSize: contactIdChunk.length,
    });

    const { data, error } = await runScheduleQuery(
      "daily_send_schedule.load_contacts",
      () =>
        supabaseAdmin
          .from("hubspot_contacts")
          .select("id,hubspot_contact_id,email,first_name,last_name,company,is_unsubscribed")
          .in("id", contactIdChunk)
          .returns<
            Array<{
              id: string;
              hubspot_contact_id: string | null;
              first_name: string | null;
              last_name: string | null;
              company: string | null;
              email: string | null;
              is_unsubscribed: boolean | null;
            }>
          >(),
    );

    if (error) {
      throw createCampaignScheduleOperationError(
        `Daily send schedule contact load failed in chunk ${chunkIndex + 1}.`,
        "daily_send_schedule.load_contacts",
        error,
      );
    }

    contacts.push(...(data ?? []));
    logScheduleOperationSuccess("daily_send_schedule.load_contacts.chunk", {
      chunkNumber: chunkIndex + 1,
      rowCount: data?.length ?? 0,
    });
  }

  logScheduleOperationSuccess("daily_send_schedule.load_contacts", {
    contactCount: contacts.length,
  });

  return contacts;
}

async function getDueEnrollments(
  campaignId: string,
  date: string,
  maxStepNumber: number,
) {
  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("generate_today.load_enrollments", {
    campaignId,
    scheduledDate: date,
    pageSize: dueEnrollmentPageSize,
  });
  const data = await loadAllDeterministicPages(async (from, to) => {
    const { data: page, error } = await runScheduleQuery(
      "generate_today.load_enrollments",
      () =>
        supabaseAdmin
          .from("contact_campaign_enrollments")
          .select("*")
          .eq("campaign_id", campaignId)
          .eq("status", "active")
          .lte("next_send_date", date)
          .lte("current_step", maxStepNumber)
          .order("current_step", { ascending: false })
          .order("next_send_date", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to)
          .returns<EnrollmentRow[]>(),
    );

    if (error) {
      throw createCampaignScheduleOperationError(
        "Due enrollment load failed",
        "generate_today.load_enrollments",
        error,
      );
    }

    return page ?? [];
  }, dueEnrollmentPageSize);

  logScheduleOperationSuccess("generate_today.load_enrollments", {
    campaignId,
    enrollmentCount: data.length,
    eligibleEnrollmentsCount: data.length,
  });

  return data;
}

async function getManuallySentProgressions(
  campaignId: string,
  contactIds: string[],
) {
  const uniqueContactIds = Array.from(new Set(contactIds));
  const progressionKeys = new Set<string>();

  if (uniqueContactIds.length === 0) return progressionKeys;

  const supabaseAdmin = getSupabaseAdmin();

  for (const contactChunk of chunkArray(uniqueContactIds, contactLookupChunkSize)) {
    const schedules = await loadAllDeterministicPages(async (from, to) => {
      const { data, error } = await runScheduleQuery(
        "generate_today.load_manual_send_schedules",
        () =>
          supabaseAdmin
            .from("daily_send_schedule")
            .select("id,contact_id,campaign_id,campaign_step_id")
            .eq("campaign_id", campaignId)
            .in("contact_id", contactChunk)
            .order("id", { ascending: true })
            .range(from, to)
            .returns<
              Array<{
                id: string;
                contact_id: string;
                campaign_id: string;
                campaign_step_id: string;
              }>
            >(),
      );

      if (error) {
        throw createCampaignScheduleOperationError(
          "Manual-send schedule history load failed",
          "generate_today.load_manual_send_schedules",
          error,
        );
      }

      return data ?? [];
    }, dueEnrollmentPageSize);

    const schedulesById = new Map(schedules.map((schedule) => [schedule.id, schedule]));

    for (const scheduleIdChunk of chunkArray(
      Array.from(schedulesById.keys()),
      contactLookupChunkSize,
    )) {
      const { data, error } = await runScheduleQuery(
        "generate_today.load_manually_sent_drafts",
        () =>
          supabaseAdmin
            .from("email_drafts")
            .select("schedule_id")
            .eq("status", "manually_sent")
            .in("schedule_id", scheduleIdChunk)
            .returns<Array<{ schedule_id: string }>>(),
      );

      if (error) {
        throw createCampaignScheduleOperationError(
          "Manual-send draft history load failed",
          "generate_today.load_manually_sent_drafts",
          error,
        );
      }

      for (const draft of data ?? []) {
        const schedule = schedulesById.get(draft.schedule_id);
        if (!schedule) continue;
        progressionKeys.add(
          getManualSendProgressionKey(
            schedule.contact_id,
            schedule.campaign_id,
            schedule.campaign_step_id,
          ),
        );
      }
    }
  }

  return progressionKeys;
}

async function getContactsById(contactIds: string[]) {
  if (contactIds.length === 0) {
    return new Map<string, HubSpotContactScheduleRow>();
  }

  const uniqueContactIds = Array.from(new Set(contactIds));
  const contactIdChunks = chunkArray(uniqueContactIds, contactLookupChunkSize);
  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("generate_today.load_contacts", {
    contactIdsCount: uniqueContactIds.length,
    chunkSize: contactLookupChunkSize,
    chunkCount: contactIdChunks.length,
  });

  const contacts: HubSpotContactScheduleRow[] = [];

  for (const [chunkIndex, contactIdChunk] of contactIdChunks.entries()) {
    const chunkNumber = chunkIndex + 1;

    logScheduleOperationStart("generate_today.load_contacts.chunk", {
      contactIdsCount: uniqueContactIds.length,
      chunkSize: contactLookupChunkSize,
      chunkNumber,
      chunkCount: contactIdChunks.length,
      chunkContactCount: contactIdChunk.length,
    });

    let data: HubSpotContactScheduleRow[] | null = null;
    let error: SupabaseErrorLike | null = null;

    try {
      const response = await runScheduleQuery(
        "generate_today.load_contacts",
        () =>
          supabaseAdmin
            .from("hubspot_contacts")
            .select(
              "id,hubspot_contact_id,email,first_name,last_name,company,is_unsubscribed,last_contacted_at,last_engaged_at,raw_properties",
            )
            .in("id", contactIdChunk)
            .returns<HubSpotContactScheduleRow[]>(),
      );

      data = response.data ?? null;
      error = response.error ?? null;
    } catch (chunkLoadError) {
      error = getOperationError(chunkLoadError);
    }

    if (error) {
      const chunkError = withChunkDetails(
        error,
        chunkNumber,
        contactIdChunks.length,
        contactIdChunk.length,
      );

      console.error("[campaign-schedule] db error", {
        operation: "generate_today.load_contacts",
        chunkNumber,
        chunkCount: contactIdChunks.length,
        chunkContactCount: contactIdChunk.length,
        safeSummary: formatSupabaseError(chunkError),
      });

      throw createCampaignScheduleOperationError(
        "HubSpot contact load failed",
        "generate_today.load_contacts",
        chunkError,
      );
    }

    logScheduleOperationSuccess("generate_today.load_contacts.chunk", {
      chunkNumber,
      chunkCount: contactIdChunks.length,
      chunkContactCount: contactIdChunk.length,
      returnedContactCount: data?.length ?? 0,
    });
    contacts.push(...(data ?? []));
  }

  logScheduleOperationSuccess("generate_today.load_contacts", {
    contactIdsCount: uniqueContactIds.length,
    chunkSize: contactLookupChunkSize,
    chunkCount: contactIdChunks.length,
    returnedContactCount: contacts.length,
  });

  return new Map(contacts.map((contact) => [contact.id, contact]));
}

async function getOptionalSuppressionRulesForDiagnostics(contactIds: string[]) {
  try {
    const rulesByContact = await getSuppressionRules(contactIds);

    return {
      rulesByContact,
      ruleCount: countSuppressionRules(rulesByContact),
      warning: null,
    };
  } catch (error) {
    const details =
      error instanceof CampaignScheduleOperationError
        ? error.details
        : error instanceof Error
        ? error.message
        : "Unable to load contact_suppression_rules diagnostics.";

    console.warn("[campaign-schedule] diagnostics warning", {
      operation:
        error instanceof CampaignScheduleOperationError
          ? error.operation
          : "diagnostics.contact_suppression_rules",
      warning: suppressionDiagnosticsWarning,
      error: details,
    });

    return {
      rulesByContact: new Map<string, SuppressionRuleRow[]>(),
      ruleCount: 0,
      warning: suppressionDiagnosticsWarning,
    };
  }
}

async function getSuppressionRules(
  contactIds: string[],
  operation = "diagnostics.contact_suppression_rules",
) {
  if (contactIds.length === 0) {
    return new Map<string, SuppressionRuleRow[]>();
  }

  const uniqueContactIds = Array.from(new Set(contactIds));
  const contactIdChunks = chunkArray(uniqueContactIds, contactLookupChunkSize);
  const supabaseAdmin = getSupabaseAdmin();
  const rulesByContact = new Map<string, SuppressionRuleRow[]>();

  logScheduleOperationStart(operation, {
    contactCount: uniqueContactIds.length,
    chunkCount: contactIdChunks.length,
    chunkSize: contactLookupChunkSize,
  });

  for (const [chunkIndex, contactIdChunk] of contactIdChunks.entries()) {
    const chunkNumber = chunkIndex + 1;
    logScheduleOperationStart(`${operation}.chunk`, {
      chunkNumber,
      chunkCount: contactIdChunks.length,
      chunkSize: contactIdChunk.length,
    });

    const { data, error } = await runScheduleQuery(
      operation,
      () =>
        supabaseAdmin
          .from("contact_suppression_rules")
          .select("contact_id,suppression_type,reason,snoozed_until")
          .in("contact_id", contactIdChunk)
          .eq("active", true)
          .returns<SuppressionRuleRow[]>(),
    );

    if (error) {
      throw createCampaignScheduleOperationError(
        "Suppression rule diagnostics failed",
        operation,
        error,
      );
    }

    for (const rule of data ?? []) {
      const existingRules = rulesByContact.get(rule.contact_id) ?? [];
      existingRules.push(rule);
      rulesByContact.set(rule.contact_id, existingRules);
    }

    logScheduleOperationSuccess(`${operation}.chunk`, {
      chunkNumber,
      ruleCount: data?.length ?? 0,
    });
  }

  logScheduleOperationSuccess(operation, {
    ruleCount: Array.from(rulesByContact.values()).reduce(
      (total, rules) => total + rules.length,
      0,
    ),
  });

  return rulesByContact;
}

function countSuppressionRules(rulesByContact: Map<string, SuppressionRuleRow[]>) {
  let ruleCount = 0;

  for (const rules of rulesByContact.values()) {
    ruleCount += rules.length;
  }

  return ruleCount;
}

async function getBrokerDomainLimits() {
  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("generate_today.compute_domain_limits");
  const { data, error } = await runScheduleQuery(
    "generate_today.compute_domain_limits",
    () =>
      supabaseAdmin
        .from("broker_domain_limits")
        .select("broker_domain,daily_limit")
        .eq("status", "active")
        .returns<DomainLimitRow[]>(),
  );

  if (error) {
    throw createCampaignScheduleOperationError(
      "Broker domain limit load failed",
      "generate_today.compute_domain_limits",
      error,
    );
  }
  logScheduleOperationSuccess("generate_today.compute_domain_limits", {
    limitCount: data?.length ?? 0,
  });

  return new Map((data ?? []).map((limit) => [limit.broker_domain, limit.daily_limit]));
}

async function getAccountDailyLimit() {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await runScheduleQuery(
    "generate_today.load_account_daily_limit",
    () =>
      supabaseAdmin
        .from("sending_settings")
        .select("daily_send_limit")
        .order("created_at", { ascending: true })
        .limit(1)
        .returns<Array<{ daily_send_limit: number }>>(),
  );

  if (error) {
    throw createCampaignScheduleOperationError(
      "Account daily limit load failed",
      "generate_today.load_account_daily_limit",
      error,
    );
  }

  return normalizeDailyLimit(
    data?.[0]?.daily_send_limit,
    DEFAULT_TOTAL_DAILY_LIMIT,
  );
}

async function getExistingScheduledCounts(date: string) {
  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("generate_today.load_existing_schedule", {
    scheduledDate: date,
  });
  const { data, error } = await runScheduleQuery(
    "generate_today.load_existing_schedule",
    () =>
      supabaseAdmin
        .from("daily_send_schedule")
        .select("broker_domain,campaign_id,campaign_step_id,contact_id,scheduled_date,status,campaign_steps(step_number)")
        .eq("scheduled_date", date)
        .returns<
          Array<{
            broker_domain: string;
            campaign_id: string;
            campaign_step_id: string;
            contact_id: string;
            scheduled_date: string;
            status: string;
            campaign_steps: { step_number: number } | null;
          }>
        >(),
  );

  if (error) {
    throw createCampaignScheduleOperationError(
      "Existing schedule load failed",
      "generate_today.load_existing_schedule",
      error,
    );
  }

  const brokerDomainCounts = new Map<string, number>();
  const campaignCounts = new Map<string, number>();
  const campaignNewContactCounts = new Map<string, number>();
  const existingScheduleKeys = new Set<string>();

  for (const row of data ?? []) {
    existingScheduleKeys.add(
      getScheduleConflictKey({
        contactId: row.contact_id,
        campaignId: row.campaign_id,
        campaignStepId: row.campaign_step_id,
        scheduledDate: row.scheduled_date,
      }),
    );

    if (row.status !== "scheduled") {
      continue;
    }

    brokerDomainCounts.set(
      row.broker_domain,
      (brokerDomainCounts.get(row.broker_domain) ?? 0) + 1,
    );
    campaignCounts.set(row.campaign_id, (campaignCounts.get(row.campaign_id) ?? 0) + 1);
    if (row.campaign_steps?.step_number === 1) {
      campaignNewContactCounts.set(
        row.campaign_id,
        (campaignNewContactCounts.get(row.campaign_id) ?? 0) + 1,
      );
    }
  }
  logScheduleOperationSuccess("generate_today.load_existing_schedule", {
    rowCount: data?.length ?? 0,
    scheduledRowCount: Array.from(campaignCounts.values()).reduce(
      (total, count) => total + count,
      0,
    ),
    existingScheduleKeyCount: existingScheduleKeys.size,
  });

  return {
    brokerDomainCounts,
    campaignCounts,
    campaignNewContactCounts,
    existingScheduleKeys,
  };
}

async function hasExistingScheduleRows(date: string) {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await runScheduleQuery(
    "generate_today.check_existing_plan",
    () =>
      supabaseAdmin
        .from("daily_send_schedule")
        .select("id")
        .eq("scheduled_date", date)
        .limit(1)
        .returns<Array<{ id: string }>>(),
  );

  if (error) {
    throw createCampaignScheduleOperationError(
      "Existing plan check failed",
      "generate_today.check_existing_plan",
      error,
    );
  }

  return (data?.length ?? 0) > 0;
}

function getScheduleConflictKey({
  contactId,
  campaignId,
  campaignStepId,
  scheduledDate,
}: {
  contactId: string;
  campaignId: string;
  campaignStepId: string;
  scheduledDate: string;
}) {
  return [contactId, campaignId, campaignStepId, scheduledDate].join("|");
}

async function upsertScheduleRow(row: {
  contactId: string;
  campaignId: string;
  campaignStepId: string;
  scheduledDate: string;
  brokerDomain: string;
  status: string;
  reason: string;
  safetyStatus: string;
}) {
  const supabaseAdmin = getSupabaseAdmin();
  logScheduleOperationStart("generate_today.upsert_schedule", {
    status: row.status,
    safetyStatus: row.safetyStatus,
  });
  const { error } = await runScheduleQuery(
    "generate_today.upsert_schedule",
    () =>
      supabaseAdmin.from("daily_send_schedule").upsert(
        {
          contact_id: row.contactId,
          campaign_id: row.campaignId,
          campaign_step_id: row.campaignStepId,
          scheduled_date: row.scheduledDate,
          broker_domain: row.brokerDomain,
          status: row.status,
          reason: row.reason,
          safety_status: row.safetyStatus,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "contact_id,campaign_id,campaign_step_id,scheduled_date" },
      ),
  );

  if (error) {
    throw createCampaignScheduleOperationError(
      "Daily send schedule upsert failed",
      "generate_today.upsert_schedule",
      error,
    );
  }
  logScheduleOperationSuccess("generate_today.upsert_schedule", {
    status: row.status,
    safetyStatus: row.safetyStatus,
  });
}

async function upsertScheduleRows(outcomes: ScheduleOutcome[], date: string) {
  const supabaseAdmin = getSupabaseAdmin();
  const updatedAt = new Date().toISOString();

  for (const batch of chunkArray(outcomes, 100)) {
    const { error } = await runScheduleQuery(
      "generate_today.upsert_schedule_batch",
      () =>
        supabaseAdmin.from("daily_send_schedule").upsert(
          batch.map((outcome) => ({
            contact_id: outcome.contactId,
            campaign_id: outcome.campaignId,
            campaign_step_id: outcome.campaignStepId,
            scheduled_date: date,
            broker_domain: outcome.brokerDomain,
            status: outcome.status,
            reason: outcome.reason,
            safety_status: outcome.safetyStatus,
            updated_at: updatedAt,
          })),
          { onConflict: "contact_id,campaign_id,campaign_step_id,scheduled_date" },
        ),
    );

    if (error) {
      throw createCampaignScheduleOperationError(
        "Daily send schedule batch upsert failed",
        "generate_today.upsert_schedule_batch",
        error,
      );
    }
  }
}

async function rollEnrollmentsForward(
  outcomes: ScheduleOutcome[],
  date: string,
  days: number,
) {
  const supabaseAdmin = getSupabaseAdmin();

  for (const batch of chunkArray(outcomes, 100)) {
    const { error } = await runScheduleQuery(
      "generate_today.roll_forward_batch",
      () =>
        supabaseAdmin
          .from("contact_campaign_enrollments")
          .update({
            next_send_date: addDays(date, days),
            updated_at: new Date().toISOString(),
          })
          .in("id", batch.map((outcome) => outcome.enrollmentId)),
    );

    if (error) {
      throw createCampaignScheduleOperationError(
        "Enrollment batch roll-forward failed",
        "generate_today.roll_forward_batch",
        error,
      );
    }
  }
}

async function stopEnrollmentsInBatches(
  outcomes: Array<{ enrollmentId: string; safetyStatus: string }>,
) {
  const supabaseAdmin = getSupabaseAdmin();
  const outcomesByReason = new Map<
    string,
    Array<{ enrollmentId: string; safetyStatus: string }>
  >();

  for (const outcome of outcomes) {
    const groupedOutcomes = outcomesByReason.get(outcome.safetyStatus) ?? [];
    groupedOutcomes.push(outcome);
    outcomesByReason.set(outcome.safetyStatus, groupedOutcomes);
  }

  for (const [stoppedReason, groupedOutcomes] of outcomesByReason) {
    for (const batch of chunkArray(groupedOutcomes, 100)) {
      const { error } = await runScheduleQuery(
        "generate_today.stop_enrollment_batch",
        () =>
          supabaseAdmin
            .from("contact_campaign_enrollments")
            .update({
              status: "stopped",
              stopped_reason: stoppedReason,
              updated_at: new Date().toISOString(),
            })
            .in("id", batch.map((outcome) => outcome.enrollmentId)),
      );

      if (error) {
        throw createCampaignScheduleOperationError(
          "Enrollment batch stop failed",
          "generate_today.stop_enrollment_batch",
          error,
        );
      }
    }
  }
}

async function rollEnrollmentForward(enrollmentId: string, date: string, days: number) {
  const supabaseAdmin = getSupabaseAdmin();
  const { error } = await runScheduleQuery(
    "generate_today.upsert_schedule",
    () =>
      supabaseAdmin
        .from("contact_campaign_enrollments")
        .update({
          next_send_date: addDays(date, days),
          updated_at: new Date().toISOString(),
        })
        .eq("id", enrollmentId),
  );

  if (error) {
    throw createCampaignScheduleOperationError(
      "Enrollment roll-forward failed",
      "generate_today.upsert_schedule",
      error,
    );
  }
}

async function stopEnrollment(enrollmentId: string, stoppedReason: string) {
  const supabaseAdmin = getSupabaseAdmin();
  const { error } = await runScheduleQuery(
    "generate_today.upsert_schedule",
    () =>
      supabaseAdmin
        .from("contact_campaign_enrollments")
        .update({
          status: "stopped",
          stopped_reason: stoppedReason,
          updated_at: new Date().toISOString(),
        })
        .eq("id", enrollmentId),
  );

  if (error) {
    throw createCampaignScheduleOperationError(
      "Enrollment stop failed",
      "generate_today.upsert_schedule",
      error,
    );
  }
}

function countStep(rows: DailySendPlanRow[], stepNumber: number) {
  return rows.filter((row) => row.campaign_steps?.step_number === stepNumber).length;
}

function countRowsByStatus(rows: Array<{ status: string }>) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.status] = (counts[row.status] ?? 0) + 1;

    return counts;
  }, {});
}

function chunkArray<T>(values: T[], chunkSize: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}

function withChunkDetails(
  error: SupabaseErrorLike,
  chunkNumber: number,
  chunkCount: number,
  chunkContactCount: number,
): SupabaseErrorLike {
  const chunkDetails = `chunk ${chunkNumber} of ${chunkCount}; chunkContactCount: ${chunkContactCount}`;

  return {
    ...error,
    details: error.details
      ? `${error.details}; ${chunkDetails}`
      : chunkDetails,
  };
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const nextDate = new Date(`${date}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + days);

  return nextDate.toISOString().slice(0, 10);
}
