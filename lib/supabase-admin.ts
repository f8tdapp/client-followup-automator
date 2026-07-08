import { createClient } from "@supabase/supabase-js";

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

function getSupabaseProjectUrl(url: string) {
  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error();
    }

    return parsedUrl.origin;
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid HTTP or HTTPS URL");
  }
}

function assertServerSide() {
  if (typeof window !== "undefined") {
    throw new Error("Supabase service role client must only be used server-side.");
  }
}

function assertServiceRoleKey(key: string) {
  const [, payload] = key.split(".");

  if (!payload) {
    return;
  }

  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { role?: string };

    if (claims.role && claims.role !== "service_role") {
      throw new Error(
        "SUPABASE_SERVICE_ROLE_KEY must be a service role key, not an anon key.",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("service role key")) {
      throw error;
    }
  }
}

export function getSupabaseAdmin() {
  assertServerSide();

  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  assertServiceRoleKey(serviceRoleKey);

  return createClient(
    getSupabaseProjectUrl(getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL")),
    serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    },
  );
}
