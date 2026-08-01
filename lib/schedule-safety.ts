export type SafetyContact = {
  email: string | null;
  is_unsubscribed: boolean;
  last_contacted_at: string | null;
};

export type SafetyRule = {
  suppression_type: string;
  reason?: string | null;
  snoozed_until: string | null;
};

export type SafetyCampaign = {
  cooldown_days: number;
  stop_on_reply: boolean | null;
  stop_on_bounce: boolean | null;
  stop_on_unsubscribe: boolean | null;
};

export function normalizeSuppressionType(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * Shared production suppression rule. Every active non-snooze rule fails
 * closed. A snooze remains active through its boundary date; a future snooze
 * is deferred by scheduling and is currently ineligible for new enrolment.
 */
export function isSuppressionActiveOnDate(
  rule: Pick<SafetyRule, "suppression_type" | "snoozed_until">,
  date: string,
) {
  const type = normalizeSuppressionType(rule.suppression_type);
  if (type !== "snoozed") return true;
  return rule.snoozed_until == null || rule.snoozed_until >= date;
}

export function evaluateScheduleSafety(
  contact: SafetyContact | undefined,
  suppressionRules: SafetyRule[],
  campaign: SafetyCampaign,
  date: string,
  evaluatedAt: string,
) {
  if (!contact?.email?.trim()) {
    return {
      safe: false,
      terminal: false,
      reason: "Missing email.",
      safetyStatus: "missing_email",
    };
  }
  if (contact.is_unsubscribed) {
    return {
      safe: false,
      terminal: true,
      reason: "Contact is unsubscribed.",
      safetyStatus: "unsubscribed",
    };
  }
  for (const rule of suppressionRules) {
    const type = normalizeSuppressionType(rule.suppression_type);
    if (!isSuppressionActiveOnDate(rule, date)) {
      continue;
    }
    return {
      safe: false,
      terminal: type !== "snoozed",
      reason: rule.reason || `Suppressed because contact is ${type || "suppressed"}.`,
      safetyStatus: type || "suppressed",
    };
  }
  if (
    isWithinDays(
      contact.last_contacted_at,
      campaign.cooldown_days,
      Date.parse(evaluatedAt),
    )
  ) {
    return {
      safe: false,
      terminal: false,
      reason: `Contacted within the ${campaign.cooldown_days}-day cooldown.`,
      safetyStatus: "contacted_too_recently",
    };
  }
  return {
    safe: true,
    terminal: false,
    reason: "Ready for review.",
    safetyStatus: "safe",
  };
}

function isWithinDays(value: string | null, days: number, now: number) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) &&
    now - date.getTime() <= days * 24 * 60 * 60 * 1000;
}
