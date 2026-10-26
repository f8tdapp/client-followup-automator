export const bounceKinds = [
  "address_not_found",
  "blocked",
  "mailbox_full",
  "other",
] as const;

export type BounceKind = (typeof bounceKinds)[number];

export const bounceKindLabels: Record<BounceKind, string> = {
  address_not_found: "Address not found",
  blocked: "Message blocked",
  mailbox_full: "Mailbox full",
  other: "Other delivery failure",
};

export const maxBounceEmailsPerRequest = 200;

export type BounceRecordResult = {
  email: string;
  result: "recorded" | "already_recorded" | "not_found";
  matched_contacts: number;
  stopped_enrollments: number;
  skipped_schedules: number;
  skipped_drafts: number;
};

export function isBounceKind(value: unknown): value is BounceKind {
  return (
    typeof value === "string" &&
    (bounceKinds as readonly string[]).includes(value)
  );
}

// Mail-system senders that appear inside pasted bounce notices but are never
// the contact that bounced.
const systemLocalParts = new Set([
  "mailer-daemon",
  "postmaster",
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
]);

const emailPattern = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * Extracts unique, lower-cased addresses from pasted text. Accepts one address
 * per line, comma- or space-separated lists, or whole bounce notices copied
 * from Gmail. Mail-system addresses are left out, as are excluded addresses
 * (normally the owner's own address, which appears in every pasted notice).
 *
 * Prefer excluding exact addresses. A whole domain is only safe to exclude
 * when it is a private company domain: excluding a shared domain such as
 * gmail.com would silently drop real contacts, including unsubscribes.
 */
export function parseBounceEmailInput(
  input: string,
  excludedDomains: string[] = [],
  excludedAddresses: string[] = [],
) {
  const excluded = new Set(
    excludedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean),
  );
  const excludedExact = new Set(
    excludedAddresses.map((address) => address.trim().toLowerCase()).filter(Boolean),
  );
  const found = new Set<string>();

  for (const match of input.matchAll(emailPattern)) {
    const email = match[0].toLowerCase().replace(/[.'-]+$/, "");
    const [localPart, domain] = email.split("@");
    if (!localPart || !domain) continue;
    if (systemLocalParts.has(localPart)) continue;
    if (excluded.has(domain)) continue;
    if (excludedExact.has(email)) continue;
    found.add(email);
  }

  return Array.from(found).sort();
}

export function summarizeBounceResults(results: BounceRecordResult[]) {
  const recorded = results.filter((row) => row.result === "recorded").length;
  const alreadyRecorded = results.filter(
    (row) => row.result === "already_recorded",
  ).length;
  const notFound = results
    .filter((row) => row.result === "not_found")
    .map((row) => row.email);
  const stoppedEnrollments = results.reduce(
    (total, row) => total + row.stopped_enrollments,
    0,
  );
  const skippedDrafts = results.reduce(
    (total, row) => total + row.skipped_drafts,
    0,
  );

  const parts = [
    `${recorded} newly suppressed`,
    `${alreadyRecorded} already suppressed`,
    `${notFound.length} not found in PipelineCue`,
  ];

  return {
    recorded,
    alreadyRecorded,
    notFound,
    stoppedEnrollments,
    skippedDrafts,
    message: `Bounces recorded: ${parts.join(", ")}. ${stoppedEnrollments} campaign enrollment${stoppedEnrollments === 1 ? "" : "s"} stopped and ${skippedDrafts} unsent draft${skippedDrafts === 1 ? "" : "s"} skipped. HubSpot was not changed.`,
  };
}
