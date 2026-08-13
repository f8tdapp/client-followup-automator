type AuthErrorShape = {
  code?: unknown;
  status?: unknown;
  name?: unknown;
  message?: unknown;
  cause?: unknown;
};

type AuthResult = {
  error: AuthErrorShape | null;
};

type LoginDependencies = {
  isAllowed: (email: string) => boolean;
  signInWithOtp: (email: string) => Promise<AuthResult>;
  environment?: string;
  log?: (message: string) => void;
};

export type MagicLinkRequestResult = "accepted" | "denied" | "provider_error";
export type AuthFailureCategory =
  | "supabase_api_key_rejected"
  | "smtp_authentication_failed"
  | "smtp_connection_failed"
  | "smtp_sender_rejected"
  | "email_rate_limited"
  | "email_not_authorized"
  | "network_failure"
  | "unknown";

function sanitizedCode(value: unknown) {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value) ? value : "unknown";
}

function sanitizedStatus(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 599
    ? value
    : "unknown";
}

function safeIdentifier(value: unknown) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : "unknown";
}

function knownOwnProperties(error: AuthErrorShape) {
  const safeNames = new Set(["cause", "code", "message", "name", "originalError", "stack", "status"]);
  return Object.getOwnPropertyNames(error).filter((name) => safeNames.has(name)).sort().join(",") || "none";
}

function hasProperty(error: AuthErrorShape, name: "cause" | "code" | "message" | "status") {
  return name in error;
}

export function classifyAuthFailure(error: AuthErrorShape): AuthFailureCategory {
  const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
  const name = typeof error.name === "string" ? error.name : "";
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";

  if (["invalid_api_key", "api_key_invalid"].includes(code) || /invalid api key|no api key found/.test(message)) {
    return "supabase_api_key_rejected";
  }
  if (["over_email_send_rate_limit", "email_rate_limit_exceeded", "too_many_requests"].includes(code)) {
    return "email_rate_limited";
  }
  if (["email_address_not_authorized", "email_not_authorized", "user_not_found"].includes(code)) {
    return "email_not_authorized";
  }
  if (/authentication unsuccessful|invalid credentials|username and password not accepted|535[ -]5\.7\.8|534[ -]5\.7\.9/.test(message)) {
    return "smtp_authentication_failed";
  }
  if (/sender address rejected|sender rejected|mail from.{0,80}rejected|not owned by user|553[ -]5\.7\.1/.test(message)) {
    return "smtp_sender_rejected";
  }
  if (/connection refused|connection timed out|i\/o timeout|network is unreachable|no such host|tls handshake timeout/.test(message)) {
    return "smtp_connection_failed";
  }
  if (name === "AuthRetryableFetchError" && error.status === 0) return "network_failure";
  return "unknown";
}

function sanitizedErrorStructure(error: AuthErrorShape) {
  const constructorName = safeIdentifier(error.constructor?.name);
  const errorName = safeIdentifier(error.name);
  return `constructor=${constructorName} name=${errorName} own_properties=${knownOwnProperties(error)} has_code=${hasProperty(error, "code")} has_status=${hasProperty(error, "status")} has_cause=${hasProperty(error, "cause")} has_message=${hasProperty(error, "message")}`;
}

export async function requestMagicLink(
  email: string,
  { isAllowed, signInWithOtp, environment = process.env.NODE_ENV, log = console.error }: LoginDependencies,
): Promise<MagicLinkRequestResult> {
  // Keep denied and accepted submissions indistinguishable to unauthenticated callers.
  if (!email || !isAllowed(email)) return "denied";

  try {
    const { error } = await signInWithOtp(email);
    if (!error) return "accepted";

    if (environment !== "production") {
      log(`[auth.login] result=provider_error category=${classifyAuthFailure(error)} code=${sanitizedCode(error.code)} status=${sanitizedStatus(error.status)} ${sanitizedErrorStructure(error)}`);
    }
    return "provider_error";
  } catch {
    if (environment !== "production") {
      log("[auth.login] result=provider_error code=unexpected_failure status=unknown");
    }
    return "provider_error";
  }
}
