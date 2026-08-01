import { getHubSpotAuthorizationUrl } from "@/lib/hubspot";
import { authorizeOwner } from "@/lib/authorization";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export async function GET() {
  const authorization = await authorizeOwner();
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
