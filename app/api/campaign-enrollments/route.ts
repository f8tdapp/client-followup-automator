import {
  getCampaignEnrollmentOverview,
  setNewEnrollmentsPaused,
} from "@/lib/campaign-enrollment";
import { authorizeOwner } from "@/lib/authorization";

export const dynamic = "force-dynamic";

export async function GET() {
  const authorization = await authorizeOwner();
  if (!authorization.ok) return authorization.response;
  try {
    return Response.json({ overview: await getCampaignEnrollmentOverview() });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load campaign enrolment summary.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeOwner();
  if (!authorization.ok) return authorization.response;
  let body: {
    campaignId?: unknown;
    newEnrollmentsPaused?: unknown;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (
    typeof body.campaignId !== "string" ||
    !body.campaignId.trim() ||
    typeof body.newEnrollmentsPaused !== "boolean"
  ) {
    return Response.json(
      { error: "Campaign ID and pause state are required." },
      { status: 400 },
    );
  }

  try {
    const campaign = await setNewEnrollmentsPaused(
      body.campaignId,
      body.newEnrollmentsPaused,
    );
    return Response.json({
      campaign,
      overview: await getCampaignEnrollmentOverview(),
      message: body.newEnrollmentsPaused
        ? "New enrolments paused. Existing enrolments will continue."
        : "New enrolments resumed.",
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to update enrolment pause state.",
      },
      { status: 500 },
    );
  }
}
