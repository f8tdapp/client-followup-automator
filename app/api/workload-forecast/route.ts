import { getWorkloadForecast } from "../../../lib/workload-forecast.ts";

export const dynamic = "force-dynamic";

export function createWorkloadForecastGetHandler(
  loadForecast: typeof getWorkloadForecast = getWorkloadForecast,
) {
  return async function workloadForecastGet() {
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
