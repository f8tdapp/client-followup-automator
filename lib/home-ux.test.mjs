import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);

// Execute the actual modules with in-memory dependencies. No effects, requests,
// database clients, or event handlers are run by these render/status tests.
function loadModule(relativePath, mocks, cache = new Map()) {
  const filename = fileURLToPath(new URL(relativePath, import.meta.url));
  if (cache.has(filename)) return cache.get(filename).exports;
  const compiledModule = { exports: {} };
  cache.set(filename, compiledModule);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  const localRequire = (name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith("@/lib/")) return loadModule(`./${name.slice(6)}.ts`, mocks, cache);
    return require(name);
  };
  runInThisContext(`(function(require, module, exports) {${outputText}\n})`, { filename })(localRequire, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}

const pageSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const pageAst = ts.createSourceFile("page.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const stateNames = [];
function collectStateNames(node) {
  if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) &&
      node.initializer && ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(pageAst) === "useState") {
    stateNames.push(node.name.elements[0].name.getText(pageAst));
  }
  ts.forEachChild(node, collectStateNames);
}
collectStateNames(pageAst);
let stateOverrides = {};
let stateIndex = 0;
const { default: Dashboard } = loadModule("../app/page.tsx", {
  react: {
    ...React,
    useState(initialValue) {
      const name = stateNames[stateIndex++];
      return React.useState(Object.hasOwn(stateOverrides, name) ? stateOverrides[name] : initialValue);
    },
  },
});

function renderHome(overrides = {}) {
  stateOverrides = { isLoading: false, isHubSpotWorkspaceLoading: false, ...overrides };
  stateIndex = 0;
  return renderToStaticMarkup(React.createElement(Dashboard));
}

function plan(totalScheduled, schedule = []) {
  return {
    summary: {
      scheduledDate: "2026-09-07", totalScheduled, brokerDomainsProtected: 0,
      skippedDueToDomainLimits: 0, dueEmail1: 0, dueEmail2: 0, dueEmail3: 0,
      totalDailyLimit: 25, rolledForwardTotalLimit: 0, rolledForwardNewContactLimit: 0,
      rolledForwardSafetyLimit: 0, stoppedByTerminalSuppression: 0,
    },
    diagnostics: {
      hasActiveCampaign: true, activeCampaignCount: 1, eligibleContactCount: 1,
      enrolledContactCount: 1, hasCampaignSteps: true, campaignStepCount: 3, reason: null,
    },
    schedule: schedule.map((row, index) => ({
      id: String(index), scheduled_date: "2026-09-07", broker_domain: "example.invalid",
      reason: "Synthetic fixture", safety_status: "safe", hubspot_contacts: null,
      campaigns: null, campaign_steps: null, ...row,
    })),
  };
}
const draftButton = /<button\b[^>]*>Generate today&#x27;s drafts<\/button>/;

test("Home offers one primary action that prepares the plan and drafts", () => {
  const html = renderHome({
    clients: [{ id: "synthetic-contact" }],
    hubSpotStatus: { status: "private_token", lastSyncAt: null, contactsSynced: 1 },
    dailySendPlan: plan(0),
  });
  assert.match(html, /Prepare today&#x27;s follow-ups/);
  assert.match(html, /Create today&#x27;s plan and drafts together\. Nothing sends automatically\./);
  assert.match(html, /<button\b[^>]*>Prepare Today&#x27;s Follow-Ups<\/button>/);
  assert.doesNotMatch(html, /Go to Today&#x27;s Send Plan/);
});

test("one-step preparation handles non-JSON timeout responses safely", () => {
  assert.match(pageSource, /readJsonResponse<DailySendPlan/);
  assert.match(pageSource, /response\.status === 504/);
  assert.match(pageSource, /Refresh the page before trying again\. Nothing was sent\./);
  assert.doesNotMatch(
    pageSource.slice(
      pageSource.indexOf("async function handlePrepareTodaysFollowUps"),
      pageSource.indexOf("async function saveSendingSettings"),
    ),
    /scheduleResponse\.json\(\)|draftResponse\.json\(\)/,
  );
});

test("Home omits draft generation and its prerequisite helper without an actionable plan", () => {
  for (const dailySendPlan of [plan(0), plan(0, [{ status: "skipped" }])]) {
    const html = renderHome({ dailySendPlan });
    assert.doesNotMatch(html, draftButton);
    assert.doesNotMatch(html, /Generate today&#x27;s send plan first/);
    assert.match(html, /No drafts have been prepared for today\. Nothing sends automatically\./);
    assert.match(html, /Next Action/);
  }
});

test("Home displays enabled draft generation for existing actionable schedule availability", () => {
  for (const dailySendPlan of [plan(2), plan(0, [{ status: "scheduled" }])]) {
    const html = renderHome({ dailySendPlan });
    const button = html.match(draftButton)?.[0];
    assert.ok(button);
    assert.doesNotMatch(button, / disabled=/);
  }
});

test("draft generation retains its in-progress disabled state", () => {
  const html = renderHome({ dailySendPlan: plan(1), isGeneratingDrafts: true });
  assert.match(html, /<button\b[^>]*disabled=""[^>]*>Generating drafts\.\.\.<\/button>/);
});

test("Home uses graceful connected wording with no saved sync timestamp", () => {
  for (const status of ["private_token", "connected"]) {
    const html = renderHome({ hubSpotStatus: { status, lastSyncAt: null, contactsSynced: 0 } });
    assert.match(html, /<span>HubSpot connected<\/span>/);
    assert.doesNotMatch(html, /Last sync unavailable|Connected via private token/);
  }
});

test("Home includes a saved sync timestamp for either connection mode", () => {
  for (const status of ["private_token", "connected"]) {
    const html = renderHome({ hubSpotStatus: { status, lastSyncAt: "2026-09-07T09:00:00Z", contactsSynced: 0 } });
    assert.match(html, /<span>HubSpot connected - Last sync [^<]+<\/span>/);
  }
});

test("either pending initial load hides connection prompts, totals, and draft actions", () => {
  for (const loading of [
    { isLoading: true }, { isHubSpotWorkspaceLoading: true },
    { isLoading: true, isHubSpotWorkspaceLoading: true },
  ]) {
    const html = renderHome({ dailySendPlan: plan(1), ...loading });
    assert.match(html, /Loading your workspace/);
    assert.doesNotMatch(html, /Connect HubSpot|Today&#x27;s progress|Daily workspace/);
    assert.doesNotMatch(html, draftButton);
    assert.match(html, /<button\b[^>]*disabled=""[^>]*>Today&#x27;s Send Plan<\/button>/);
  }
});

function statusFixture({ connection = null, connectionFailure, contactsFailure, count = 7, privateToken = true } = {}) {
  const queries = [];
  const admin = {
    from(table) {
      return {
        select(columns, options) {
          queries.push({ table, columns, options });
          if (table === "hubspot_contacts") {
            return contactsFailure ? Promise.reject(new Error("synthetic count failure")) : Promise.resolve({ count });
          }
          assert.equal(table, "hubspot_connections");
          return {
            eq(column, value) {
              assert.equal(column, "provider");
              assert.equal(value, "hubspot");
              return { maybeSingle: () => connectionFailure
                ? Promise.reject(new Error("synthetic connection failure"))
                : Promise.resolve({ data: connection, error: null }) };
            },
          };
        },
      };
    },
  };
  const statusModule = loadModule("./hubspot-sync.ts", {
    "@/lib/hubspot": { hasHubSpotPrivateToken: () => privateToken },
    "@/lib/supabase-admin": { getSupabaseAdmin: () => admin },
    "@/lib/hubspot-token-crypto": { isEncryptedHubSpotTokenEnvelope: () => true },
  });
  return { getStatus: statusModule.getHubSpotConnectionStatus, queries };
}

test("private-token status returns stored last_sync_at and only public status fields", async () => {
  const fixture = statusFixture({ connection: {
    last_sync_at: "2026-09-07T09:00:00Z", access_token: "synthetic secret", last_error: "synthetic error",
  } });
  assert.deepEqual(await fixture.getStatus(), {
    status: "private_token", lastSyncAt: "2026-09-07T09:00:00Z", contactsSynced: 7,
  });
  assert.deepEqual(fixture.queries, [
    { table: "hubspot_connections", columns: "last_sync_at", options: undefined },
    { table: "hubspot_contacts", columns: "id", options: { count: "exact", head: true } },
  ]);
});

test("private-token status tolerates an absent record or genuinely missing timestamp", async () => {
  for (const connection of [null, { last_sync_at: null }]) {
    assert.deepEqual(await statusFixture({ connection }).getStatus(), {
      status: "private_token", lastSyncAt: null, contactsSynced: 7,
    });
  }
});

test("private-token status isolates metadata and count failures without exposing errors", async () => {
  assert.deepEqual(await statusFixture({ connectionFailure: true }).getStatus(), {
    status: "private_token", lastSyncAt: null, contactsSynced: 7,
  });
  assert.deepEqual(await statusFixture({ connection: { last_sync_at: "2026-09-07T09:00:00Z" }, contactsFailure: true }).getStatus(), {
    status: "private_token", lastSyncAt: "2026-09-07T09:00:00Z", contactsSynced: 0,
  });
});

test("OAuth continues returning its existing connection status and sync timestamp", async () => {
  for (const status of ["connected", "needs_reconnect"]) {
    const connection = { status, last_sync_at: "2026-09-07T09:00:00Z", access_token: "synthetic", refresh_token: "synthetic" };
    assert.deepEqual(await statusFixture({ connection, privateToken: false }).getStatus(), {
      status, lastSyncAt: connection.last_sync_at, contactsSynced: 7,
    });
  }
});
