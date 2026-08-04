import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHubSpotOAuthState, verifyHubSpotOAuthState } from "./hubspot-oauth-state.ts";

const signingKey = "fictional-test-key-that-is-at-least-32-bytes";
const now = 1_900_000_000_000;
const claims = { userId: "user-a", workspaceId: "workspace-a", nonce: "single-use-nonce" };

test("OAuth state binds the verified user and workspace", () => {
  const state = createHubSpotOAuthState(claims, signingKey, now);
  assert.deepEqual(verifyHubSpotOAuthState(state, claims, signingKey, now + 1), { ...claims, expiresAt: now + 600_000 });
  assert.throws(() => verifyHubSpotOAuthState(state, { ...claims, userId: "user-b" }, signingKey, now + 1), /user does not match/);
  assert.throws(() => verifyHubSpotOAuthState(state, { ...claims, workspaceId: "workspace-b" }, signingKey, now + 1), /workspace does not match/);
});

test("OAuth state rejects expiry, tampering, and malformed input", () => {
  const state = createHubSpotOAuthState(claims, signingKey, now);
  assert.throws(() => verifyHubSpotOAuthState(state, claims, signingKey, now + 600_000), /expired/);
  assert.throws(() => verifyHubSpotOAuthState(`${state}x`, claims, signingKey, now + 1), /signature/);
  assert.throws(() => verifyHubSpotOAuthState("invalid", claims, signingKey, now + 1), /malformed/);
});

test("OAuth state requires a strong configured signing secret", () => {
  assert.throws(() => createHubSpotOAuthState(claims, "short", now), /not configured/);
  assert.throws(() => createHubSpotOAuthState({ ...claims, expiresAt: now + 600_001 }, signingKey, now), /expiry is invalid/);
  assert.throws(() => createHubSpotOAuthState({ ...claims, expiresAt: now }, signingKey, now), /expiry is invalid/);
});

test("OAuth state uses the dedicated server-only secret name", () => {
  const source = readFileSync(new URL("./hubspot-oauth-state.ts", import.meta.url), "utf8");
  assert.match(source, /process\.env\.PIPELINECUE_OAUTH_STATE_SECRET/);
  assert.doesNotMatch(source, /process\.env\.HUBSPOT_CLIENT_SECRET/);
});
