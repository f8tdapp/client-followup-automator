import {
  fetchHubSpotContacts,
  getHubSpotPrivateAppToken,
  hasHubSpotPrivateToken,
  refreshHubSpotTokens,
} from "@/lib/hubspot";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

type HubSpotConnection = {
  id: string;
  status: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  last_sync_at: string | null;
};

type HubSpotContactRow = {
  hubspot_contact_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  is_unsubscribed: boolean;
  last_contacted_at: string | null;
  last_engaged_at: string | null;
};

const provider = "hubspot";

export async function getHubSpotConnection() {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("hubspot_connections")
    .select("*")
    .eq("provider", provider)
    .maybeSingle<HubSpotConnection>();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function getHubSpotConnectionStatus() {
  if (hasHubSpotPrivateToken()) {
    return getPrivateTokenConnectionStatus();
  }

  const supabaseAdmin = getSupabaseAdmin();
  const connection = await getHubSpotConnection();
  const { count, error } = await supabaseAdmin
    .from("hubspot_contacts")
    .select("id", { count: "exact", head: true });

  if (error) {
    throw new Error(error.message);
  }

  if (!connection) {
    return {
      status: "not_connected",
      lastSyncAt: null,
      contactsSynced: count ?? 0,
    };
  }

  const needsReconnect =
    !connection.refresh_token ||
    (connection.status !== "connected" && connection.status !== "needs_reconnect");

  return {
    status: needsReconnect ? "needs_reconnect" : connection.status,
    lastSyncAt: connection.last_sync_at,
    contactsSynced: count ?? 0,
  };
}

async function getPrivateTokenConnectionStatus() {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { count } = await supabaseAdmin
      .from("hubspot_contacts")
      .select("id", { count: "exact", head: true });

    return {
      status: "private_token",
      lastSyncAt: null,
      contactsSynced: count ?? 0,
    };
  } catch {
    return {
      status: "private_token",
      lastSyncAt: null,
      contactsSynced: 0,
    };
  }
}

export async function getValidAccessToken(connection: HubSpotConnection) {
  const supabaseAdmin = getSupabaseAdmin();
  if (!connection.access_token) {
    throw new Error("HubSpot is not connected.");
  }

  const expiresAt = connection.token_expires_at
    ? new Date(connection.token_expires_at).getTime()
    : 0;
  const shouldRefresh = expiresAt - Date.now() < 60_000;

  if (!shouldRefresh) {
    return connection.access_token;
  }

  if (!connection.refresh_token) {
    await markConnectionNeedsReconnect("Missing refresh token.");
    throw new Error("HubSpot needs to be reconnected.");
  }

  const refreshedTokens = await refreshHubSpotTokens(connection.refresh_token);
  const tokenExpiresAt = new Date(
    Date.now() + refreshedTokens.expires_in * 1000,
  ).toISOString();

  const { error } = await supabaseAdmin
    .from("hubspot_connections")
    .update({
      access_token: refreshedTokens.access_token,
      refresh_token: refreshedTokens.refresh_token ?? connection.refresh_token,
      token_expires_at: tokenExpiresAt,
      status: "connected",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id);

  if (error) {
    throw new Error(error.message);
  }

  return refreshedTokens.access_token;
}

export async function syncHubSpotContacts() {
  const supabaseAdmin = getSupabaseAdmin();
  const privateAppToken = getHubSpotPrivateAppToken();
  const connection = privateAppToken ? null : await getHubSpotConnection();

  if (!privateAppToken && (!connection || connection.status !== "connected")) {
    throw new Error("Connect HubSpot before syncing.");
  }

  try {
    // TODO: OAuth is required later for multi-user/customer installations.
    // HUBSPOT_PRIVATE_APP_TOKEN is only the default early testing path.
    const accessToken = privateAppToken ?? (await getValidAccessToken(connection!));
    const contacts = await fetchHubSpotContacts(accessToken);

    if (contacts.length > 0) {
      const { error } = await supabaseAdmin
        .from("hubspot_contacts")
        .upsert(contacts, { onConflict: "hubspot_contact_id" });

      if (error) {
        throw new Error(error.message);
      }
    }

    if (privateAppToken) {
      await upsertPrivateTokenConnectionSynced();
    } else {
      const { error: connectionError } = await supabaseAdmin
        .from("hubspot_connections")
        .upsert(
          {
            provider,
            status: "connected",
            last_sync_at: new Date().toISOString(),
            last_error: null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "provider" },
        );

      if (connectionError) {
        throw new Error(connectionError.message);
      }
    }

    const recommendationsCreated = await generateDailyRecommendations();

    return {
      contactsSynced: contacts.length,
      recommendationsCreated,
    };
  } catch (syncError) {
    if (privateAppToken) {
      await upsertPrivateTokenConnectionError(
        syncError instanceof Error ? syncError.message : "HubSpot sync failed.",
      );
    } else {
      await markConnectionNeedsReconnect(
        syncError instanceof Error ? syncError.message : "HubSpot sync failed.",
      );
    }
    throw syncError;
  }
}

export async function generateDailyRecommendations() {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("hubspot_contacts")
    .select(
      "hubspot_contact_id,email,first_name,last_name,company,is_unsubscribed,last_contacted_at,last_engaged_at",
    )
    .order("last_engaged_at", { ascending: false, nullsFirst: false })
    .returns<HubSpotContactRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows = (data ?? [])
    .filter((contact) => shouldRecommend(contact))
    .map((contact) => {
      const hasRecentEngagement = isWithinDays(contact.last_engaged_at, 30);

      return {
        recommendation_date: today,
        hubspot_contact_id: contact.hubspot_contact_id,
        recommended_action: hasRecentEngagement
          ? "Follow up while they are warm"
          : "Send a friendly check-in",
        reason: getRecommendationReason(contact, hasRecentEngagement),
        status: "pending",
        priority: getRecommendationPriority(contact, hasRecentEngagement),
        updated_at: new Date().toISOString(),
      };
    })
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 10);

  if (rows.length === 0) {
    return 0;
  }

  const { error: upsertError } = await supabaseAdmin
    .from("daily_recommendations")
    .upsert(rows, { onConflict: "recommendation_date,hubspot_contact_id" });

  if (upsertError) {
    throw new Error(upsertError.message);
  }

  return rows.length;
}

export async function getDailyRecommendations() {
  const supabaseAdmin = getSupabaseAdmin();
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabaseAdmin
    .from("daily_recommendations")
    .select(
      "id,recommendation_date,hubspot_contact_id,recommended_action,reason,status,priority,hubspot_contacts(first_name,last_name,company,email,last_contacted_at,is_unsubscribed)",
    )
    .eq("recommendation_date", today)
    .order("priority", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function getHubSpotHealth() {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("hubspot_contacts")
    .select("is_unsubscribed,last_contacted_at");

  if (error) {
    throw new Error(error.message);
  }

  const contacts = data ?? [];

  return {
    totalSyncedContacts: contacts.length,
    safeToContact: contacts.filter(
      (contact) =>
        !contact.is_unsubscribed && !isWithinDays(contact.last_contacted_at, 7),
    ).length,
    unsubscribedExcluded: contacts.filter((contact) => contact.is_unsubscribed)
      .length,
    recentlyContactedExcluded: contacts.filter(
      (contact) =>
        !contact.is_unsubscribed && isWithinDays(contact.last_contacted_at, 7),
    ).length,
  };
}

async function markConnectionNeedsReconnect(lastError: string) {
  const supabaseAdmin = getSupabaseAdmin();
  await supabaseAdmin
    .from("hubspot_connections")
    .update({
      status: "needs_reconnect",
      last_error: lastError,
      updated_at: new Date().toISOString(),
    })
    .eq("provider", provider);
}

async function upsertPrivateTokenConnectionError(lastError: string) {
  const supabaseAdmin = getSupabaseAdmin();
  try {
    await supabaseAdmin.from("hubspot_connections").upsert(
      {
        provider,
        status: "private_token",
        last_error: lastError,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider" },
    );
  } catch {
    // Private-token mode must not depend on an OAuth connection row.
  }
}

async function upsertPrivateTokenConnectionSynced() {
  const supabaseAdmin = getSupabaseAdmin();
  try {
    await supabaseAdmin.from("hubspot_connections").upsert(
      {
        provider,
        status: "private_token",
        last_sync_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider" },
    );
  } catch {
    // Private-token mode can sync contacts before OAuth metadata exists.
  }
}

function shouldRecommend(contact: HubSpotContactRow) {
  if (contact.is_unsubscribed) {
    return false;
  }

  if (isWithinDays(contact.last_contacted_at, 7)) {
    return false;
  }

  return (
    !contact.last_contacted_at ||
    isOlderThanDays(contact.last_contacted_at, 14) ||
    isWithinDays(contact.last_engaged_at, 30)
  );
}

function getRecommendationPriority(
  contact: HubSpotContactRow,
  hasRecentEngagement: boolean,
) {
  let priority = 10;

  if (!contact.last_contacted_at) {
    priority += 10;
  }

  if (isOlderThanDays(contact.last_contacted_at, 14)) {
    priority += 10;
  }

  if (hasRecentEngagement) {
    priority += 20;
  }

  return priority;
}

function getRecommendationReason(
  contact: HubSpotContactRow,
  hasRecentEngagement: boolean,
) {
  if (hasRecentEngagement) {
    return "Recommended because they recently engaged and are safe to contact.";
  }

  if (!contact.last_contacted_at) {
    return "Recommended because they have not heard from you yet.";
  }

  return "Recommended because they have not heard from you in at least 14 days.";
}

function isWithinDays(value: string | null, days: number) {
  if (!value) {
    return false;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return Date.now() - date.getTime() <= days * 24 * 60 * 60 * 1000;
}

function isOlderThanDays(value: string | null, days: number) {
  if (!value) {
    return false;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return Date.now() - date.getTime() > days * 24 * 60 * 60 * 1000;
}
