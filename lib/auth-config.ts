export function normalizeEmail(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

export function getAllowedOwnerEmails(value = process.env.PIPELINECUE_ALLOWED_EMAILS) {
  return new Set(
    (value ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

export function isAllowedOwnerEmail(email: string | null | undefined) {
  if (!email) return false;
  return getAllowedOwnerEmails().has(normalizeEmail(email));
}

export function getPipelineCueAppUrl(
  value = process.env.PIPELINECUE_APP_URL,
  environment = process.env.NODE_ENV,
) {
  if (!value?.trim()) throw new Error("Missing PIPELINECUE_APP_URL");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("PIPELINECUE_APP_URL must be an absolute URL");
  }
  const localDevelopment =
    environment !== "production" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localDevelopment) {
    throw new Error("PIPELINECUE_APP_URL must use HTTPS outside local development");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("PIPELINECUE_APP_URL must contain only an origin");
  }
  return url.origin;
}
