import { createHmac, timingSafeEqual } from "node:crypto";

export type HubSpotOAuthStateClaims = {
  userId: string;
  workspaceId: string;
  nonce: string;
  expiresAt: number;
};

export class HubSpotOAuthStateError extends Error {}

const maximumStateLifetimeMs = 10 * 60 * 1000;

function key(value = process.env.PIPELINECUE_OAUTH_STATE_SECRET) {
  if (!value || Buffer.byteLength(value, "utf8") < 32) {
    throw new HubSpotOAuthStateError("OAuth state signing is not configured.");
  }
  return value;
}

function signature(payload: string, signingKey?: string) {
  return createHmac("sha256", key(signingKey)).update(payload).digest("base64url");
}

export function createHubSpotOAuthState(
  claims: Omit<HubSpotOAuthStateClaims, "expiresAt"> & { expiresAt?: number },
  signingKey?: string,
  now = Date.now(),
) {
  const expiresAt = claims.expiresAt ?? now + maximumStateLifetimeMs;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + maximumStateLifetimeMs) {
    throw new HubSpotOAuthStateError("OAuth state expiry is invalid.");
  }
  const payload = Buffer.from(JSON.stringify({
    userId: claims.userId,
    workspaceId: claims.workspaceId,
    nonce: claims.nonce,
    expiresAt,
  })).toString("base64url");
  return `${payload}.${signature(payload, signingKey)}`;
}

export function verifyHubSpotOAuthState(
  state: string,
  expected: { userId: string; workspaceId: string },
  signingKey?: string,
  now = Date.now(),
): HubSpotOAuthStateClaims {
  const [payload, suppliedSignature, extra] = state.split(".");
  if (!payload || !suppliedSignature || extra) throw new HubSpotOAuthStateError("OAuth state is malformed.");
  const expectedSignature = signature(payload, signingKey);
  const supplied = Buffer.from(suppliedSignature);
  const calculated = Buffer.from(expectedSignature);
  if (supplied.length !== calculated.length || !timingSafeEqual(supplied, calculated)) {
    throw new HubSpotOAuthStateError("OAuth state signature is invalid.");
  }
  let claims: HubSpotOAuthStateClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as HubSpotOAuthStateClaims;
  } catch {
    throw new HubSpotOAuthStateError("OAuth state payload is invalid.");
  }
  if (!claims.userId || !claims.workspaceId || !claims.nonce || !Number.isSafeInteger(claims.expiresAt)) {
    throw new HubSpotOAuthStateError("OAuth state claims are invalid.");
  }
  if (claims.expiresAt <= now) throw new HubSpotOAuthStateError("OAuth state has expired.");
  if (claims.userId !== expected.userId) throw new HubSpotOAuthStateError("OAuth state user does not match.");
  if (claims.workspaceId !== expected.workspaceId) throw new HubSpotOAuthStateError("OAuth state workspace does not match.");
  return claims;
}
