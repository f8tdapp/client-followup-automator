import {
  approveDraft,
  EmailDraftOperationError,
  formatDraftSupabaseError,
  generateTodayDrafts,
  listTodayDrafts,
  markManuallySent,
  skipDraft,
  updateDraft,
} from "@/lib/email-drafts";

export const dynamic = "force-dynamic";

const allowedActions = [
  "generate_today_drafts",
  "list_today_drafts",
  "update_draft",
  "approve_draft",
  "skip_draft",
  "mark_manually_sent",
] as const;

type EmailDraftAction = (typeof allowedActions)[number];

type EmailDraftBody =
  | {
      action: string;
      draftId?: string;
      subject?: string;
      body?: string;
      note?: string;
      parseError: null;
    }
  | {
      action: null;
      parseError: "invalid_json";
    };

export async function GET() {
  try {
    return Response.json(await listTodayDrafts());
  } catch (draftError) {
    return handleDraftError(draftError, "list_today_drafts");
  }
}

export async function POST(request: Request) {
  let routeBranch = "unparsed";

  console.info("[email-drafts] request", {
    method: request.method,
  });

  try {
    const body = await readEmailDraftBody(request);

    if (body.parseError === "invalid_json") {
      return Response.json(
        {
          ok: false,
          error: "Invalid JSON body",
          allowedActions,
        },
        { status: 400 },
      );
    }

    const action = normalizeEmailDraftAction(body.action);

    if (!action) {
      return Response.json(
        {
          ok: false,
          error: "Invalid email draft action",
          receivedAction: body.action,
          allowedActions,
        },
        { status: 400 },
      );
    }

    routeBranch = action;
    console.info("[email-drafts] action", {
      method: request.method,
      routeBranch,
    });

    const result = await runEmailDraftAction(action, body);

    return Response.json(result);
  } catch (draftError) {
    return handleDraftError(draftError, routeBranch);
  }
}

async function readEmailDraftBody(request: Request): Promise<EmailDraftBody> {
  const rawBody = await request.text();

  if (!rawBody.trim()) {
    return { action: "list_today_drafts", parseError: null };
  }

  try {
    const body = JSON.parse(rawBody) as {
      action?: unknown;
      draftId?: unknown;
      subject?: unknown;
      body?: unknown;
      note?: unknown;
    };

    return {
      action:
        typeof body.action === "string" && body.action.trim()
          ? body.action.trim()
          : "list_today_drafts",
      draftId: typeof body.draftId === "string" ? body.draftId : undefined,
      subject: typeof body.subject === "string" ? body.subject : undefined,
      body: typeof body.body === "string" ? body.body : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
      parseError: null,
    };
  } catch {
    return {
      action: null,
      parseError: "invalid_json",
    };
  }
}

function normalizeEmailDraftAction(action: string): EmailDraftAction | null {
  if (allowedActions.includes(action as EmailDraftAction)) {
    return action as EmailDraftAction;
  }

  return null;
}

async function runEmailDraftAction(
  action: EmailDraftAction,
  body: Extract<EmailDraftBody, { parseError: null }>,
) {
  if (action === "generate_today_drafts") {
    return generateTodayDrafts();
  }

  if (action === "list_today_drafts") {
    return listTodayDrafts();
  }

  if (action === "update_draft") {
    return updateDraft({
      draftId: body.draftId ?? "",
      subject: body.subject ?? "",
      body: body.body ?? "",
    });
  }

  if (action === "approve_draft") {
    return approveDraft(body.draftId ?? "");
  }

  if (action === "mark_manually_sent") {
    return markManuallySent({
      draftId: body.draftId ?? "",
      note: body.note,
    });
  }

  return skipDraft(body.draftId ?? "");
}

function handleDraftError(draftError: unknown, routeBranch: string) {
  const operation =
    draftError instanceof EmailDraftOperationError
      ? draftError.operation
      : routeBranch;
  const supabaseError =
    draftError instanceof EmailDraftOperationError
      ? draftError.supabaseError
      : null;
  const details =
    draftError instanceof EmailDraftOperationError
      ? draftError.details
      : draftError instanceof Error
        ? draftError.message
        : "Unable to process email draft action.";

  console.error("[email-drafts] server error", {
    routeBranch,
    operation,
    error: details,
    supabaseError: supabaseError
      ? {
          message: supabaseError.message,
          code: supabaseError.code,
          details: supabaseError.details,
          hint: supabaseError.hint,
        }
      : null,
  });

  return Response.json(
    {
      ok: false,
      error: getDraftRouteError(routeBranch),
      details: supabaseError ? formatDraftSupabaseError(supabaseError) : details,
      operation,
      supabaseError: supabaseError
        ? {
            message: supabaseError.message ?? null,
            code: supabaseError.code ?? null,
            details: supabaseError.details ?? null,
            hint: supabaseError.hint ?? null,
          }
        : undefined,
    },
    { status: 500 },
  );
}

function getDraftRouteError(routeBranch: string) {
  if (routeBranch === "generate_today_drafts") {
    return "Generate today's drafts failed";
  }

  if (routeBranch === "update_draft") {
    return "Update draft failed";
  }

  if (routeBranch === "approve_draft") {
    return "Approve draft failed";
  }

  if (routeBranch === "skip_draft") {
    return "Skip draft failed";
  }

  if (routeBranch === "mark_manually_sent") {
    return "Mark manually sent failed";
  }

  return "Email drafts server error";
}
