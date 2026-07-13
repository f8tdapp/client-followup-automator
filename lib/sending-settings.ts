import { getSupabaseAdmin } from "@/lib/supabase-admin";

export type SendingSettings = {
  id: string;
  provider: string;
  sending_domain: string;
  from_name: string;
  from_email: string;
  reply_to_email: string;
  daily_send_limit: number;
  sending_enabled: boolean;
  test_mode_only: boolean;
  domain_verified: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export type SendingSettingsInput = Partial<{
  provider: string;
  sending_domain: string;
  from_name: string;
  from_email: string;
  reply_to_email: string;
  daily_send_limit: number | string;
  sending_enabled: boolean;
  test_mode_only: boolean;
  domain_verified: boolean;
}>;

const defaultSendingSettings = {
  provider: "resend",
  sending_domain: "listingmediact.com",
  from_name: "TJ Muldoon",
  from_email: "tj@listingmediact.com",
  reply_to_email: "tj@listingmediact.com",
  daily_send_limit: 25,
  sending_enabled: false,
  test_mode_only: true,
  domain_verified: false,
};

const sendingSettingsColumns = [
  "id",
  "provider",
  "sending_domain",
  "from_name",
  "from_email",
  "reply_to_email",
  "daily_send_limit",
  "sending_enabled",
  "test_mode_only",
  "domain_verified",
  "created_at",
  "updated_at",
].join(",");

export async function getSendingSettings() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sending_settings")
    .select(sendingSettingsColumns)
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    throw new SendingSettingsError("sending_settings.select", error.message);
  }

  if (data?.[0]) {
    return data[0] as unknown as SendingSettings;
  }

  const { data: insertedSettings, error: insertError } = await supabase
    .from("sending_settings")
    .insert({
      ...defaultSendingSettings,
      updated_at: new Date().toISOString(),
    })
    .select(sendingSettingsColumns)
    .single();

  if (insertError) {
    throw new SendingSettingsError(
      "sending_settings.insert_defaults",
      insertError.message,
    );
  }

  return insertedSettings as unknown as SendingSettings;
}

export async function upsertSendingSettings(input: SendingSettingsInput) {
  const supabase = getSupabaseAdmin();
  const existingSettings = await getSendingSettings();
  const settingsPayload = normalizeSendingSettingsInput(input);

  const { data, error } = await supabase
    .from("sending_settings")
    .update({
      ...settingsPayload,
      updated_at: new Date().toISOString(),
    })
    .eq("id", existingSettings.id)
    .select(sendingSettingsColumns)
    .single();

  if (error) {
    throw new SendingSettingsError("sending_settings.update", error.message);
  }

  return data as unknown as SendingSettings;
}

function normalizeSendingSettingsInput(input: SendingSettingsInput) {
  return {
    provider: normalizeText(input.provider, defaultSendingSettings.provider),
    sending_domain: normalizeText(
      input.sending_domain,
      defaultSendingSettings.sending_domain,
    ).toLowerCase(),
    from_name: normalizeText(input.from_name, defaultSendingSettings.from_name),
    from_email: normalizeEmail(input.from_email, defaultSendingSettings.from_email),
    reply_to_email: normalizeEmail(
      input.reply_to_email,
      defaultSendingSettings.reply_to_email,
    ),
    daily_send_limit: normalizePositiveInteger(
      input.daily_send_limit,
      defaultSendingSettings.daily_send_limit,
    ),
    sending_enabled: Boolean(input.sending_enabled),
    test_mode_only:
      typeof input.test_mode_only === "boolean"
        ? input.test_mode_only
        : defaultSendingSettings.test_mode_only,
    domain_verified: Boolean(input.domain_verified),
  };
}

function normalizeText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeEmail(value: unknown, fallback: string) {
  return normalizeText(value, fallback).toLowerCase();
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  const parsedValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : fallback;

  if (!Number.isFinite(parsedValue) || parsedValue < 1) {
    return fallback;
  }

  return Math.floor(parsedValue);
}

export class SendingSettingsError extends Error {
  operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = "SendingSettingsError";
    this.operation = operation;
  }
}
