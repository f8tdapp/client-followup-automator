import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getCompletedDaySummary, partitionHomeDrafts } from "./home-workflow.ts";

test("Home defaults to drafts that still require action", () => {
  const partition = partitionHomeDrafts([
    { id: "review", status: "draft" },
    { id: "send", status: "approved" },
    { id: "sent", status: "manually_sent" },
    { id: "held", status: "skipped" },
  ]);
  assert.deepEqual(partition.actionable.map((draft) => draft.id), ["review", "send"]);
  assert.deepEqual(partition.completed.map((draft) => draft.id), ["sent", "held"]);
});

test("completed-day summary is concise and plain", () => {
  assert.equal(getCompletedDaySummary([
    { status: "manually_sent" },
    { status: "manually_sent" },
    { status: "skipped" },
  ]), "2 sent, 1 suppressed.");
});

test("planning and completed messages use accessible collapsed controls", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Planning and campaign details/);
  assert.match(source, /aria-expanded=\{showCompletedMessages\}/);
  assert.match(source, /View completed messages/);
  assert.match(source, /visibleDrafts\.map/);
});

test("Home preserves distinct primary and secondary surface treatments", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /bg-\[#cbd8e8\]/);
  assert.match(source, /border-cyan-200 bg-white/);
  assert.match(source, /border-blue-200 bg-white/);
  assert.match(source, /border-slate-300 bg-slate-100/);
});

test("Home typography uses the configured Geist typeface and stronger hierarchy", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /text-\[32px\] font-bold/);
  assert.match(source, /text-xl font-semibold leading-7 text-slate-950 sm:text-\[22px\]/);
  assert.match(source, /font-sans/);
  assert.match(source, /uppercase tracking-\[0\.08em\]/);
});

test("initial workspace loading cannot expose connection or operational actions", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /isInitialWorkspaceLoading = isLoading \|\| isHubSpotWorkspaceLoading/);
  assert.match(source, /Loading your workspace…/);
  assert.match(source, /!isInitialWorkspaceLoading && \(/);
  assert.match(source, /disabled=\{isInitialWorkspaceLoading && item !== "Home"\}/);
});
