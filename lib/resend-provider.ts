import "server-only";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

type SendResendTestEmailInput = {
  fromName: string;
  fromEmail: string;
  replyToEmail: string;
  toEmail: string;
};

export async function sendResendTestEmail({
  fromName,
  fromEmail,
  replyToEmail,
  toEmail,
}: SendResendTestEmailInput) {
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    throw new ResendProviderError(
      "missing_api_key",
      "RESEND_API_KEY is not configured on the server. No email was sent.",
    );
  }

  const response = await fetch(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [toEmail],
      reply_to: replyToEmail,
      subject: "PipelineCue test email",
      text: [
        "This is a PipelineCue test email only.",
        "No contact emails were sent.",
      ].join("\n\n"),
    }),
  });

  if (!response.ok) {
    throw new ResendProviderError(
      "provider_request_failed",
      `Resend could not send the test email (status ${response.status}). No contact emails were sent.`,
    );
  }

  const result = (await response.json()) as { id?: unknown };

  if (typeof result.id !== "string" || !result.id) {
    throw new ResendProviderError(
      "invalid_provider_response",
      "Resend returned an invalid response. No contact emails were sent.",
    );
  }

  return { id: result.id };
}

export class ResendProviderError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ResendProviderError";
    this.code = code;
  }
}
