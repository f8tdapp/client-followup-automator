import { getHubSpotAuthorizationUrl } from "@/lib/hubspot";
import { getWorkspaceRuntimeContext } from "@/lib/workspace-runtime-context";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export async function GET() {
  const authorization = await getWorkspaceRuntimeContext();
  if (!authorization.ok) return authorization.response;
  const state = crypto.randomUUID();

  (await cookies()).set("pipelinecue_hubspot_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/hubspot/callback",
    maxAge: 600,
  });

  return Response.redirect(getHubSpotAuthorizationUrl(state));
}
