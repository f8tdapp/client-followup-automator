import { getPipelineCueAppUrl, isAllowedOwnerEmail, normalizeEmail } from "@/lib/auth-config";
import { requestMagicLink } from "@/lib/auth-login";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export async function POST(request: Request) {
  const data = await request.formData();
  const raw = data.get("email");
  const email = typeof raw === "string" ? normalizeEmail(raw) : "";
  const result = await requestMagicLink(email, {
    isAllowed: isAllowedOwnerEmail,
    signInWithOtp: async (allowedEmail) => {
      const supabase = await createSupabaseServerClient();
      return supabase.auth.signInWithOtp({
        email: allowedEmail,
        options: {
          emailRedirectTo: new URL("/auth/callback", getPipelineCueAppUrl()).toString(),
          shouldCreateUser: false,
        },
      });
    },
  });
  if (result === "provider_error") {
    return Response.redirect(new URL("/login?error=provider_error", request.url), 303);
  }
  return Response.redirect(new URL("/login?sent=1", request.url), 303);
}
