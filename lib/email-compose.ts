export type EmailProvider = "gmail" | "outlook" | "other";

type EmailComposeDraft = {
  contact_email: string;
  subject: string;
  body: string;
};

const providerComposeUrls: Record<Exclude<EmailProvider, "other">, string> = {
  gmail: "https://mail.google.com/mail/",
  outlook: "https://outlook.office.com/mail/deeplink/compose",
};

export function getEmailComposeUrl(
  provider: Exclude<EmailProvider, "other">,
  draft: EmailComposeDraft,
) {
  const url = new URL(providerComposeUrls[provider]);

  if (provider === "gmail") {
    url.searchParams.set("view", "cm");
    url.searchParams.set("fs", "1");
    url.searchParams.set("to", draft.contact_email.trim());
    url.searchParams.set("su", draft.subject);
    url.searchParams.set("body", draft.body);
  } else {
    url.searchParams.set("to", draft.contact_email.trim());
    url.searchParams.set("subject", draft.subject);
    url.searchParams.set("body", draft.body);
  }

  return url.toString();
}

export function getFullEmailText(draft: EmailComposeDraft) {
  return `To: ${draft.contact_email.trim()}\nSubject: ${draft.subject}\n\n${draft.body}`;
}
