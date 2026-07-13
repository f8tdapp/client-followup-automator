import {
  getSendingSettings,
  SendingSettingsError,
  upsertSendingSettings,
} from "@/lib/sending-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowedActions = ["get_settings", "update_settings"] as const;

type SendingSettingsAction = (typeof allowedActions)[number];

type SendingSettingsBody =
  | {
      action: string;
      settings?: Record<string, unknown>;
      parseError: null;
    }
  | {
      action: null;
      parseError: "invalid_json";
    };

export async function GET() {
  try {
    return Response.json({
      ok: true,
      settings: await getSendingSettings(),
    });
  } catch (settingsError) {
    return handleSendingSettingsError(settingsError, "get_settings");
  }
}

export async function POST(request: Request) {
  let routeBranch = "unparsed";

  console.info("[sending-settings] request", {
    method: request.method,
  });

  try {
    const body = await readSendingSettingsBody(request);

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

    const action = normalizeSendingSettingsAction(body.action);

    if (!action) {
      return Response.json(
        {
          ok: false,
          error: "Invalid sending settings action",
          receivedAction: body.action,
          allowedActions,
        },
        { status: 400 },
      );
    }

    routeBranch = action;
    console.info("[sending-settings] action", {
      method: request.method,
      routeBranch,
    });

    if (action === "get_settings") {
      return Response.json({
        ok: true,
        settings: await getSendingSettings(),
      });
    }

    return Response.json({
      ok: true,
      settings: await upsertSendingSettings(body.settings ?? {}),
      message: "Sending domain setup saved. No emails were sent.",
    });
  } catch (settingsError) {
    return handleSendingSettingsError(settingsError, routeBranch);
  }
}

async function readSendingSettingsBody(
  request: Request,
): Promise<SendingSettingsBody> {
  const rawBody = await request.text();

  if (!rawBody.trim()) {
    return { action: "get_settings", parseError: null };
  }

  try {
    const body = JSON.parse(rawBody) as {
      action?: unknown;
      settings?: unknown;
    };

    return {
      action:
        typeof body.action === "string" && body.action.trim()
          ? body.action.trim()
          : "get_settings",
      settings:
        body.settings && typeof body.settings === "object"
          ? (body.settings as Record<string, unknown>)
          : undefined,
      parseError: null,
    };
  } catch {
    return {
      action: null,
      parseError: "invalid_json",
    };
  }
}

function normalizeSendingSettingsAction(
  action: string,
): SendingSettingsAction | null {
  if (allowedActions.includes(action as SendingSettingsAction)) {
    return action as SendingSettingsAction;
  }

  return null;
}

function handleSendingSettingsError(settingsError: unknown, routeBranch: string) {
  const operation =
    settingsError instanceof SendingSettingsError
      ? settingsError.operation
      : routeBranch;
  const details =
    settingsError instanceof Error
      ? settingsError.message
      : "Unable to process sending settings.";

  console.error("[sending-settings] server error", {
    routeBranch,
    operation,
    error: details,
  });

  return Response.json(
    {
      ok: false,
      error: "Sending settings server error",
      details,
      operation,
    },
    { status: 500 },
  );
}
