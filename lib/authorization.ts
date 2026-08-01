import type { User } from "@supabase/supabase-js";
import { isAllowedOwnerEmail } from "./auth-config.ts";

export type OwnerAuthorization =
  | { ok: true; user: User }
  | { ok: false; response: Response; reason: "unauthenticated" | "forbidden" };

export async function authorizeVerifiedUser(
  verify: () => Promise<{ user: User | null; error?: unknown }>,
  allowed: (email: string | null | undefined) => boolean = isAllowedOwnerEmail,
): Promise<OwnerAuthorization> {
  const { user, error } = await verify();
  if (error || !user) {
    return { ok: false, reason: "unauthenticated", response: Response.json({ error: "Authentication required." }, { status: 401 }) };
  }
  if (!allowed(user.email)) {
    return { ok: false, reason: "forbidden", response: Response.json({ error: "This account is not authorized for PipelineCue." }, { status: 403 }) };
  }
  return { ok: true, user };
}

/**
 * Single-account boundary. This verifies the Supabase user with Auth on every
 * request, then gates the one shared account by a server-only email allowlist.
 * Replace this function when an account ownership schema is introduced.
 */
export async function authorizeOwner(): Promise<OwnerAuthorization> {
  const { createSupabaseServerClient } = await import("./supabase-server.ts");
  const supabase = await createSupabaseServerClient();
  return authorizeVerifiedUser(async () => {
    const { data: { user }, error } = await supabase.auth.getUser();
    return { user, error };
  });
}
