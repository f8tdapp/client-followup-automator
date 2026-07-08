import {
  CampaignScheduleOperationError,
  createEmptyDailySendPlan,
  createStarterCampaign,
  enrollEligibleContactsInStarterCampaign,
  formatSupabaseError,
  generateDailySendSchedule,
  getDailySendPlan,
  isSuppressionDiagnosticsError,
  resetStarterCampaignCopy,
} from "@/lib/campaign-schedule";

export const dynamic = "force-dynamic";

const allowedActions = [
  "create_starter_campaign",
  "enroll_eligible_contacts",
  "generate_today",
  "reset_starter_campaign_copy",
] as const;

type CampaignScheduleAction = (typeof allowedActions)[number] | "generate";
type CampaignScheduleBody =
  | {
      action: string;
      parseError: null;
    }
  | {
      action: null;
      parseError: "invalid_json";
    };

export async function GET() {
  try {
    const plan = await getDailySendPlan();

    return Response.json(plan);
  } catch (scheduleError) {
    if (isSuppressionDiagnosticsError(scheduleError)) {
      console.warn("[campaign-schedule] diagnostics warning", {
        method: "GET",
        routeBranch: "diagnostics.contact_suppression_rules",
        warning: "Could not read contact_suppression_rules diagnostics.",
      });

      const plan = createEmptyDailySendPlan();

      return Response.json({
        ...plan,
        ok: true,
        diagnostics: {
          ...plan.diagnostics,
          diagnosticsWarning: "Could not read contact_suppression_rules diagnostics.",
          suppressionRulesCount: 0,
        },
        diagnosticsWarning: "Could not read contact_suppression_rules diagnostics.",
        suppressionRulesCount: 0,
      });
    }

    const safeErrorMessage =
      scheduleError instanceof CampaignScheduleOperationError
        ? scheduleError.details
        : scheduleError instanceof Error
        ? scheduleError.message
        : "Unable to load campaign schedule.";
    const supabaseError =
      scheduleError instanceof CampaignScheduleOperationError
        ? scheduleError.supabaseError
        : null;

    console.error("[campaign-schedule] get error", {
      method: "GET",
      routeBranch:
        scheduleError instanceof CampaignScheduleOperationError
          ? scheduleError.operation
          : "get_daily_send_plan",
      error: safeErrorMessage,
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
        ...createEmptyDailySendPlan(undefined, safeErrorMessage),
        error: "Campaign schedule unavailable",
        details: supabaseError ? formatSupabaseError(supabaseError) : safeErrorMessage,
      },
      { status: 200 },
    );
  }
}

export async function POST(request: Request) {
  let routeBranch = "unparsed";

  console.info("[campaign-schedule] request", {
    method: request.method,
  });

  try {
    const body = await readCampaignScheduleBody(request);

    if (body.parseError === "invalid_json") {
      console.info("[campaign-schedule] invalid json body", {
        method: request.method,
        routeBranch: "invalid_json",
      });

      return Response.json(
        {
          ok: false,
          error: "Invalid JSON body",
          allowedActions,
        },
        { status: 400 },
      );
    }

    const action = normalizeCampaignScheduleAction(body.action);

    if (!action) {
      console.info("[campaign-schedule] invalid action", {
        method: request.method,
        receivedAction: body.action,
        routeBranch: "invalid_action",
      });

      return Response.json(
        {
          ok: false,
          error: "Invalid campaign schedule action",
          receivedAction: body.action,
          allowedActions,
        },
        { status: 400 },
      );
    }

    routeBranch = action;
    console.info("[campaign-schedule] action", {
      method: request.method,
      receivedAction: body.action,
      routeBranch: action,
    });

    const plan = await runCampaignScheduleAction(action);

    return Response.json(plan);
  } catch (scheduleError) {
    if (isSuppressionDiagnosticsError(scheduleError)) {
      console.warn("[campaign-schedule] diagnostics warning", {
        method: request.method,
        routeBranch,
        warning: "Could not read contact_suppression_rules diagnostics.",
      });

      const plan = createEmptyDailySendPlan();
      const actionMessage =
        routeBranch === "create_starter_campaign"
          ? "Starter campaign ready."
          : routeBranch === "enroll_eligible_contacts"
            ? "Eligible contacts enrollment completed."
            : "Campaign schedule action completed.";

      return Response.json({
        ...plan,
        ok: true,
        message:
          routeBranch === "create_starter_campaign"
            ? "Starter campaign ready."
            : actionMessage,
        diagnostics: {
          ...plan.diagnostics,
          diagnosticsWarning: "Could not read contact_suppression_rules diagnostics.",
          suppressionRulesCount: 0,
          reason: actionMessage,
        },
        diagnosticsWarning: "Could not read contact_suppression_rules diagnostics.",
        suppressionRulesCount: 0,
        reason: actionMessage,
      });
    }

    const operation = getScheduleErrorOperation(scheduleError, routeBranch);
    const safeErrorMessage = getScheduleErrorMessage(scheduleError);
    const details = getScheduleErrorDetails(scheduleError, operation, safeErrorMessage);
    const supabaseError =
      scheduleError instanceof CampaignScheduleOperationError
        ? scheduleError.supabaseError
        : null;

    console.error("[campaign-schedule] server error", {
      method: request.method,
      routeBranch,
      error: details,
      operation,
      supabaseError: supabaseError
        ? {
            message: supabaseError.message,
            code: supabaseError.code,
            details: supabaseError.details,
            hint: supabaseError.hint,
          }
        : null,
    });

    if (routeBranch === "create_starter_campaign") {
      return Response.json(
        {
          ok: false,
          error: "Create starter campaign failed",
          details,
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

    return Response.json(
      {
        ok: false,
        error:
          routeBranch === "generate_today" || routeBranch === "generate"
            ? "Generate today failed"
            : routeBranch === "enroll_eligible_contacts"
              ? "Enroll eligible contacts failed"
              : routeBranch === "reset_starter_campaign_copy"
                ? "Reset starter campaign copy failed"
              : "Campaign schedule server error",
        details: supabaseError ? formatSupabaseError(supabaseError) : details,
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
}

async function readCampaignScheduleBody(
  request: Request,
): Promise<CampaignScheduleBody> {
  const rawBody = await request.text();

  if (!rawBody.trim()) {
    return { action: "generate_today", parseError: null };
  }

  try {
    const body = JSON.parse(rawBody) as { action?: unknown };

    return {
      action:
        typeof body.action === "string" && body.action.trim()
          ? body.action.trim()
          : "generate_today",
      parseError: null,
    };
  } catch {
    return {
      action: null,
      parseError: "invalid_json",
    };
  }
}

function normalizeCampaignScheduleAction(action: string): CampaignScheduleAction | null {
  if (action === "generate") {
    return "generate";
  }

  if (allowedActions.includes(action as (typeof allowedActions)[number])) {
    return action as CampaignScheduleAction;
  }

  return null;
}

async function runCampaignScheduleAction(action: CampaignScheduleAction) {
  if (action === "create_starter_campaign") {
    return createStarterCampaign();
  }

  if (action === "enroll_eligible_contacts") {
    return enrollEligibleContactsInStarterCampaign();
  }

  if (action === "reset_starter_campaign_copy") {
    return resetStarterCampaignCopy();
  }

  return generateDailySendSchedule();
}

function getScheduleErrorOperation(error: unknown, fallbackOperation: string) {
  if (error instanceof CampaignScheduleOperationError) {
    return error.operation;
  }

  if (error && typeof error === "object" && "operation" in error) {
    const operation = (error as { operation?: unknown }).operation;

    if (typeof operation === "string" && operation.trim()) {
      return operation;
    }
  }

  return fallbackOperation;
}

function getScheduleErrorMessage(error: unknown) {
  if (error instanceof CampaignScheduleOperationError) {
    return error.details;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unable to generate campaign schedule.";
}

function getScheduleErrorDetails(
  error: unknown,
  operation: string,
  safeErrorMessage: string,
) {
  if (error instanceof CampaignScheduleOperationError) {
    return error.details;
  }

  if (error && typeof error === "object" && "details" in error) {
    const details = (error as { details?: unknown }).details;

    if (typeof details === "string" && details.trim()) {
      return details;
    }
  }

  return `${operation} failed. message: ${safeErrorMessage}`;
}
