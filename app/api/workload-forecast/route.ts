import { getWorkloadForecast } from "../../../lib/workload-forecast.ts";
import { authorizeOwner } from "../../../lib/authorization.ts";

export const dynamic = "force-dynamic";

export function createWorkloadForecastGetHandler(
  loadForecast: typeof getWorkloadForecast = getWorkloadForecast,
  authorize: typeof authorizeOwner = authorizeOwner,
) {
  return async function workloadForecastGet() {
    const authorization = await authorize();
    if (!authorization.ok) return authorization.response;
  try {
      return Response.json(await loadForecast());
  } catch (error) {
    console.error("[workload-forecast] read failed", {
      message: error instanceof Error ? error.message : "Unknown forecast error",
    });

    return Response.json(
      { error: "Unable to load workload forecast." },
      { status: 500 },
    );
  }
  };
}

export const GET = createWorkloadForecastGetHandler();
