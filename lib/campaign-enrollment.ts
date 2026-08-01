import { getSupabaseAdmin } from "./supabase-admin.ts";
import { loadAllDeterministicPages } from "./schedule-policy.ts";
import { isSuppressionActiveOnDate } from "./schedule-safety.ts";

export type CampaignEnrollmentSummary = {
  campaignId: string;
  campaignName: string;
  newEnrollmentsPaused: boolean;
  eligibleNotEnrolled: number;
  currentlyEnrolled: number;
  waitingForEmail1: number;
  waitingForEmail2: number;
  waitingForEmail3: number;
  waitingForEmail4Plus: number;
  hasLaterActiveSteps: boolean;
};

export type EnrollmentOverview = {
  totalHubSpotContacts: number;
  campaigns: CampaignEnrollmentSummary[];
};

export type SummaryCampaign = {
  id: string;
  name: string;
  new_enrollments_paused: boolean;
};

export type SummaryContact = {
  id: string;
  email: string | null;
  is_unsubscribed: boolean | null;
};

export type SummaryEnrollment = {
  contact_id: string;
  campaign_id: string;
  current_step: number;
  status: string;
};

export type SummarySuppression = {
  contact_id: string;
  active: boolean;
  suppression_type?: string;
  snoozed_until?: string | null;
};

export type SummaryStep = {
  campaign_id: string;
  step_number: number;
  status: string;
};

export type EnrollmentSummaryDataSource = {
  loadCampaigns(from: number, to: number): Promise<SummaryCampaign[]>;
  loadContacts(from: number, to: number): Promise<SummaryContact[]>;
  loadEnrollments(from: number, to: number): Promise<SummaryEnrollment[]>;
  loadSuppressions(from: number, to: number): Promise<SummarySuppression[]>;
  loadSteps(from: number, to: number): Promise<SummaryStep[]>;
};

export type AtomicEnrollmentResult = {
  result: "paused" | "stale_count" | "success" | "no_eligible_contacts";
  message: string;
  eligible_count: number;
  inserted_count: number;
};

export class CampaignEnrollmentConflictError extends Error {
  result: AtomicEnrollmentResult;

  constructor(result: AtomicEnrollmentResult) {
    super(result.message);
    this.name = "CampaignEnrollmentConflictError";
    this.result = result;
  }
}

type AtomicEnrollmentRpc = (input: {
  requested_campaign_id: string;
  confirmed_eligible_count: number;
  enrollment_date: string;
}) => Promise<{
  data: AtomicEnrollmentResult[] | null;
  error: { message: string } | null;
}>;

const pageSize = 250;

export function buildCampaignEnrollmentSummary(input: {
  campaign: SummaryCampaign;
  contacts: SummaryContact[];
  enrollments: SummaryEnrollment[];
  suppressions: SummarySuppression[];
  steps: SummaryStep[];
  enrollmentDate?: string;
}): CampaignEnrollmentSummary {
  const campaignEnrollments = input.enrollments.filter(
    (enrollment) => enrollment.campaign_id === input.campaign.id,
  );
  const enrolledContactIds = new Set(
    campaignEnrollments.map((enrollment) => enrollment.contact_id),
  );
  const suppressedContactIds = new Set(
    input.suppressions
      .filter((suppression) =>
        isEnrollmentSuppressionActive(
          suppression,
          input.enrollmentDate ?? new Date().toISOString().slice(0, 10),
        ),
      )
      .map((suppression) => suppression.contact_id),
  );
  const activeEnrollments = campaignEnrollments.filter(
    (enrollment) => enrollment.status === "active",
  );
  const activeStepNumbers = new Set(
    input.steps
      .filter(
        (step) =>
          step.campaign_id === input.campaign.id && step.status === "active",
      )
      .map((step) => step.step_number),
  );

  return {
    campaignId: input.campaign.id,
    campaignName: input.campaign.name,
    newEnrollmentsPaused: input.campaign.new_enrollments_paused,
    eligibleNotEnrolled: input.contacts.filter(
      (contact) =>
        Boolean(contact.email?.trim()) &&
        contact.is_unsubscribed === false &&
        !suppressedContactIds.has(contact.id) &&
        !enrolledContactIds.has(contact.id),
    ).length,
    currentlyEnrolled: activeEnrollments.length,
    waitingForEmail1: countWaitingForStep(activeEnrollments, 1),
    waitingForEmail2: countWaitingForStep(activeEnrollments, 2),
    waitingForEmail3: countWaitingForStep(activeEnrollments, 3),
    waitingForEmail4Plus: activeEnrollments.filter(
      (enrollment) =>
        enrollment.current_step >= 4 &&
        activeStepNumbers.has(enrollment.current_step),
    ).length,
    hasLaterActiveSteps: Array.from(activeStepNumbers).some(
      (stepNumber) => stepNumber >= 4,
    ),
  };
}

export async function loadCampaignEnrollmentOverview(
  source: EnrollmentSummaryDataSource,
): Promise<EnrollmentOverview> {
  const [campaigns, contacts, enrollments, suppressions, steps] =
    await Promise.all([
      loadAllDeterministicPages(source.loadCampaigns, pageSize),
      loadAllDeterministicPages(source.loadContacts, pageSize),
      loadAllDeterministicPages(source.loadEnrollments, pageSize),
      loadAllDeterministicPages(source.loadSuppressions, pageSize),
      loadAllDeterministicPages(source.loadSteps, pageSize),
    ]);

  return {
    totalHubSpotContacts: contacts.length,
    campaigns: campaigns.map((campaign) =>
      buildCampaignEnrollmentSummary({
        campaign,
        contacts,
        enrollments,
        suppressions,
        steps,
      }),
    ),
  };
}

export async function getCampaignEnrollmentOverview() {
  return loadCampaignEnrollmentOverview(createSupabaseEnrollmentSummarySource());
}

export async function runAtomicCampaignEnrollment(
  input: {
    campaignId: string;
    confirmedEligibleCount: number;
    enrollmentDate: string;
  },
  callRpc: AtomicEnrollmentRpc = callAtomicEnrollmentRpc,
) {
  const { data, error } = await callRpc({
    requested_campaign_id: input.campaignId,
    confirmed_eligible_count: input.confirmedEligibleCount,
    enrollment_date: input.enrollmentDate,
  });

  if (error) throw new Error(error.message);

  const result = data?.[0];
  if (!result) {
    throw new Error("Atomic enrolment returned no result.");
  }

  return result;
}

export async function setNewEnrollmentsPaused(
  campaignId: string,
  paused: boolean,
) {
  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .update({
      new_enrollments_paused: paused,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId)
    .select("id,name,new_enrollments_paused")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

function createSupabaseEnrollmentSummarySource(): EnrollmentSummaryDataSource {
  const supabase = getSupabaseAdmin();

  return {
    async loadCampaigns(from, to) {
      const { data, error } = await supabase
        .from("campaigns")
        .select("id,name,new_enrollments_paused")
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<SummaryCampaign[]>();
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    async loadContacts(from, to) {
      const { data, error } = await supabase
        .from("hubspot_contacts")
        .select("id,email,is_unsubscribed")
        .order("id", { ascending: true })
        .range(from, to)
        .returns<SummaryContact[]>();
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    async loadEnrollments(from, to) {
      const { data, error } = await supabase
        .from("contact_campaign_enrollments")
        .select("contact_id,campaign_id,current_step,status")
        .order("id", { ascending: true })
        .range(from, to)
        .returns<SummaryEnrollment[]>();
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    async loadSuppressions(from, to) {
      const { data, error } = await supabase
        .from("contact_suppression_rules")
        .select("contact_id,active,suppression_type,snoozed_until")
        .eq("active", true)
        .order("id", { ascending: true })
        .range(from, to)
        .returns<SummarySuppression[]>();
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    async loadSteps(from, to) {
      const { data, error } = await supabase
        .from("campaign_steps")
        .select("campaign_id,step_number,status")
        .order("campaign_id", { ascending: true })
        .order("step_number", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<SummaryStep[]>();
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  };
}

export function isEnrollmentSuppressionActive(
  suppression: SummarySuppression,
  enrollmentDate: string,
) {
  if (!suppression.active) return false;
  return isSuppressionActiveOnDate(
    {
      suppression_type: suppression.suppression_type ?? "",
      snoozed_until: suppression.snoozed_until ?? null,
    },
    enrollmentDate,
  );
}

async function callAtomicEnrollmentRpc(
  input: Parameters<AtomicEnrollmentRpc>[0],
) {
  const response = await getSupabaseAdmin()
    .rpc("enroll_eligible_campaign_contacts", input)
    .returns<AtomicEnrollmentResult[]>();

  return response as unknown as Awaited<ReturnType<AtomicEnrollmentRpc>>;
}

function countWaitingForStep(
  enrollments: SummaryEnrollment[],
  stepNumber: number,
) {
  return enrollments.filter(
    (enrollment) => enrollment.current_step === stepNumber,
  ).length;
}
