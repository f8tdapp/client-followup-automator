import {
  getSendingSettings,
  SendingSettingsError,
  upsertSendingSettings,
} from "@/lib/sending-settings";
import {
  ResendProviderError,
  sendResendTestEmail,
} from "@/lib/resend-provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowedActions = [
  "get_settings",
  "update_settings",
  "send_test_email",
] as const;

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

    if (action === "send_test_email") {
      const settings = await getSendingSettings();

      if (!settings.domain_verified) {
        return Response.json(
          {
            ok: false,
            error: "The sending domain must be verified before a test email can be sent.",
          },
          { status: 400 },
        );
      }

      if (!settings.test_mode_only) {
        return Response.json(
          {
            ok: false,
            error: "Test mode only must be enabled before a test email can be sent.",
          },
          { status: 400 },
        );
      }

      const testRecipient =
        settings.reply_to_email.trim() || settings.from_email.trim();

      if (!testRecipient) {
        return Response.json(
          {
            ok: false,
            error: "Configure a reply-to or from email before sending a test email.",
          },
          { status: 400 },
        );
      }

      await sendResendTestEmail({
        fromName: settings.from_name,
        fromEmail: settings.from_email,
        replyToEmail: settings.reply_to_email || settings.from_email,
        toEmail: testRecipient,
      });

      return Response.json({
        ok: true,
        message: `Test email sent to ${testRecipient}. No contact emails were sent.`,
      });
    }

    return Response.json({
      ok: true,
      settings: await upsertSendingSettings(body.settings ?? {}),
      message: "Settings saved. No emails were sent.",
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
  if (settingsError instanceof ResendProviderError) {
    console.error("[sending-settings] test email error", {
      routeBranch,
      code: settingsError.code,
    });

    return Response.json(
      {
        ok: false,
        error: settingsError.message,
        code: settingsError.code,
      },
      { status: settingsError.code === "missing_api_key" ? 503 : 502 },
    );
  }

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
