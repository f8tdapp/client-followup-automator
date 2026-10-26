import { authorizeOwner } from "@/lib/authorization";
import {
  getResultsSummary,
  recordContactOutcomes,
  ResultsOperationError,
} from "@/lib/results";
import { getEmailDomain } from "@/lib/results-summary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const authorization = await authorizeOwner();
  if (!authorization.ok) return authorization.response;

  try {
    return Response.json({
      ok: true,
      summary: await getResultsSummary(),
      ownerDomain: getEmailDomain(authorization.user.email),
    });
  } catch (resultsError) {
    return handleResultsError(resultsError);
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeOwner();
  if (!authorization.ok) return authorization.response;

  let body: { action?: unknown; emails?: unknown; outcome?: unknown; note?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.action !== "record_outcomes") {
    return Response.json({ ok: false, error: "Unknown action." }, { status: 400 });
  }

  try {
    return Response.json(
      await recordContactOutcomes({
        emails: body.emails,
        outcome: body.outcome,
        note: body.note,
        actorEmail: authorization.user.email ?? "authorized owner",
      }),
    );
  } catch (resultsError) {
    return handleResultsError(resultsError);
  }
}

function handleResultsError(resultsError: unknown) {
  if (resultsError instanceof ResultsOperationError) {
    return Response.json(
      { ok: false, error: resultsError.message },
      { status: resultsError.status },
    );
  }

  console.error("[results] unexpected error", {
    message: resultsError instanceof Error ? resultsError.message : "Unknown error",
  });

  return Response.json(
    { ok: false, error: "Results are unavailable right now." },
    { status: 500 },
  );
}
