import {
  getHubSpotConnectionStatus,
  getHubSpotHealth,
} from "@/lib/hubspot-sync";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const connection = await getHubSpotConnectionStatus();
    let health = {
      totalSyncedContacts: 0,
      safeToContact: 0,
      unsubscribedExcluded: 0,
      recentlyContactedExcluded: 0,
    };

    try {
      health = await getHubSpotHealth();
    } catch (healthError) {
      if (connection.status !== "private_token") {
        throw healthError;
      }
    }

    return Response.json({ connection, health });
  } catch (statusError) {
    return Response.json(
      {
        error:
          statusError instanceof Error
            ? statusError.message
            : "Unable to load HubSpot status.",
      },
      { status: 500 },
    );
  }
}
