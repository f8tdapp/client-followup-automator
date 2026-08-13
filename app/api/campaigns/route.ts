import { getWorkspaceRuntimeContext } from "../../../lib/workspace-runtime-context.ts";
import {
  DEFAULT_NEW_CONTACTS_PER_DAY,
  DEFAULT_TOTAL_DAILY_LIMIT,
  normalizeDailyLimit,
} from "../../../lib/schedule-policy.ts";

type CampaignInput = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  daily_send_limit?: unknown;
  new_contacts_per_day?: unknown;
  cooldown_days?: unknown;
};

export async function POST(request: Request) {
  return handleCampaignPost(request);
}

export async function handleCampaignPost(
  request: Request,
  authorize: typeof getWorkspaceRuntimeContext = getWorkspaceRuntimeContext,
) {
  const authorization = await authorize();
  if (!authorization.ok) return authorization.response;
  let input: CampaignInput;

  try {
    input = (await request.json()) as CampaignInput;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";

  if (!name || name.length > 200) {
    return Response.json(
      { error: "Campaign name must be between 1 and 200 characters." },
      { status: 400 },
    );
  }

  const totalDailyLimit = normalizeDailyLimit(
    input.daily_send_limit,
    DEFAULT_TOTAL_DAILY_LIMIT,
  );
  const payload = {
    name,
    description:
      typeof input.description === "string" && input.description.trim()
        ? input.description.trim()
        : null,
    daily_limit: totalDailyLimit,
    daily_send_limit: totalDailyLimit,
    new_contacts_per_day: normalizeDailyLimit(
      input.new_contacts_per_day,
      DEFAULT_NEW_CONTACTS_PER_DAY,
    ),
    cooldown_days: normalizeDailyLimit(input.cooldown_days, 30),
    updated_at: new Date().toISOString(),
  };
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;
  const { supabaseAdmin, workspaceId } = authorization.context;
  const query = id
    ? supabaseAdmin
        .from("campaigns")
        .update(payload)
        .eq("id", id)
        .eq("workspace_id", workspaceId)
        .select("*")
        .single()
    : supabaseAdmin.from("campaigns").insert({ ...payload, workspace_id: workspaceId }).select("*").single();
  const { data, error } = await query;

  if (error) {
    console.error("[campaigns] save failed", {
      code: error.code,
      message: error.message,
    });
    return Response.json({ error: "Unable to save campaign." }, { status: 500 });
  }

  return Response.json({ campaign: data });
}
