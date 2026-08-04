import type { User } from "@supabase/supabase-js";
import { isAllowedOwnerEmail } from "./auth-config.ts";

export const LEGACY_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

export type WorkspaceRole = "owner" | "admin" | "member";

export type WorkspaceAuthorization =
  | { ok: true; user: User; workspaceId: string; role: WorkspaceRole; source: "membership" | "legacy_fallback" }
  | { ok: false; response: Response; reason: "unauthenticated" | "forbidden" };

type Membership = {
  workspace_id: string;
  role: WorkspaceRole;
  status: "active" | "inactive";
  workspaces: { status: string } | { status: string }[] | null;
};

function workspaceStatus(membership: Membership) {
  const workspace = Array.isArray(membership.workspaces)
    ? membership.workspaces[0]
    : membership.workspaces;
  return workspace?.status;
}

export async function authorizeWorkspaceUser(
  verify: () => Promise<{ user: User | null; error?: unknown }>,
  findMembership: (userId: string) => Promise<Membership | null>,
  allowedLegacyEmail: (email: string | null | undefined) => boolean = isAllowedOwnerEmail,
): Promise<WorkspaceAuthorization> {
  const { user, error } = await verify();
  if (error || !user) {
    return { ok: false, reason: "unauthenticated", response: Response.json({ error: "Authentication required." }, { status: 401 }) };
  }

  const membership = await findMembership(user.id);
  if (membership?.status === "active" && !["suspended", "cancelled"].includes(workspaceStatus(membership) ?? "")) {
    return { ok: true, user, workspaceId: membership.workspace_id, role: membership.role, source: "membership" };
  }

  // Explicit transition-only escape hatch. Remove this branch after the first
  // customer's workspace_members row has been created and verified.
  if (allowedLegacyEmail(user.email)) {
    return { ok: true, user, workspaceId: LEGACY_WORKSPACE_ID, role: "owner", source: "legacy_fallback" };
  }

  return { ok: false, reason: "forbidden", response: Response.json({ error: "No active PipelineCue workspace membership." }, { status: 403 }) };
}

export async function authorizeWorkspace(): Promise<WorkspaceAuthorization> {
  const [{ createSupabaseServerClient }, { getSupabaseAdmin }] = await Promise.all([
    import("./supabase-server.ts"),
    import("./supabase-admin.ts"),
  ]);
  const supabase = await createSupabaseServerClient();
  return authorizeWorkspaceUser(
    async () => {
      const { data: { user }, error } = await supabase.auth.getUser();
      return { user, error };
    },
    async (userId) => {
      const { data, error } = await getSupabaseAdmin()
        .from("workspace_members")
        .select("workspace_id, role, status, workspaces!inner(status)")
        .eq("user_id", userId)
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      // Transition only: before Migration 012 exists, allow the verified legacy
      // owner to reach the explicit allowlist fallback. Fail closed for every
      // other database error so an outage cannot broaden access.
      if (error?.code === "42P01" || error?.code === "PGRST205") return null;
      if (error) throw new Error("Workspace membership lookup failed.");
      return data as Membership | null;
    },
  );
}
