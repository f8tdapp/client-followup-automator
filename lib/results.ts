import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { parseBounceEmailInput } from "@/lib/bounce-recording";
import {
  type OutcomeRecordResult,
  type ResultsSummary,
  getEmailDomain,
  isContactOutcome,
  maxOutcomeEmailsPerRequest,
  maxOutcomeNoteLength,
  summarizeOutcomeResults,
} from "@/lib/results-summary";

export class ResultsOperationError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "ResultsOperationError";
    this.status = status;
  }
}

export async function getResultsSummary(): Promise<ResultsSummary> {
  const { data, error } = await getSupabaseAdmin().rpc(
    "pipelinecue_results_summary",
  );

  if (error) {
    console.error("[results] summary failed", {
      message: error.message,
      code: error.code,
    });
    throw new ResultsOperationError("Unable to load results.");
  }

  if (!data || typeof data !== "object") {
    throw new ResultsOperationError("Results returned no data.");
  }

  return data as ResultsSummary;
}

export async function recordContactOutcomes({
  emails,
  outcome,
  note,
  actorEmail,
}: {
  emails: unknown;
  outcome: unknown;
  note: unknown;
  actorEmail: string;
}) {
  const ownerDomain = getEmailDomain(actorEmail);
  const requestedEmails = Array.isArray(emails)
    ? parseBounceEmailInput(
        emails
          .filter((value): value is string => typeof value === "string")
          .join("\n"),
        ownerDomain ? [ownerDomain] : [],
      )
    : [];

  if (requestedEmails.length === 0) {
    throw new ResultsOperationError("Enter at least one email address.", 400);
  }

  if (requestedEmails.length > maxOutcomeEmailsPerRequest) {
    throw new ResultsOperationError(
      `Record at most ${maxOutcomeEmailsPerRequest} addresses at a time.`,
      400,
    );
  }

  if (!isContactOutcome(outcome)) {
    throw new ResultsOperationError("Choose what happened.", 400);
  }

  const cleanNote =
    typeof note === "string"
      ? note.trim().slice(0, maxOutcomeNoteLength)
      : "";

  const { data, error } = await getSupabaseAdmin()
    .rpc("record_contact_outcomes", {
      requested_emails: requestedEmails,
      requested_outcome: outcome,
      requested_note: cleanNote,
      requested_actor: actorEmail.trim() || "authorized owner",
      requested_at: new Date().toISOString(),
    })
    .returns<OutcomeRecordResult[]>();

  if (error) {
    console.error("[results] record outcomes failed", {
      message: error.message,
      code: error.code,
    });
    throw new ResultsOperationError("Unable to record these contacts.");
  }

  if (!Array.isArray(data) || data.length !== requestedEmails.length) {
    throw new ResultsOperationError(
      "Recording returned an unexpected result.",
    );
  }

  const summary = summarizeOutcomeResults(data, outcome);

  return {
    ok: true as const,
    outcomeResults: data,
    message: summary.message,
    summary: await getResultsSummary(),
  };
}
