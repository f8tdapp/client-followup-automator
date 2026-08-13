# Workspace runtime conversion map

Status: Batch B1 shared runtime authorization context complete locally. Runtime remains single-owner and domain operations remain unconverted. Migrations 012–014 and the OAuth primitives remain inactive. Of the 88 database call sites below, only the trusted membership lookup is B1-complete; all 87 domain operations remain pending.

Exact database call-site count: **88** (87 `.from(...)`, one `.rpc(...)`) across 10 files. Authorization-only routes/helpers are also guarded by the static inventory test.

## Reading the inventory

Every domain row remains `pending`; only the B1 membership lookup is `complete`. Current authorization (`Auth`) is `R` for a route guarded by `getWorkspaceRuntimeContext`, `C` for a helper whose route caller has that guard, and `W` for the membership resolver itself. Trusted workspace (`WS`) is always `authorizeWorkspace().workspaceId`, never request input; helpers must receive it as a required argument in their domain conversion batch. `eq` means add `.eq("workspace_id", workspaceId)`; `set` means insert/upsert `workspace_id`; mutations require both. Foreign IDs (`FK`) must be constrained by the same workspace, not merely trusted because UUIDs are globally unique. Tests (`T`) are: `I` two-workspace read isolation, `M` hostile mutation ID, `F` same-workspace foreign relationship, `U` composite upsert collision, `C` workspace-specific counts/capacity, `A` concurrency/atomicity, `O` OAuth identity/state. Dependencies (`D`) name the batch below.

Conflict targets required after 012: HubSpot connections `workspace_id,provider`; contacts `workspace_id,hubspot_contact_id`; recommendations `workspace_id,recommendation_date,hubspot_contact_id`; domain limits `workspace_id,broker_domain`; sending settings should use `workspace_id,provider`. Campaign steps require a Migration 014 target `workspace_id,campaign_id,step_number`; schedules require `workspace_id,contact_id,campaign_id,campaign_step_id,scheduled_date`; drafts require `workspace_id,schedule_id`.

## Operation inventory

| Location / function | Target · operation | Auth / WS action | Conflict or FK validation | T | D | Status |
|---|---|---|---|---|---|---|
| `lib/workspace-authorization.ts:63` `authorizeWorkspace` | workspace_members · select | W; user-id membership lookup (workspace is result) | workspace status/member active | I | B1 | complete |
| `app/api/dashboard-data/route.ts:29,37,38,39,54` `GET` | clients, campaigns, email_templates, campaign_steps, client_events · 5 selects | R; eq each | campaign/template/step and client/event joins same WS | I,F | B2 | pending |
| `app/api/dashboard-data/route.ts:84,89` `POST update_client` | clients update; client_events insert | R; eq+set | browser client ID; event client FK | M,F | B2 | pending |
| `app/api/dashboard-data/route.ts:106,111` `POST import_clients` | clients insert; client_events insert | R; set each row | returned client IDs feed events in same WS | I,F | B2 | pending |
| `app/api/dashboard-data/route.ts:125` `POST delete_campaign` | campaigns · delete | R; eq | browser campaign ID, cascades | M | B2 | pending |
| `app/api/dashboard-data/route.ts:126` `POST update_campaign` | campaigns · update | R; eq | browser campaign ID | M | B2 | pending |
| `app/api/dashboard-data/route.ts:136` `POST create_template` | email_templates · insert | R; set | browser campaign ID | F | B2 | pending |
| `app/api/dashboard-data/route.ts:148` `POST update_step` | campaign_steps · update | R; eq | browser step ID | M,F | B2 | pending |
| `app/api/campaigns/route.ts:61` `POST` | campaigns · update | R; eq | browser campaign ID | M | B2 | pending |
| `app/api/campaigns/route.ts:66` `POST` | campaigns · insert | R; set | none | I | B2 | pending |
| `lib/sending-settings.ts:66,80,104` `get/upsertSendingSettings` | sending_settings · select, insert, update | C; eq/set/eq | one row per WS/provider | I,M,C | B3 | pending |
| `lib/campaign-enrollment.ts:212` `setNewEnrollmentsPaused` | campaigns · update | C; eq | browser campaign ID | M,F | B4 | pending |
| `lib/campaign-enrollment.ts:231,243,253,263,274` summary source | campaigns, contacts, enrollments, suppressions, steps · 5 selects | C; eq each | all campaign/contact IDs same WS | I,F,C | B4 | pending |
| `lib/campaign-enrollment.ts:305` `callAtomicEnrollmentRpc` | enroll_eligible_campaign_contacts · RPC | C; pass `requested_workspace_id` | Migration 013 signature; browser campaign validated in RPC | F,C,A | B4 | pending |
| `lib/campaign-schedule.ts:314` generation | broker_domain_limits · upsert | C; set | conflict `workspace_id,broker_domain` | U,C | B5 | pending |
| `lib/campaign-schedule.ts:488` `getDailySendPlan` | daily_send_schedule · select | C; eq | nested campaign/step/contact rows | I,F,C | B5 | pending |
| `lib/campaign-schedule.ts:566,593,629` `createStarterCampaign` | campaigns · select, update, insert | C; eq/eq/set | starter lookup must be per WS | I,M | B5 | pending |
| `lib/campaign-schedule.ts:734,770` `resetStarterCampaignCopy` | campaigns select; campaign_steps upsert | C; eq/set | campaign same WS; composite conflict (M014) | F,U | B5 | pending |
| `lib/campaign-schedule.ts:808,847` active/schema checks | campaigns · 2 selects | C; eq | none | I | B5 | pending |
| `lib/campaign-schedule.ts:1088,1131` step preparation/repair | campaign_steps · select, upsert | C; eq/set | campaign IDs; composite conflict (M014) | F,U | B5 | pending |
| `lib/campaign-schedule.ts:1325,1403,1459` diagnostics | contacts, steps, enrollments · 3 selects | C; eq | supplied campaign IDs | I,F,C | B5 | pending |
| `lib/campaign-schedule.ts:1559,1581,1654` schedule enrichment | campaigns, steps, contacts · 3 selects | C; eq | IDs originated from scoped schedules | I,F | B5 | pending |
| `lib/campaign-schedule.ts:1708,1776,1897` preparation | enrollments, contacts, suppressions · 3 selects | C; eq | campaign/contact IDs | I,F,C | B5 | pending |
| `lib/campaign-schedule.ts:1951,1977` limits | domain limits, sending settings · 2 selects | C; eq | account/domain capacity per WS | I,C | B3→B5 | pending |
| `lib/campaign-schedule.ts:2007,2085` existing schedule | daily_send_schedule · 2 selects | C; eq | date/count per WS | I,C,A | B5 | pending |
| `lib/campaign-schedule.ts:2135` `upsertScheduleRow` | daily_send_schedule · upsert | C; set | contact/campaign/step same WS; composite conflict (M014) | F,U,A | B5 | pending |
| `lib/campaign-schedule.ts:2170,2193` roll/stop | enrollments · 2 updates | C; eq | enrollment ID derived from scoped load | M,F,A | B5 | pending |
| `lib/workload-forecast.ts:577,587,614,622` loader | campaigns, settings, steps, limits · 4 selects | C; eq each | campaign/step same WS | I,F,C | B5 | pending |
| `lib/workload-forecast.ts:632,649,679,684` loader | enrollments, schedules, contacts, suppressions · 4 selects | C; eq each | all IDs same WS | I,F,C | B5 | pending |
| `lib/email-drafts.ts:194` `generateTodayDrafts` | email_drafts · upsert | C; set | schedule/campaign/step same WS; conflict (M014) | F,U | B6 | pending |
| `lib/email-drafts.ts:285,370,436` draft mutations | email_drafts · 3 updates | C; eq | browser draft ID | M | B6 | pending |
| `lib/email-drafts.ts:462,487,515` loaders | schedules, drafts, schedules · 3 selects | C; eq | browser/derived IDs | I,F | B6 | pending |
| `lib/email-drafts.ts:543,575,598` manual progress | enrollments select, steps select, enrollments update | C; eq | schedule campaign/contact and enrollment/step | M,F,A | B6 | pending |
| `lib/email-drafts.ts:621,665,697` batch loaders | drafts, contacts, steps · 3 selects | C; eq | IDs from scoped schedules | I,F | B6 | pending |
| `app/api/hubspot/callback/route.ts:19` `persistOAuthTokens` | hubspot_connections · upsert | R; set from callback authorization | signed user/WS state; conflict `workspace_id,provider` | O,U | B7 | pending |
| `lib/hubspot-sync.ts:39,59,90` connection/status | connections, contacts, contacts · 3 selects | C; eq | private-token mode must be explicitly legacy-only or removed | I,C | B7 | pending |
| `lib/hubspot-sync.ts:136` token refresh | connections · update | C; eq | connection belongs to WS | M,O | B7 | pending |
| `lib/hubspot-sync.ts:171,183` sync | contacts upsert; connections upsert | C; set | composite conflicts for both | U,I | B7 | pending |
| `lib/hubspot-sync.ts:223,260` recommendation generation | contacts select; recommendations upsert | C; eq/set | contact natural ID same WS; composite conflict | I,U,C | B7 | pending |
| `lib/hubspot-sync.ts:274,291` recommendations/health | recommendations, contacts · 2 selects | C; eq | embedded contacts must join same WS | I,C | B7 | pending |
| `lib/hubspot-sync.ts:318,330,347` connection status writes | connection update; 2 upserts | C; eq/set | composite connection conflict | M,U | B7 | pending |

## Authorization and OAuth entry points without direct table calls

The following must change with their domain even though their database work is indirect: campaign-enrollments GET/POST, campaign-schedule GET/POST, email-drafts GET/POST, sending-settings GET/POST, workload-forecast GET, HubSpot connect/status/sync/recommendations routes, `lib/authorization.ts`, and `lib/hubspot-callback.ts`. Connect creates signed state from verified user/workspace plus a random nonce; callback re-authorizes, verifies the same user/workspace, atomically consumes the nonce, then persists tokens in that workspace. Login/logout/auth callback/proxy remain session concerns and must not accept workspace input.

## Safe batches and dependency order

1. **B1 shared context (complete locally):** `workspace-authorization.ts`, `workspace-runtime-context.ts`, all protected routes, callback authorization helper, route auth tests, and static inventory. Establish trusted `{user,workspaceId,role,source,supabaseAdmin}` at each protected entry point without applying workspace filters or claiming domain isolation.
2. **B2 dashboard/config:** dashboard and campaigns routes together; clients/events/campaigns/templates/steps isolation tests.
3. **B3 settings/limits:** `sending-settings.ts` and route plus schedule/forecast consumers of settings and domain limits.
4. **B4 enrollment:** `campaign-enrollment.ts`, route, Migration 013 caller/tests. Must land atomically with 012/013 deployment ordering.
5. **B5 scheduling/forecast:** `campaign-schedule.ts`, route, `workload-forecast.ts`, route, preparation/parity tests. All reads and persistence change together.
6. **B6 drafts:** `email-drafts.ts` and route after B5 scoped schedules exist.
7. **B7 HubSpot:** connect/callback/status/sync/recommendations routes; callback/state/token/sync helpers; OAuth and two-portal tests.
8. **B8 final audit:** remove `authorizeOwner` runtime use, audit every service-role call, hostile cross-tenant integration suite, and only then activate 012→013→runtime in isolated staging.

## Migration 014 foundation coverage

- Completed in the unapplied Migration 014: composite campaign-step, schedule, draft, and enrollment unique indexes matching future PostgREST conflict targets.
- Completed in unapplied migrations: Migration 013 now uses `(workspace_id,contact_id,campaign_id)` and 014 supplies that unique index.
- Completed in the unapplied Migration 014: the recommendation/contact composite FK is recreated under one explicit name; disposable PostgREST schema validation remains required.
- Completed in the unapplied Migration 014: digest-only OAuth nonce storage and a database-time, exact-once, service-role-only consume function.
- No missing base workspace indexes were found for ordinary `.eq(workspace_id, ...)` reads; 012 creates one per owned table.

Static matching does not prove tenant isolation. The guard locks the reviewed file set and exact counts for `.from(...)`, `.rpc(...)`, `getSupabaseAdmin`, `supabaseAdmin`, `authorizeOwner`, and `getWorkspaceRuntimeContext`; it also rejects straightforward privileged import aliasing and direct service-role client construction outside the reviewed factories. It only prevents that inventory from drifting unnoticed. B8 still requires semantic review and disposable-database integration tests.
