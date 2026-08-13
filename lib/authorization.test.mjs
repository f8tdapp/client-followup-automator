import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { authorizeVerifiedUser } from "./authorization.ts";
import { createHubSpotCallbackHandler } from "./hubspot-callback.ts";
import { createWorkloadForecastGetHandler } from "../app/api/workload-forecast/route.ts";

const owner = { id: "owner", email: "Owner@example.com" };
const runtimeContext = (workspaceId = "workspace-a") => ({
  ok: true,
  context: {
    user: owner,
    workspaceId,
    role: "owner",
    source: "membership",
    supabaseAdmin: { serverOnly: true },
  },
});

test("expired sessions and malformed cookies are 401", async () => {
  for (const error of [new Error("expired"), new Error("malformed cookie")]) {
    const result = await authorizeVerifiedUser(async () => ({ user: null, error }));
    assert.equal(result.ok, false);
    assert.equal(result.response.status, 401);
  }
});

test("authenticated denied users are 403 and the owner succeeds", async () => {
  const denied = await authorizeVerifiedUser(async () => ({ user: { id: "denied", email: "denied@example.com" } }), () => false);
  assert.equal(denied.ok, false);
  assert.equal(denied.response.status, 403);
  const allowed = await authorizeVerifiedUser(async () => ({ user: owner }), (email) => email?.toLowerCase() === "owner@example.com");
  assert.equal(allowed.ok, true);
});

test("real protected route returns JSON 401/403 before privileged work", async () => {
  for (const [status, authorization] of [
    [401, { ok: false, response: Response.json({ error: "Authentication required." }, { status: 401 }) }],
    [403, { ok: false, response: Response.json({ error: "Forbidden." }, { status: 403 }) }],
  ]) {
    let privilegedCalls = 0;
    const handler = createWorkloadForecastGetHandler(
      async () => { privilegedCalls += 1; return {}; },
      async () => authorization,
    );
    const response = await handler();
    assert.equal(response.status, status);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(privilegedCalls, 0);
  }
});

test("valid owner reaches a real protected route operation", async () => {
  let privilegedCalls = 0;
  const handler = createWorkloadForecastGetHandler(
    async (context) => {
      privilegedCalls += 1;
      assert.equal(context.workspaceId, "workspace-a");
      return { ok: true };
    },
    async () => runtimeContext(),
  );
  assert.equal((await handler()).status, 200);
  assert.equal(privilegedCalls, 1);
});

test("protected route ignores request-supplied workspace identifiers", async () => {
  let receivedWorkspaceId;
  const handler = createWorkloadForecastGetHandler(
    async (context) => {
      receivedWorkspaceId = context.workspaceId;
      return { ok: true };
    },
    async () => runtimeContext("trusted-membership-workspace"),
  );
  const request = new Request("http://localhost/api/workload-forecast?workspace_id=query-workspace", {
    method: "POST",
    body: JSON.stringify({ workspace_id: "body-workspace" }),
    headers: {
      "content-type": "application/json",
      cookie: "workspace_id=cookie-workspace",
      "x-workspace-id": "header-workspace",
    },
  });
  assert.equal((await handler(request)).status, 200);
  assert.equal(receivedWorkspaceId, "trusted-membership-workspace");
});

test("unexpected authorization failure stops protected route work", async () => {
  let privilegedCalls = 0;
  const handler = createWorkloadForecastGetHandler(
    async () => { privilegedCalls += 1; return {}; },
    async () => { throw new Error("membership lookup failed"); },
  );
  await assert.rejects(handler(), /membership lookup failed/);
  assert.equal(privilegedCalls, 0);
});

test("HubSpot callback passes only the trusted authorization context to persistence", async () => {
  let persistedContext;
  const handler = createHubSpotCallbackHandler({
    consumeState: async () => "expected",
    authorize: async () => runtimeContext("trusted-membership-workspace"),
    exchange: async () => ({ access_token: "fixture-a", refresh_token: "fixture-r", expires_in: 3600 }),
    persist: async (_tokens, context) => { persistedContext = context; },
  });
  const response = await handler(new Request("http://localhost/api/hubspot/callback?state=expected&code=fixture-code&workspace_id=query-workspace", {
    headers: { cookie: "workspace_id=cookie-workspace", "x-workspace-id": "header-workspace" },
  }));
  assert.match(response.headers.get("location"), /hubspot=connected/);
  assert.equal(persistedContext.workspaceId, "trusted-membership-workspace");
});

test("HubSpot callback consumes state and blocks mismatch before exchange", async () => {
  for (const requestUrl of ["http://localhost/api/hubspot/callback", "http://localhost/api/hubspot/callback?state=wrong&code=code"]) {
    let consumed = 0;
    let exchanges = 0;
    let persists = 0;
    const handler = createHubSpotCallbackHandler({
      consumeState: async () => { consumed += 1; return "expected"; },
      authorize: async () => runtimeContext(),
      exchange: async () => { exchanges += 1; throw new Error("raw provider secret"); },
      persist: async () => { persists += 1; },
    });
    const response = await handler(new Request(requestUrl));
    assert.equal(consumed, 1);
    assert.equal(exchanges, 0);
    assert.equal(persists, 0);
    assert.match(response.headers.get("location"), /oauth_state_invalid/);
  }
});

test("HubSpot callback owner denial and raw failures never persist or leak", async () => {
  let persists = 0;
  const deniedHandler = createHubSpotCallbackHandler({
    consumeState: async () => "expected",
    authorize: async () => ({ ok: false, response: Response.json({}, { status: 403 }), reason: "forbidden" }),
    exchange: async () => { throw new Error("must not run"); },
    persist: async () => { persists += 1; },
  });
  const denied = await deniedHandler(new Request("http://localhost/api/hubspot/callback?state=expected&code=code"));
  assert.match(denied.headers.get("location"), /owner_authorization_failed/);
  assert.equal(persists, 0);

  for (const failure of ["exchange", "storage"]) {
    const handler = createHubSpotCallbackHandler({
      consumeState: async () => "expected",
      authorize: async () => runtimeContext(),
      exchange: async () => {
        if (failure === "exchange") throw new Error("raw provider secret");
        return { access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "bearer" };
      },
      persist: async () => { if (failure === "storage") throw new Error("raw database detail"); },
    });
    const response = await handler(new Request("http://localhost/api/hubspot/callback?state=expected&code=code"));
    const location = response.headers.get("location");
    assert.doesNotMatch(location, /raw|secret|database/);
    assert.match(location, failure === "exchange" ? /oauth_exchange_failed/ : /oauth_storage_failed/);
  }
});

test("every sensitive application route authorizes before its operation", async () => {
  const routes = [
    "campaigns", "campaign-enrollments", "campaign-schedule", "email-drafts",
    "hubspot/recommendations", "hubspot/status", "hubspot/sync",
    "sending-settings", "workload-forecast", "hubspot/connect", "dashboard-data",
  ];
  for (const route of routes) {
    const source = await readFile(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /getWorkspaceRuntimeContext/);
    assert.match(source, /if \(!authorization\.ok\) return authorization\.response/);
  }
});

test("HubSpot callback validates state before service-role access", async () => {
  const source = await readFile(new URL("./hubspot-callback.ts", import.meta.url), "utf8");
  const routeSource = await readFile(new URL("../app/api/hubspot/callback/route.ts", import.meta.url), "utf8");
  assert.ok(source.indexOf("dependencies.authorize()") < source.indexOf("new URL(request.url)"));
  assert.ok(source.indexOf("state !== expectedState") < source.indexOf("dependencies.persist(tokens, authorization.context)"));
  assert.ok(source.indexOf("dependencies.authorize()") < source.indexOf("dependencies.persist(tokens, authorization.context)"));
  assert.match(routeSource, /cookieStore\.delete\("pipelinecue_hubspot_oauth_state"\)/);
});

test("the browser dashboard has no direct Supabase data path", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /lib\/supabase|\.from\(/);
  assert.match(source, /\/api\/dashboard-data/);
});

test("login, callback, logout, and proxy use verified server-readable sessions", async () => {
  const [login, callback, logout, proxy] = await Promise.all([
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/logout/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../proxy.ts", import.meta.url), "utf8"),
  ]);
  assert.match(login, /signInWithOtp/);
  assert.match(login, /shouldCreateUser: false/);
  assert.match(callback, /exchangeCodeForSession/);
  assert.match(callback, /auth\.getUser\(\)/);
  assert.match(logout, /auth\.signOut\(\)/);
  assert.match(proxy, /httpOnly: true/);
  assert.match(proxy, /path\.startsWith\("\/api\/"\)/);
});
