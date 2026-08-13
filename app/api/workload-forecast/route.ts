import { getWorkloadForecast } from "../../../lib/workload-forecast.ts";
import {
  getWorkspaceRuntimeContext,
  type WorkspaceRuntimeContext,
} from "../../../lib/workspace-runtime-context.ts";

export const dynamic = "force-dynamic";

export function createWorkloadForecastGetHandler(
  loadForecast: (context: WorkspaceRuntimeContext) => ReturnType<typeof getWorkloadForecast> =
    () => getWorkloadForecast(),
  authorize: typeof getWorkspaceRuntimeContext = getWorkspaceRuntimeContext,
) {
  return async function workloadForecastGet() {
    const authorization = await authorize();
    if (!authorization.ok) return authorization.response;
    try {
      return Response.json(await loadForecast(authorization.context));
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
