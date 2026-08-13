import assert from "node:assert/strict";
import test from "node:test";
import {
  handleDashboardGet,
  handleDashboardPost,
} from "../app/api/dashboard-data/route.ts";
import { handleCampaignPost } from "../app/api/campaigns/route.ts";

const user = { id: "fictional-user", email: "member@example.test" };

function createDatabase(seed = {}) {
  const tables = Object.fromEntries(
    ["clients", "client_events", "campaigns", "email_templates", "campaign_steps"]
      .map((table) => [table, structuredClone(seed[table] ?? [])]),
  );
  const calls = [];
  let nextId = 1;

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.operation = "select";
      this.payload = undefined;
      this.singleResult = false;
      calls.push({ table, query: this });
    }

    select() { return this; }
    order() { return this; }
    limit() { return this; }
    single() { this.singleResult = true; return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    insert(payload) { this.operation = "insert"; this.payload = structuredClone(payload); return this; }
    update(payload) { this.operation = "update"; this.payload = structuredClone(payload); return this; }
    delete() { this.operation = "delete"; return this; }

    matches(row) {
      return this.filters.every(([column, value]) => row[column] === value);
    }

    execute() {
      const rows = tables[this.table];
      if (this.operation === "select") {
        const data = rows.filter((row) => this.matches(row)).map((row) => structuredClone(row));
        return this.singleResult
          ? data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: "Expected one row." } }
          : { data, error: null };
      }

      if (this.operation === "insert") {
        const inserted = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((row) => ({
          id: row.id ?? `${this.table}-${nextId++}`,
          ...row,
        }));
        for (const row of inserted) {
          if (this.table === "client_events" && !tables.clients.some((client) =>
            client.id === row.client_id && client.workspace_id === row.workspace_id)) {
            return { data: null, error: { message: "Cross-workspace client event rejected." } };
          }
          if (["email_templates", "campaign_steps"].includes(this.table) && !tables.campaigns.some((campaign) =>
            campaign.id === row.campaign_id && campaign.workspace_id === row.workspace_id)) {
            return { data: null, error: { message: "Cross-workspace campaign relationship rejected." } };
          }
        }
        rows.push(...inserted);
        const data = Array.isArray(this.payload) ? inserted : inserted[0];
        return { data, error: null };
      }

      const matched = rows.filter((row) => this.matches(row));
      if (this.operation === "update") {
        for (const row of matched) Object.assign(row, this.payload);
      }
      if (this.operation === "delete") {
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (this.matches(rows[index])) rows.splice(index, 1);
        }
      }
      const data = matched.map((row) => structuredClone(row));
      return this.singleResult
        ? data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: "Expected one row." } }
        : { data, error: null };
    }

    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
  }

  return {
    calls,
    tables,
    client: { from: (table) => new Query(table) },
  };
}

function authorize(database, workspaceId = "workspace-a") {
  return async () => ({
    ok: true,
    context: {
      user,
      workspaceId,
      role: "owner",
      source: "membership",
      supabaseAdmin: database.client,
    },
  });
}

function jsonRequest(path, body, requestWorkspace = "hostile-workspace") {
  return new Request(`http://localhost${path}?workspace_id=${requestWorkspace}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `workspace_id=${requestWorkspace}`,
      "x-workspace-id": requestWorkspace,
    },
    body: JSON.stringify({ ...body, workspace_id: requestWorkspace }),
  });
}

test("dashboard reads only the trusted workspace with overlapping-looking records", async () => {
  const database = createDatabase({
    clients: [
      { id: "client-a", workspace_id: "workspace-a", email: "shared@example.test" },
      { id: "client-b", workspace_id: "workspace-b", email: "shared@example.test" },
    ],
    campaigns: [{ id: "campaign-a", workspace_id: "workspace-a" }, { id: "campaign-b", workspace_id: "workspace-b" }],
    email_templates: [{ id: "template-a", campaign_id: "campaign-a", workspace_id: "workspace-a" }, { id: "template-b", campaign_id: "campaign-b", workspace_id: "workspace-b" }],
    campaign_steps: [{ id: "step-a", campaign_id: "campaign-a", workspace_id: "workspace-a" }, { id: "step-b", campaign_id: "campaign-b", workspace_id: "workspace-b" }],
    client_events: [{ id: "event-a", client_id: "client-a", workspace_id: "workspace-a" }, { id: "event-b", client_id: "client-b", workspace_id: "workspace-b" }],
  });
  const auth = authorize(database);

  const clients = await (await handleDashboardGet(new Request("http://localhost/api/dashboard-data?resource=clients&workspace_id=workspace-b"), auth)).json();
  assert.deepEqual(clients.clients.map((row) => row.id), ["client-a"]);

  const config = await (await handleDashboardGet(new Request("http://localhost/api/dashboard-data?resource=campaign-config"), auth)).json();
  assert.deepEqual(config.campaigns.map((row) => row.id), ["campaign-a"]);
  assert.deepEqual(config.emailTemplates.map((row) => row.id), ["template-a"]);
  assert.deepEqual(config.campaignSteps.map((row) => row.id), ["step-a"]);

  const timeline = await (await handleDashboardGet(new Request("http://localhost/api/dashboard-data?resource=timeline&clientId=client-a"), auth)).json();
  assert.deepEqual(timeline.events.map((row) => row.id), ["event-a"]);
  const hostileTimeline = await (await handleDashboardGet(new Request("http://localhost/api/dashboard-data?resource=timeline&clientId=client-b&workspace_id=workspace-b"), auth)).json();
  assert.deepEqual(hostileTimeline.events, []);
});

test("client updates are workspace-scoped and create same-workspace events only", async () => {
  const database = createDatabase({
    clients: [{ id: "client-a", workspace_id: "workspace-a", email: "old-a@example.test" }, { id: "client-b", workspace_id: "workspace-b", email: "old-b@example.test" }],
  });
  const auth = authorize(database);
  const hostile = await handleDashboardPost(jsonRequest("/api/dashboard-data", {
    action: "update_client",
    client: { id: "client-b", email: "hostile@example.test", workspace_id: "workspace-b" },
  }), auth);
  assert.equal(hostile.status, 500);
  assert.equal(database.tables.clients.find((row) => row.id === "client-b").email, "old-b@example.test");
  assert.equal(database.tables.client_events.length, 0);

  const allowed = await handleDashboardPost(jsonRequest("/api/dashboard-data", {
    action: "update_client",
    client: { id: "client-a", email: "new-a@example.test", workspace_id: "workspace-b" },
  }), auth);
  assert.deepEqual(await allowed.json(), { id: "client-a" });
  assert.equal(database.tables.clients.find((row) => row.id === "client-a").email, "new-a@example.test");
  assert.equal(database.tables.client_events[0].workspace_id, "workspace-a");
  assert.equal(database.tables.client_events[0].client_id, "client-a");

  const crossWorkspaceEvent = await database.client.from("client_events").insert({
    workspace_id: "workspace-a",
    client_id: "client-b",
    event_type: "hostile_fixture",
  });
  assert.match(crossWorkspaceEvent.error.message, /Cross-workspace client event rejected/);
});

test("campaign update and delete cannot target another workspace", async () => {
  const database = createDatabase({ campaigns: [
    { id: "campaign-a", workspace_id: "workspace-a", status: "draft" },
    { id: "campaign-b", workspace_id: "workspace-b", status: "draft" },
  ] });
  const auth = authorize(database);
  assert.equal((await handleDashboardPost(jsonRequest("/api/dashboard-data", { action: "set_campaign_status", campaignId: "campaign-b", status: "active" }), auth)).status, 200);
  assert.equal(database.tables.campaigns.find((row) => row.id === "campaign-b").status, "draft");
  assert.equal((await handleDashboardPost(jsonRequest("/api/dashboard-data", { action: "delete_campaign", campaignId: "campaign-b" }), auth)).status, 200);
  assert.ok(database.tables.campaigns.some((row) => row.id === "campaign-b"));

  const hostileSave = await handleCampaignPost(jsonRequest("/api/campaigns", {
    id: "campaign-b",
    name: "Hostile update",
  }), auth);
  assert.equal(hostileSave.status, 500);
  assert.notEqual(database.tables.campaigns.find((row) => row.id === "campaign-b").name, "Hostile update");

  const allowedSave = await handleCampaignPost(jsonRequest("/api/campaigns", {
    id: "campaign-a",
    name: "Allowed update",
  }), auth);
  assert.equal(allowedSave.status, 200);
  assert.equal((await allowedSave.json()).campaign.name, "Allowed update");
});

test("template and step relationships stay within the trusted workspace", async () => {
  const database = createDatabase({
    campaigns: [{ id: "campaign-a", workspace_id: "workspace-a" }, { id: "campaign-b", workspace_id: "workspace-b" }],
    campaign_steps: [{ id: "step-a", campaign_id: "campaign-a", workspace_id: "workspace-a", subject_template: "old" }, { id: "step-b", campaign_id: "campaign-b", workspace_id: "workspace-b", subject_template: "old" }],
  });
  const auth = authorize(database);
  const validTemplate = await handleDashboardPost(jsonRequest("/api/dashboard-data", { action: "create_template", template: { campaign_id: "campaign-a", name: "Allowed", workspace_id: "workspace-b" } }), auth);
  assert.equal(validTemplate.status, 200);
  assert.equal(database.tables.email_templates[0].workspace_id, "workspace-a");

  const hostileTemplate = await handleDashboardPost(jsonRequest("/api/dashboard-data", { action: "create_template", template: { campaign_id: "campaign-b", name: "Denied" } }), auth);
  assert.equal(hostileTemplate.status, 500);
  assert.equal(database.tables.email_templates.length, 1);

  await handleDashboardPost(jsonRequest("/api/dashboard-data", { action: "update_campaign_step", stepId: "step-b", subject: "hostile" }), auth);
  assert.equal(database.tables.campaign_steps.find((row) => row.id === "step-b").subject_template, "old");
  await handleDashboardPost(jsonRequest("/api/dashboard-data", { action: "update_campaign_step", stepId: "step-a", subject: "allowed" }), auth);
  assert.equal(database.tables.campaign_steps.find((row) => row.id === "step-a").subject_template, "allowed");
});

test("all inserts use the trusted workspace and authorization failures remain closed", async () => {
  const database = createDatabase();
  const auth = authorize(database);
  const created = await handleDashboardPost(jsonRequest("/api/dashboard-data", { action: "create_client", client: { email: "client@example.test", workspace_id: "workspace-b" } }), auth);
  assert.match((await created.json()).id, /^clients-/);
  await handleDashboardPost(jsonRequest("/api/dashboard-data", { action: "import_clients", clients: [{ email: "import@example.test", workspace_id: "workspace-b" }] }), auth);
  const campaign = await handleCampaignPost(jsonRequest("/api/campaigns", { name: "Campaign", workspace_id: "workspace-b" }), auth);
  assert.equal((await campaign.json()).campaign.workspace_id, "workspace-a");
  assert.ok(database.tables.clients.every((row) => row.workspace_id === "workspace-a"));
  assert.ok(database.tables.client_events.every((row) => row.workspace_id === "workspace-a"));

  for (const [status, reason] of [[401, "unauthenticated"], [403, "forbidden"]]) {
    const before = database.calls.length;
    const response = await handleDashboardGet(
      new Request("http://localhost/api/dashboard-data?resource=clients"),
      async () => ({ ok: false, reason, response: Response.json({ error: reason }, { status }) }),
    );
    assert.equal(response.status, status);
    assert.equal(database.calls.length, before);
  }
  await assert.rejects(
    handleDashboardPost(jsonRequest("/api/dashboard-data", { action: "create_client", client: { email: "blocked@example.test" } }), async () => { throw new Error("membership lookup failed"); }),
    /membership lookup failed/,
  );
});
