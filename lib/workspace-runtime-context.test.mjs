import assert from "node:assert/strict";
import test from "node:test";
import { getWorkspaceRuntimeContext, resolveWorkspaceRuntimeContext } from "./workspace-runtime-context.ts";

const user = { id: "fictional-user", email: "user@example.test" };
const denied = (status, reason) => ({ ok: false, reason, response: Response.json({ error: reason }, { status }) });

test("runtime context preserves 401 and 403 without creating an admin client", async () => {
  for (const [status, reason] of [[401, "unauthenticated"], [403, "forbidden"]]) {
    let adminCreates = 0;
    const result = await resolveWorkspaceRuntimeContext(async () => denied(status, reason), () => { adminCreates += 1; return {}; });
    assert.equal(result.ok, false);
    assert.equal(result.response.status, status);
    assert.equal(adminCreates, 0);
  }
});

test("runtime context carries verified user, trusted membership workspace, role, and server client", async () => {
  const admin = { serverOnly: true };
  const result = await resolveWorkspaceRuntimeContext(
    async () => ({ ok: true, user, workspaceId: "workspace-a", role: "admin", source: "membership" }),
    () => admin,
  );
  assert.deepEqual(result.ok && result.context, { user, workspaceId: "workspace-a", role: "admin", source: "membership", supabaseAdmin: admin });
});

test("legacy fallback remains explicit and database failures fail closed", async () => {
  const legacy = await resolveWorkspaceRuntimeContext(
    async () => ({ ok: true, user, workspaceId: "legacy-workspace", role: "owner", source: "legacy_fallback" }),
    () => ({}),
  );
  assert.equal(legacy.ok && legacy.context.source, "legacy_fallback");
  await assert.rejects(
    resolveWorkspaceRuntimeContext(async () => { throw new Error("membership database failed"); }, () => ({})),
    /membership database failed/,
  );
});

test("public runtime context accepts no browser-supplied workspace authority", () => {
  assert.equal(getWorkspaceRuntimeContext.length, 0);
});
