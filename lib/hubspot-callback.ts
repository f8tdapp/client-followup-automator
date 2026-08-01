export type HubSpotOAuthTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  hub_id?: number;
};

export function createHubSpotCallbackHandler(dependencies: {
  consumeState: () => Promise<string | undefined>;
  authorize: () => Promise<{ ok: boolean }>;
  exchange: (code: string) => Promise<HubSpotOAuthTokens>;
  persist: (tokens: HubSpotOAuthTokens) => Promise<void>;
}) {
  return async function hubSpotCallback(request: Request) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const providerError = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const expectedState = await dependencies.consumeState();
    if (!state || !expectedState || state !== expectedState) {
      return Response.redirect(new URL("/?hubspot=error&reason=oauth_state_invalid", url));
    }
    if (!(await dependencies.authorize()).ok) {
      return Response.redirect(new URL("/?hubspot=error&reason=owner_authorization_failed", url));
    }
    if (providerError || !code) {
      return Response.redirect(new URL("/?hubspot=error&reason=oauth_exchange_failed", url));
    }
    let tokens: HubSpotOAuthTokens;
    try {
      tokens = await dependencies.exchange(code);
    } catch {
      console.error("[hubspot-callback] OAuth exchange failed", { code: "oauth_exchange_failed" });
      return Response.redirect(new URL("/?hubspot=error&reason=oauth_exchange_failed", url));
    }
    try {
      await dependencies.persist(tokens);
      return Response.redirect(new URL("/?hubspot=connected", url));
    } catch {
      console.error("[hubspot-callback] OAuth token storage failed", { code: "oauth_storage_failed" });
      return Response.redirect(new URL("/?hubspot=error&reason=oauth_storage_failed", url));
    }
  };
}
