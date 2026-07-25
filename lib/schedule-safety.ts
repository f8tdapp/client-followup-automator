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

const suppressionTypes = new Set([
  "replied",
  "reply",
  "bounced",
  "bounce",
  "unsubscribed",
  "unsubscribe",
  "do_not_contact",
  "snoozed",
]);

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
  if (contact.is_unsubscribed && campaign.stop_on_unsubscribe !== false) {
    return {
      safe: false,
      terminal: true,
      reason: "Contact is unsubscribed.",
      safetyStatus: "unsubscribed",
    };
  }
  for (const rule of suppressionRules) {
    const type = rule.suppression_type.toLowerCase();
    if (!suppressionTypes.has(type)) continue;
    if (type === "snoozed" && rule.snoozed_until && rule.snoozed_until < date) {
      continue;
    }
    if ((type === "replied" || type === "reply") && campaign.stop_on_reply === false) {
      continue;
    }
    if ((type === "bounced" || type === "bounce") && campaign.stop_on_bounce === false) {
      continue;
    }
    if (
      (type === "unsubscribed" || type === "unsubscribe") &&
      campaign.stop_on_unsubscribe === false
    ) {
      continue;
    }
    return {
      safe: false,
      terminal: type !== "snoozed",
      reason: rule.reason || `Suppressed because contact is ${type}.`,
      safetyStatus: type,
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
