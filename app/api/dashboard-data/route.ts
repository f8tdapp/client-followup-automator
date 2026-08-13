import { getWorkspaceRuntimeContext } from "@/lib/workspace-runtime-context";

export const dynamic = "force-dynamic";

type DashboardMutation = {
  action?: unknown;
  campaignId?: unknown;
  client?: unknown;
  clients?: unknown;
  eventDetails?: unknown;
  status?: unknown;
  stepId?: unknown;
  subject?: unknown;
  body?: unknown;
  template?: unknown;
};

export async function GET(request: Request) {
  const authorization = await getWorkspaceRuntimeContext();
  if (!authorization.ok) return authorization.response;

  const url = new URL(request.url);
  const resource = url.searchParams.get("resource");
  const supabase = authorization.context.supabaseAdmin;

  if (resource === "clients") {
    const { data, error } = await supabase
      .from("clients")
      .select("*")
      .order("created_at", { ascending: false });
    return databaseResponse("clients", data, error);
  }

  if (resource === "campaign-config") {
    const [campaigns, templates, steps] = await Promise.all([
      supabase.from("campaigns").select("*").order("created_at", { ascending: false }),
      supabase.from("email_templates").select("*").order("created_at", { ascending: false }),
      supabase.from("campaign_steps").select("*").order("step_number", { ascending: true }),
    ]);
    const error = campaigns.error ?? templates.error ?? steps.error;
    if (error) return databaseResponse("campaign configuration", null, error);
    return Response.json({
      campaigns: campaigns.data ?? [],
      emailTemplates: templates.data ?? [],
      campaignSteps: steps.data ?? [],
    });
  }

  if (resource === "timeline") {
    const clientId = url.searchParams.get("clientId")?.trim();
    if (!clientId) return Response.json({ error: "Client ID is required." }, { status: 400 });
    const { data, error } = await supabase
      .from("client_events")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(20);
    return databaseResponse("events", data, error);
  }

  return Response.json({ error: "Unknown dashboard resource." }, { status: 400 });
}

export async function POST(request: Request) {
  const authorization = await getWorkspaceRuntimeContext();
  if (!authorization.ok) return authorization.response;

  let input: DashboardMutation;
  try {
    input = (await request.json()) as DashboardMutation;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const supabase = authorization.context.supabaseAdmin;
  const action = typeof input.action === "string" ? input.action : "";

  if (action === "create_client") {
    const client = record(input.client);
    const email = string(client.email);
    if (!email) return Response.json({ error: "Email is required." }, { status: 400 });
    const { data, error } = await supabase
      .from("clients")
      .insert(clientPayload(client))
      .select("id")
      .single();
    if (error) return databaseResponse("client", null, error);
    const { error: eventError } = await supabase.from("client_events").insert({
      client_id: data.id,
      event_type: "manual_add",
      details: "Contact manually added as a backup option.",
    });
    if (eventError) return databaseResponse("client event", null, eventError);
    return Response.json({ id: data.id });
  }

  if (action === "import_clients") {
    const clients = Array.isArray(input.clients)
      ? input.clients.map(record).map(clientPayload)
      : [];
    if (clients.length === 0) return Response.json({ inserted: [] });
    if (clients.length > 2000 || clients.some((client) => !string(client.email))) {
      return Response.json({ error: "Import contains invalid contacts." }, { status: 400 });
    }
    const { data, error } = await supabase.from("clients").insert(clients).select("id,email");
    if (error) return databaseResponse("clients", null, error);
    const details = string(input.eventDetails) || "Imported from CSV.";
    const events = (data ?? []).map((client) => ({ client_id: client.id, event_type: "csv_import", details }));
    if (events.length) {
      const { error: eventError } = await supabase.from("client_events").insert(events);
      if (eventError) return databaseResponse("client events", null, eventError);
    }
    return Response.json({ inserted: data ?? [] });
  }

  if (action === "set_campaign_status" || action === "delete_campaign") {
    const campaignId = string(input.campaignId);
    if (!campaignId) return Response.json({ error: "Campaign ID is required." }, { status: 400 });
    const status = action === "set_campaign_status" ? campaignStatus(input.status) : null;
    if (action === "set_campaign_status" && !status) {
      return Response.json({ error: "Invalid campaign status." }, { status: 400 });
    }
    const query = action === "delete_campaign"
      ? supabase.from("campaigns").delete().eq("id", campaignId)
      : supabase.from("campaigns").update({ status, updated_at: new Date().toISOString() }).eq("id", campaignId);
    const { error } = await query;
    return error ? databaseResponse("campaign", null, error) : Response.json({ ok: true });
  }

  if (action === "create_template") {
    const template = record(input.template);
    if (!string(template.campaign_id) || !string(template.name)) {
      return Response.json({ error: "Campaign and template name are required." }, { status: 400 });
    }
    const { error } = await supabase.from("email_templates").insert({
      campaign_id: string(template.campaign_id),
      name: string(template.name),
      subject: string(template.subject),
      body: string(template.body),
    });
    return error ? databaseResponse("template", null, error) : Response.json({ ok: true });
  }

  if (action === "update_campaign_step") {
    const stepId = string(input.stepId);
    if (!stepId) return Response.json({ error: "Campaign step ID is required." }, { status: 400 });
    const { error } = await supabase.from("campaign_steps").update({
      subject_template: string(input.subject),
      body_template: string(input.body),
      updated_at: new Date().toISOString(),
    }).eq("id", stepId);
    return error ? databaseResponse("campaign step", null, error) : Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown dashboard action." }, { status: 400 });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value: unknown) {
  return string(value) || null;
}

function clientPayload(client: Record<string, unknown>) {
  return {
    first_name: nullableString(client.first_name),
    last_name: nullableString(client.last_name),
    company: nullableString(client.company),
    email: string(client.email),
    phone: nullableString(client.phone),
    notes: nullableString(client.notes),
  };
}

function campaignStatus(value: unknown) {
  const status = string(value);
  return ["draft", "active", "paused", "completed"].includes(status) ? status : null;
}

function databaseResponse(resource: string, data: unknown, error: { message: string } | null) {
  if (error) {
    console.error("[dashboard-data] database operation failed", { resource, message: error.message });
    return Response.json({ error: `Unable to process ${resource}.` }, { status: 500 });
  }
  return Response.json({ [resource]: data ?? [] });
}
