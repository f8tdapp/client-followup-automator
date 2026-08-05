import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { WorkspaceRole } from "./workspace-authorization.ts";

export type WorkspaceRuntimeContext = {
  user: User;
  workspaceId: string;
  role: WorkspaceRole;
  source: "membership" | "legacy_fallback";
  supabaseAdmin: SupabaseClient;
};

export type WorkspaceRuntimeContextResult =
  | { ok: true; context: WorkspaceRuntimeContext }
  | { ok: false; response: Response; reason: "unauthenticated" | "forbidden" };

type AuthorizationResult = Awaited<ReturnType<typeof import("./workspace-authorization.ts").authorizeWorkspace>>;

export async function resolveWorkspaceRuntimeContext(
  authorize: () => Promise<AuthorizationResult>,
  createAdmin: () => SupabaseClient,
): Promise<WorkspaceRuntimeContextResult> {
  const authorization = await authorize();
  if (!authorization.ok) return authorization;
  return {
    ok: true,
    context: {
      user: authorization.user,
      workspaceId: authorization.workspaceId,
      role: authorization.role,
      source: authorization.source,
      supabaseAdmin: createAdmin(),
    },
  };
}

/**
 * Inactive shared server context. Existing routes must not import this until
 * their complete conversion batch is ready. It accepts no request workspace ID.
 */
export async function getWorkspaceRuntimeContext(): Promise<WorkspaceRuntimeContextResult> {
  const [{ authorizeWorkspace }, { getSupabaseAdmin }] = await Promise.all([
    import("./workspace-authorization.ts"),
    import("./supabase-admin.ts"),
  ]);
  return resolveWorkspaceRuntimeContext(authorizeWorkspace, getSupabaseAdmin);
}
