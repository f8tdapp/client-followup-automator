import { getSupabaseAdmin } from "@/lib/supabase-admin";

type SupabaseErrorLike = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

type DailyScheduleRow = {
  id: string;
  contact_id: string;
  campaign_id: string;
  campaign_step_id: string;
  scheduled_date: string;
  status: string;
};

type HubSpotContactRow = {
  id: string;
  hubspot_contact_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
};

type CampaignStepRow = {
  id: string;
  step_number: number;
  subject_template: string;
  body_template: string;
};

export type EmailDraftRow = {
  id: string;
  schedule_id: string;
  hubspot_contact_id: string | null;
  contact_email: string;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_company: string | null;
  campaign_id: string | null;
  campaign_step_id: string | null;
  step_number: number | null;
  subject: string;
  body: string;
  status: "draft" | "approved" | "skipped";
  approved_at: string | null;
  skipped_at: string | null;
  created_at: string;
  updated_at: string;
};

type EmailDraftInsert = Omit<
  EmailDraftRow,
  "id" | "status" | "approved_at" | "skipped_at" | "created_at" | "updated_at"
>;

const emailDraftLookupChunkSize = 50;

export type EmailDraftSummary = {
  created: number;
  existing: number;
  skipped: number;
  totalDrafts: number;
  approved: number;
  skippedDrafts: number;
  remaining: number;
};

export type EmailDraftList = {
  ok: true;
  summary: EmailDraftSummary;
  drafts: EmailDraftRow[];
  message?: string;
};

export class EmailDraftOperationError extends Error {
  operation: string;
  details: string;
  supabaseError: SupabaseErrorLike | null;

  constructor(
    message: string,
    operation: string,
    supabaseError?: SupabaseErrorLike | null,
  ) {
    const details = supabaseError ? formatSupabaseError(supabaseError) : message;

    super(message);
    this.name = "EmailDraftOperationError";
    this.operation = operation;
    this.details = details;
    this.supabaseError = supabaseError ?? null;
  }
}

export function formatDraftSupabaseError(error: SupabaseErrorLike) {
  return [
    error.message ? `message: ${error.message}` : null,
    error.code ? `code: ${error.code}` : null,
    error.details ? `details: ${error.details}` : null,
    error.hint ? `hint: ${error.hint}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

export async function generateTodayDrafts(date = getTodayDate()) {
  console.info("[email-drafts] operation start", {
    operation: "email_drafts.generate_today",
    scheduledDate: date,
  });

  const scheduledRows = await loadTodayScheduledRows(date);
  const scheduleIds = scheduledRows.map((row) => row.id);
  const existingDrafts = await loadDraftsByScheduleIds(scheduleIds);
  const existingScheduleIds = new Set(
    existingDrafts.map((draft) => draft.schedule_id),
  );
  const missingRows = scheduledRows.filter(
    (row) => !existingScheduleIds.has(row.id),
  );

  const contactIds = unique(missingRows.map((row) => row.contact_id));
  const stepIds = unique(missingRows.map((row) => row.campaign_step_id));
  const contacts = await loadContacts(contactIds);
  const steps = await loadCampaignSteps(stepIds);
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const rowsToInsert: EmailDraftInsert[] = [];
  let skipped = 0;

  for (const scheduleRow of missingRows) {
    const contact = contactsById.get(scheduleRow.contact_id);
    const step = stepsById.get(scheduleRow.campaign_step_id);

    if (!contact?.email?.trim() || !step) {
      skipped += 1;
      continue;
    }

    rowsToInsert.push({
      schedule_id: scheduleRow.id,
      hubspot_contact_id: contact.hubspot_contact_id,
      contact_email: contact.email.trim(),
      contact_first_name: contact.first_name,
      contact_last_name: contact.last_name,
      contact_company: contact.company,
      campaign_id: scheduleRow.campaign_id,
      campaign_step_id: scheduleRow.campaign_step_id,
      step_number: step.step_number,
      subject: personalizeTemplate(step.subject_template, contact),
      body: personalizeTemplate(step.body_template, contact),
    });
  }

  let created = 0;

  if (rowsToInsert.length > 0) {
    const { data, error } = await runDraftQuery(
      "email_drafts.insert_missing",
      () =>
        getSupabaseAdmin()
          .from("email_drafts")
          .upsert(rowsToInsert, {
            onConflict: "schedule_id",
            ignoreDuplicates: true,
          })
          .select("id")
          .returns<Array<{ id: string }>>(),
    );

    if (error) {
      throw createEmailDraftError("email_drafts.insert_missing", error);
    }

    created = data?.length ?? rowsToInsert.length;
  }

  const list = await listTodayDrafts(date);

  return {
    ...list,
    summary: {
      ...list.summary,
      created,
      existing: existingDrafts.length,
      skipped,
    },
    message:
      created > 0
        ? `${created} drafts prepared for review. Nothing was sent.`
        : "Today's drafts are already prepared. Nothing was sent.",
  };
}

export async function listTodayDrafts(date = getTodayDate()): Promise<EmailDraftList> {
  const scheduledRows = await loadTodayScheduledRows(date, [
    "scheduled",
    "drafted",
    "reviewed",
  ]);
  const scheduleIds = scheduledRows.map((row) => row.id);
  const drafts = await loadDraftsByScheduleIds(scheduleIds);
  const sortedDrafts = drafts.sort((left, right) => {
    const leftStep = left.step_number ?? 0;
    const rightStep = right.step_number ?? 0;

    if (leftStep !== rightStep) {
      return leftStep - rightStep;
    }

    return left.contact_email.localeCompare(right.contact_email);
  });

  return {
    ok: true,
    summary: createDraftSummary(sortedDrafts),
    drafts: sortedDrafts,
  };
}

export async function updateDraft({
  draftId,
  subject,
  body,
}: {
  draftId: string;
  subject: string;
  body: string;
}) {
  if (!draftId.trim()) {
    throw new EmailDraftOperationError(
      "Missing draft id.",
      "email_drafts.update.validate",
    );
  }

  if (!subject.trim() || !body.trim()) {
    throw new EmailDraftOperationError(
      "Draft subject and body are required.",
      "email_drafts.update.validate",
    );
  }

  const { error } = await runDraftQuery("email_drafts.update", () =>
    getSupabaseAdmin()
      .from("email_drafts")
      .update({
        subject: subject.trim(),
        body: body.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", draftId),
  );

  if (error) {
    throw createEmailDraftError("email_drafts.update", error);
  }

  return {
    ...(await listTodayDrafts()),
    message: "Draft edits saved. Nothing was sent.",
  };
}

export async function approveDraft(draftId: string) {
  return updateDraftStatus({
    draftId,
    status: "approved",
    approved_at: new Date().toISOString(),
    skipped_at: null,
    message: "Draft approved for a future sending step. Nothing was sent.",
    operation: "email_drafts.approve",
  });
}

export async function skipDraft(draftId: string) {
  return updateDraftStatus({
    draftId,
    status: "skipped",
    approved_at: null,
    skipped_at: new Date().toISOString(),
    message: "Draft skipped. Nothing was sent.",
    operation: "email_drafts.skip",
  });
}

async function updateDraftStatus({
  draftId,
  status,
  approved_at,
  skipped_at,
  message,
  operation,
}: {
  draftId: string;
  status: "approved" | "skipped";
  approved_at: string | null;
  skipped_at: string | null;
  message: string;
  operation: string;
}) {
  if (!draftId.trim()) {
    throw new EmailDraftOperationError("Missing draft id.", `${operation}.validate`);
  }

  const { error } = await runDraftQuery(operation, () =>
    getSupabaseAdmin()
      .from("email_drafts")
      .update({
        status,
        approved_at,
        skipped_at,
        updated_at: new Date().toISOString(),
      })
      .eq("id", draftId),
  );

  if (error) {
    throw createEmailDraftError(operation, error);
  }

  return {
    ...(await listTodayDrafts()),
    message,
  };
}

async function loadTodayScheduledRows(
  date: string,
  statuses = ["scheduled"],
) {
  const { data, error } = await runDraftQuery("daily_send_schedule.select_today", () =>
    getSupabaseAdmin()
      .from("daily_send_schedule")
      .select("id,contact_id,campaign_id,campaign_step_id,scheduled_date,status")
      .eq("scheduled_date", date)
      .in("status", statuses)
      .order("created_at", { ascending: true })
      .returns<DailyScheduleRow[]>(),
  );

  if (error) {
    throw createEmailDraftError("daily_send_schedule.select_today", error);
  }

  return data ?? [];
}

async function loadDraftsByScheduleIds(scheduleIds: string[]) {
  if (scheduleIds.length === 0) {
    return [];
  }

  const drafts: EmailDraftRow[] = [];

  for (const chunk of chunkArray(scheduleIds, emailDraftLookupChunkSize)) {
    const { data, error } = await runDraftQuery("email_drafts.select_by_schedule", () =>
      getSupabaseAdmin()
        .from("email_drafts")
        .select(
          "id,schedule_id,hubspot_contact_id,contact_email,contact_first_name,contact_last_name,contact_company,campaign_id,campaign_step_id,step_number,subject,body,status,approved_at,skipped_at,created_at,updated_at",
        )
        .in("schedule_id", chunk)
        .returns<EmailDraftRow[]>(),
    );

    if (error) {
      throw createEmailDraftError("email_drafts.select_by_schedule", error);
    }

    drafts.push(...(data ?? []));
  }

  return drafts;
}

async function loadContacts(contactIds: string[]) {
  if (contactIds.length === 0) {
    return [];
  }

  const contacts: HubSpotContactRow[] = [];
  const chunks = chunkArray(contactIds, emailDraftLookupChunkSize);

  console.info("[email-drafts] contact chunks", {
    operation: "hubspot_contacts.select_drafts",
    contactCount: contactIds.length,
    chunkCount: chunks.length,
    chunkSize: emailDraftLookupChunkSize,
  });

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    console.info("[email-drafts] contact chunk start", {
      operation: "hubspot_contacts.select_drafts",
      chunkNumber: chunkIndex + 1,
      chunkCount: chunks.length,
      chunkSize: chunk.length,
    });

    const { data, error } = await runDraftQuery("hubspot_contacts.select_drafts", () =>
      getSupabaseAdmin()
        .from("hubspot_contacts")
        .select("id,hubspot_contact_id,email,first_name,last_name,company")
        .in("id", chunk)
        .returns<HubSpotContactRow[]>(),
    );

    if (error) {
      throw createEmailDraftError("hubspot_contacts.select_drafts", error);
    }

    contacts.push(...(data ?? []));
    console.info("[email-drafts] contact chunk success", {
      operation: "hubspot_contacts.select_drafts",
      chunkNumber: chunkIndex + 1,
      rowCount: data?.length ?? 0,
    });
  }

  return contacts;
}

async function loadCampaignSteps(stepIds: string[]) {
  if (stepIds.length === 0) {
    return [];
  }

  const uniqueStepIds = Array.from(new Set(stepIds));
  const steps: CampaignStepRow[] = [];

  for (const chunk of chunkArray(uniqueStepIds, emailDraftLookupChunkSize)) {
    const { data, error } = await runDraftQuery("campaign_steps.select_drafts", () =>
      getSupabaseAdmin()
        .from("campaign_steps")
        .select("id,step_number,subject_template,body_template")
        .in("id", chunk)
        .returns<CampaignStepRow[]>(),
    );

    if (error) {
      throw createEmailDraftError("campaign_steps.select_drafts", error);
    }

    steps.push(...(data ?? []));
  }

  return steps;
}

function personalizeTemplate(template: string, contact: HubSpotContactRow) {
  const tokens = {
    first_name: contact.first_name?.trim() || "there",
    last_name: contact.last_name?.trim() || "",
    company: contact.company?.trim() || "",
    email: contact.email?.trim() || "",
  };

  return template
    .replaceAll("{first_name}", tokens.first_name)
    .replaceAll("{last_name}", tokens.last_name)
    .replaceAll("{company}", tokens.company)
    .replaceAll("{email}", tokens.email)
    .trim();
}

function createDraftSummary(drafts: EmailDraftRow[]): EmailDraftSummary {
  const approved = drafts.filter((draft) => draft.status === "approved").length;
  const skippedDrafts = drafts.filter((draft) => draft.status === "skipped").length;

  return {
    created: 0,
    existing: drafts.length,
    skipped: 0,
    totalDrafts: drafts.length,
    approved,
    skippedDrafts,
    remaining: drafts.length - approved - skippedDrafts,
  };
}

async function runDraftQuery<T>(
  operation: string,
  query: () => PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>,
) {
  console.info("[email-drafts] db start", { operation });
  const result = await query();

  if (result.error) {
    console.warn("[email-drafts] db error", {
      operation,
      error: formatSupabaseError(result.error),
    });
  } else {
    console.info("[email-drafts] db success", { operation });
  }

  return result;
}

function createEmailDraftError(operation: string, error: SupabaseErrorLike) {
  return new EmailDraftOperationError(`${operation} failed.`, operation, error);
}

function formatSupabaseError(error: SupabaseErrorLike) {
  return formatDraftSupabaseError(error) || "Unknown Supabase error";
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function chunkArray<T>(values: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}
