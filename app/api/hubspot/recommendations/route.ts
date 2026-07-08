import {
  generateDailyRecommendations,
  getDailyRecommendations,
} from "@/lib/hubspot-sync";

export const dynamic = "force-dynamic";

export async function GET() {
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
