import assert from "node:assert/strict";
import test from "node:test";
import { authorizeWorkspaceUser, LEGACY_WORKSPACE_ID } from "./workspace-authorization.ts";

const user = (id, email = `${id}@example.test`) => ({ id, email });
const active = (workspace_id, role = "member") => ({ workspace_id, role, status: "active", workspaces: { status: "active" } });

test("invalid and expired sessions receive 401", async () => {
  for (const result of [
    await authorizeWorkspaceUser(async () => ({ user: null }), async () => null, () => false),
    await authorizeWorkspaceUser(async () => ({ user: user("a"), error: new Error("expired") }), async () => null, () => false),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unauthenticated");
    assert.equal(result.response.status, 401);
  }
});

test("active membership determines workspace and role", async () => {
  const result = await authorizeWorkspaceUser(async () => ({ user: user("a") }), async (id) => active(`workspace-${id}`, "admin"), () => false);
  assert.deepEqual(result.ok && { workspaceId: result.workspaceId, role: result.role, source: result.source }, { workspaceId: "workspace-a", role: "admin", source: "membership" });
});

test("missing, inactive, suspended, and cancelled memberships receive 403", async () => {
  const memberships = [null, { ...active("b"), status: "inactive" }, { ...active("b"), workspaces: { status: "suspended" } }, { ...active("b"), workspaces: { status: "cancelled" } }];
  for (const membership of memberships) {
    const result = await authorizeWorkspaceUser(async () => ({ user: user("a") }), async () => membership, () => false);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "forbidden");
    assert.equal(result.response.status, 403);
  }
});

test("legacy allowlist fallback remains explicit and deterministic", async () => {
  const result = await authorizeWorkspaceUser(async () => ({ user: user("legacy", "owner@example.test") }), async () => null, (email) => email === "owner@example.test");
  assert.deepEqual(result.ok && { workspaceId: result.workspaceId, role: result.role, source: result.source }, { workspaceId: LEGACY_WORKSPACE_ID, role: "owner", source: "legacy_fallback" });
});

test("membership wins over legacy fallback", async () => {
  const result = await authorizeWorkspaceUser(async () => ({ user: user("legacy", "owner@example.test") }), async () => active("customer-workspace", "owner"), () => true);
  assert.equal(result.ok && result.workspaceId, "customer-workspace");
  assert.equal(result.ok && result.source, "membership");
});
