import {
  generateDailyRecommendations,
  getDailyRecommendations,
} from "@/lib/hubspot-sync";
import { getWorkspaceRuntimeContext } from "@/lib/workspace-runtime-context";

export const dynamic = "force-dynamic";

export async function GET() {
  const authorization = await getWorkspaceRuntimeContext();
  if (!authorization.ok) return authorization.response;
  try {
    const recommendations = await getDailyRecommendations();

    return Response.json({ recommendations });
  } catch (recommendationsError) {
    return Response.json(
      {
        error:
          recommendationsError instanceof Error
            ? recommendationsError.message
            : "Unable to load recommendations.",
      },
      { status: 500 },
    );
  }
}

export async function POST() {
  const authorization = await getWorkspaceRuntimeContext();
  if (!authorization.ok) return authorization.response;
  try {
    const recommendationsCreated = await generateDailyRecommendations();
    const recommendations = await getDailyRecommendations();

    return Response.json({ recommendationsCreated, recommendations });
  } catch (recommendationsError) {
    return Response.json(
      {
        error:
          recommendationsError instanceof Error
            ? recommendationsError.message
            : "Unable to generate recommendations.",
      },
      { status: 500 },
    );
  }
}
