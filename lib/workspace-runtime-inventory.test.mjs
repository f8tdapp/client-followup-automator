import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const expected = {
  "app/api/campaign-enrollments/route.ts": [0, 0, 0, 0, 0, 3],
  "app/api/campaign-schedule/route.ts": [0, 0, 0, 0, 0, 3],
  "app/api/campaigns/route.ts": [2, 0, 0, 3, 0, 2],
  "app/api/dashboard-data/route.ts": [13, 0, 0, 2, 0, 3],
  "app/api/email-drafts/route.ts": [0, 0, 0, 0, 0, 3],
  "app/api/hubspot/callback/route.ts": [1, 0, 0, 1, 0, 2],
  "app/api/hubspot/connect/route.ts": [0, 0, 0, 0, 0, 2],
  "app/api/hubspot/recommendations/route.ts": [0, 0, 0, 0, 0, 3],
  "app/api/hubspot/status/route.ts": [0, 0, 0, 0, 0, 2],
  "app/api/hubspot/sync/route.ts": [0, 0, 0, 0, 0, 2],
  "app/api/sending-settings/route.ts": [0, 0, 0, 0, 0, 3],
  "app/api/workload-forecast/route.ts": [0, 0, 0, 0, 0, 3],
  "lib/authorization.ts": [0, 0, 0, 0, 1, 0],
  "lib/campaign-enrollment.ts": [6, 1, 4, 0, 0, 0],
  "lib/campaign-schedule.ts": [27, 0, 24, 50, 0, 0],
  "lib/email-drafts.ts": [13, 0, 14, 0, 0, 0],
  "lib/hubspot-sync.ts": [13, 0, 12, 24, 0, 0],
  "lib/sending-settings.ts": [3, 0, 3, 0, 0, 0],
  "lib/supabase-admin.ts": [0, 0, 1, 0, 0, 0],
  "lib/workload-forecast.ts": [8, 0, 3, 0, 0, 0],
  "lib/workspace-authorization.ts": [1, 0, 2, 0, 0, 0],
  "lib/workspace-runtime-context.ts": [0, 0, 2, 2, 0, 1],
};

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function count(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

test("privileged runtime tokens exactly match the reviewed conversion inventory", () => {
  const actual = {};
  for (const path of [...filesUnder(join(root, "app")), ...filesUnder(join(root, "lib"))]) {
    if (!/\.(?:ts|tsx)$/.test(path) || path.endsWith(".test.mjs")) continue;
    const source = readFileSync(path, "utf8");
    const counts = [
      count(source, /\.from\(\s*["']/g),
      count(source, /\.rpc\(\s*["']/g),
      count(source, /\bgetSupabaseAdmin\b/g),
      count(source, /\bsupabaseAdmin\b/g),
      count(source, /\bauthorizeOwner\b/g),
      count(source, /\bgetWorkspaceRuntimeContext\b/g),
    ];
    if (counts.some(Boolean)) actual[relative(root, path).replaceAll("\\", "/")] = counts;
  }
  assert.deepEqual(actual, expected);
});

test("privileged imports and service-role client access cannot hide behind aliases", () => {
  const sourceFiles = [...filesUnder(join(root, "app")), ...filesUnder(join(root, "lib"))]
    .filter((path) => /\.(?:ts|tsx)$/.test(path) && !path.endsWith(".test.mjs"));

  for (const path of sourceFiles) {
    const source = readFileSync(path, "utf8");
    const reviewedPath = relative(root, path).replaceAll("\\", "/");

    assert.doesNotMatch(
      source,
      /\b(?:getSupabaseAdmin|getWorkspaceRuntimeContext|authorizeOwner|supabaseAdmin)\s+as\s+/,
      `${reviewedPath} aliases a privileged runtime capability`,
    );
    assert.doesNotMatch(
      source,
      /\b(?:const|let|var)\s*{[^}]*\b(?:getSupabaseAdmin|getWorkspaceRuntimeContext|authorizeOwner|supabaseAdmin)\s*:/,
      `${reviewedPath} destructures a privileged runtime capability under an alias`,
    );
    assert.doesNotMatch(
      source,
      /\[\s*["'](?:getSupabaseAdmin|getWorkspaceRuntimeContext|authorizeOwner|supabaseAdmin)["']\s*\]/,
      `${reviewedPath} uses computed access for a privileged runtime capability`,
    );

    if (source.includes("SUPABASE_SERVICE_ROLE_KEY")) {
      assert.ok(
        ["app/api/email-drafts/route.ts", "lib/supabase-admin.ts"].includes(reviewedPath),
        `${reviewedPath} reads the service-role configuration outside a reviewed boundary`,
      );
    }
    if (/import\s*{[^}]*\bcreateClient\b[^}]*}\s*from\s*["']@supabase\/supabase-js["']/.test(source)) {
      assert.ok(
        ["lib/supabase-admin.ts", "lib/supabase.ts"].includes(reviewedPath),
        `${reviewedPath} constructs an unreviewed Supabase client`,
      );
    }
  }
});

test("inventory documents its exact operation total and static-audit limitation", () => {
  const map = readFileSync(join(root, "docs/workspace-runtime-conversion-map.md"), "utf8");
  assert.match(map, /Exact database call-site count: \*\*88\*\*/);
  assert.match(map, /Static matching does not prove tenant isolation/);
  assert.match(map, /rejects straightforward privileged import aliasing and direct service-role client construction/);
});
