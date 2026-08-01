import { getPipelineCueAppUrl, isAllowedOwnerEmail, normalizeEmail } from "@/lib/auth-config";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export async function POST(request: Request) {
  const data = await request.formData();
  const raw = data.get("email");
  const email = typeof raw === "string" ? normalizeEmail(raw) : "";
  // Do not reveal allowlist membership to unauthenticated callers.
  if (email && isAllowedOwnerEmail(email)) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: new URL("/auth/callback", getPipelineCueAppUrl()).toString(), shouldCreateUser: false } });
  }
  return Response.redirect(new URL("/login?sent=1", request.url), 303);
}
