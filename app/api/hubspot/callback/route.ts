import { exchangeOAuthCodeForTokens, getHubSpotScopes } from "@/lib/hubspot";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return Response.redirect(new URL(`/?hubspot=error&reason=${error}`, url));
  }

  if (!code) {
    return Response.redirect(new URL("/?hubspot=missing_code", url));
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const tokens = await exchangeOAuthCodeForTokens(code);
    const tokenExpiresAt = new Date(
      Date.now() + tokens.expires_in * 1000,
    ).toISOString();

    // Development storage only. TODO: encrypt access_token and refresh_token
    // with a production-grade key management strategy before launch.
    const { error: upsertError } = await supabaseAdmin
      .from("hubspot_connections")
      .upsert(
        {
          provider: "hubspot",
          portal_id: tokens.hub_id ? String(tokens.hub_id) : null,
          status: "connected",
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: tokenExpiresAt,
          scopes: getHubSpotScopes().split(/\s+/).filter(Boolean),
          last_error: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "provider" },
      );

    if (upsertError) {
      throw new Error(upsertError.message);
    }

    return Response.redirect(new URL("/?hubspot=connected", url));
  } catch (callbackError) {
    const reason =
      callbackError instanceof Error ? callbackError.message : "callback_failed";

    return Response.redirect(
      new URL(`/?hubspot=error&reason=${encodeURIComponent(reason)}`, url),
    );
  }
}
