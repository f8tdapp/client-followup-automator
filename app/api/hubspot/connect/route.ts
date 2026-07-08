import { getHubSpotAuthorizationUrl } from "@/lib/hubspot";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = crypto.randomUUID();

  return Response.redirect(getHubSpotAuthorizationUrl(state));
}
