import { isAllowedOwnerEmail } from "@/lib/auth-config";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return Response.redirect(new URL("/login?error=missing_code", url));
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return Response.redirect(new URL("/login?error=expired", url));
  const { data: { user } } = await supabase.auth.getUser();
  return Response.redirect(new URL(user && isAllowedOwnerEmail(user.email) ? "/" : "/denied", url));
}
