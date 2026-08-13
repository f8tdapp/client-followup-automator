import {
  getHubSpotConnectionStatus,
  getHubSpotHealth,
  getDailyRecommendations,
  syncHubSpotContacts,
} from "@/lib/hubspot-sync";
import { getWorkspaceRuntimeContext } from "@/lib/workspace-runtime-context";

export const dynamic = "force-dynamic";

export async function POST() {
  const authorization = await getWorkspaceRuntimeContext();
  if (!authorization.ok) return authorization.response;
  try {
    const syncResult = await syncHubSpotContacts();
    const [connection, health, recommendations] = await Promise.all([
      getHubSpotConnectionStatus(),
      getHubSpotHealth(),
      getDailyRecommendations(),
    ]);

    return Response.json({
      ...syncResult,
      connection,
      health,
      recommendations,
    });
  } catch (syncError) {
    return Response.json(
      {
        error:
          syncError instanceof Error
            ? syncError.message
            : "Unable to sync HubSpot.",
      },
      { status: 500 },
    );
  }
}
