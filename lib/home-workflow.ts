export type HomeDraftStatus = "draft" | "approved" | "skipped" | "manually_sent";

export type HomeDraft = { status: HomeDraftStatus };

export function partitionHomeDrafts<T extends HomeDraft>(drafts: T[]) {
  return {
    actionable: drafts.filter(
      (draft) => draft.status === "draft" || draft.status === "approved",
    ),
    completed: drafts.filter(
      (draft) => draft.status === "manually_sent" || draft.status === "skipped",
    ),
  };
}

export function getCompletedDaySummary(drafts: HomeDraft[]) {
  const sent = drafts.filter((draft) => draft.status === "manually_sent").length;
  const suppressed = drafts.filter((draft) => draft.status === "skipped").length;
  return `${sent} sent, ${suppressed} suppressed.`;
}
