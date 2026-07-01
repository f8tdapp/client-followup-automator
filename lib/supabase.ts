import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
}

if (!supabaseAnonKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
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

export const supabase = createClient(
  getSupabaseProjectUrl(supabaseUrl),
  supabaseAnonKey,
);
