import { exchangeOAuthCodeForTokens, getHubSpotScopes } from "../../../../lib/hubspot.ts";
import { getSupabaseAdmin } from "../../../../lib/supabase-admin.ts";
import { authorizeOwner } from "../../../../lib/authorization.ts";
import { cookies } from "next/headers";
import { encryptHubSpotToken } from "../../../../lib/hubspot-token-crypto.ts";
import { createHubSpotCallbackHandler, type HubSpotOAuthTokens } from "../../../../lib/hubspot-callback.ts";

export const dynamic = "force-dynamic";

async function consumeOAuthState() {
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("pipelinecue_hubspot_oauth_state")?.value;
  cookieStore.delete("pipelinecue_hubspot_oauth_state");
  return expectedState;
}

async function persistOAuthTokens(tokens: HubSpotOAuthTokens) {
  const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const { error } = await getSupabaseAdmin().from("hubspot_connections").upsert(
    {
      provider: "hubspot",
      portal_id: tokens.hub_id ? String(tokens.hub_id) : null,
      status: "connected",
      access_token: encryptHubSpotToken(tokens.access_token),
      refresh_token: encryptHubSpotToken(tokens.refresh_token),
      token_expires_at: tokenExpiresAt,
      scopes: getHubSpotScopes().split(/\s+/).filter(Boolean),
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider" },
  );
  if (error) throw new Error("HubSpot token storage failed.");
}

export const GET = createHubSpotCallbackHandler({
  consumeState: consumeOAuthState,
  authorize: authorizeOwner,
  exchange: exchangeOAuthCodeForTokens,
  persist: persistOAuthTokens,
});
