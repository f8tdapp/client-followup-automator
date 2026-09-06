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
