// Pure types and helpers for the Results page. No database or React imports,
// so tests and the page can both load this file.

export const contactOutcomes = [
  "unsubscribed",
  "replied",
  "do_not_contact",
] as const;

export type ContactOutcome = (typeof contactOutcomes)[number];

export const contactOutcomeLabels: Record<ContactOutcome, string> = {
  unsubscribed: "Unsubscribed",
  replied: "Replied (stop follow-ups)",
  do_not_contact: "Do not contact (left company, referral-only, etc.)",
};

export type StoppedOutcome = "bounced" | ContactOutcome;

export const stoppedOutcomeLabels: Record<StoppedOutcome, string> = {
  bounced: "Bounced",
  unsubscribed: "Unsubscribed",
  replied: "Replied",
  do_not_contact: "Do not contact",
};

export const maxOutcomeEmailsPerRequest = 200;
export const maxOutcomeNoteLength = 200;

// Above this share of emailed agents, bounces start to put the sending
// domain's reputation at risk. A rule of thumb, shown as a warning only.
export const bounceRateWarningThreshold = 0.03;

export type StoppedContact = {
  contact_id: string;
  email: string | null;
  name: string | null;
  company: string | null;
  outcome: StoppedOutcome;
  reason: string | null;
  recorded_at: string;
};

export type DomainResult = {
  domain: string;
  agents_emailed: number;
  bounced: number;
  blocked: number;
};

export type ResultsSummary = {
  generated_at: string;
  first_sent_at: string | null;
  last_sent_at: string | null;
  agents_emailed: number;
  emails_sent: number;
  sent_by_step: Array<{ step: number | null; sent: number }>;
  agents_completed: number;
  bounced_emailed: number;
  outcome_counts: Partial<Record<StoppedOutcome, number>>;
  bounce_kinds: Record<string, number>;
  hubspot_unsubscribed: number;
  by_domain: DomainResult[];
  stopped_contacts: StoppedContact[];
  health: {
    duplicate_step_sends: number;
    stopped_still_active: number;
  };
};

export type OutcomeRecordResult = {
  email: string;
  result: "recorded" | "already_recorded" | "not_found";
  matched_contacts: number;
  stopped_enrollments: number;
  skipped_schedules: number;
  skipped_drafts: number;
};

export function isContactOutcome(value: unknown): value is ContactOutcome {
  return (
    typeof value === "string" &&
    (contactOutcomes as readonly string[]).includes(value)
  );
}

export function getBounceRate(summary: Pick<ResultsSummary, "agents_emailed" | "bounced_emailed">) {
  if (summary.agents_emailed <= 0) return null;
  return summary.bounced_emailed / summary.agents_emailed;
}

export function formatPercent(rate: number | null) {
  if (rate === null) return "–";
  return `${(rate * 100).toFixed(1)}%`;
}

export function getOutcomeCount(
  summary: Pick<ResultsSummary, "outcome_counts">,
  outcome: StoppedOutcome,
) {
  return summary.outcome_counts[outcome] ?? 0;
}

// The signed-in owner's own address, normalized. Pasted bounce notices and
// replies contain it, so it is never recorded as a contact outcome. Only this
// exact address is excluded, never its whole domain (see parseBounceEmailInput).
export function normalizeOwnerEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase() ?? "";
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) ? normalized : null;
}

export function summarizeOutcomeResults(
  results: OutcomeRecordResult[],
  outcome: ContactOutcome,
) {
  const recorded = results.filter((row) => row.result === "recorded").length;
  const alreadyRecorded = results.filter(
    (row) => row.result === "already_recorded",
  ).length;
  const notFound = results
    .filter((row) => row.result === "not_found")
    .map((row) => row.email);
  const stoppedEnrollments = results.reduce(
    (total, row) => total + row.stopped_enrollments,
    0,
  );
  const label = stoppedOutcomeLabels[outcome].toLowerCase();

  return {
    recorded,
    alreadyRecorded,
    notFound,
    message: `Recorded as ${label}: ${recorded} new, ${alreadyRecorded} already recorded, ${notFound.length} not found in PipelineCue. ${stoppedEnrollments} campaign enrollment${stoppedEnrollments === 1 ? "" : "s"} stopped. HubSpot was not changed.`,
  };
}
