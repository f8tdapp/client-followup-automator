"use client";

import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Client = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  notes: string | null;
  tags: string[] | null;
  last_contacted_at: string | null;
  next_follow_up_at: string | null;
  opened_count: number | null;
  clicked_count: number | null;
  unsubscribed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type HubSpotConnectionStatus =
  | "connected"
  | "private_token"
  | "not_connected"
  | "needs_reconnect";

type HubSpotStatus = {
  status: HubSpotConnectionStatus;
  lastSyncAt: string | null;
  contactsSynced: number;
};

type HubSpotHealth = {
  totalSyncedContacts: number;
  safeToContact: number;
  unsubscribedExcluded: number;
  recentlyContactedExcluded: number;
};

type HubSpotRecommendationContact = {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  email: string | null;
  last_contacted_at: string | null;
  is_unsubscribed: boolean;
};

type DailyRecommendation = {
  id: string;
  hubspot_contact_id: string;
  recommended_action: string;
  reason: string;
  status: string;
  priority: number;
  hubspot_contacts: HubSpotRecommendationContact | null;
};

type DailySendScheduleRow = {
  id: string;
  scheduled_date: string;
  broker_domain: string;
  status: string;
  reason: string;
  safety_status: string;
  hubspot_contacts: {
    first_name: string | null;
    last_name: string | null;
    company: string | null;
    email: string | null;
  } | null;
  campaigns: {
    name: string;
  } | null;
  campaign_steps: {
    step_number: number;
  } | null;
};

type DailySendPlanSummary = {
  scheduledDate: string;
  totalScheduled: number;
  brokerDomainsProtected: number;
  skippedDueToDomainLimits: number;
  dueEmail1: number;
  dueEmail2: number;
  dueEmail3: number;
};

type DailySendPlanDiagnostics = {
  hasActiveCampaign: boolean;
  activeCampaignCount: number;
  eligibleContactCount: number;
  enrolledContactCount: number;
  hasCampaignSteps: boolean;
  campaignStepCount: number;
  suppressionRulesCount?: number;
  diagnosticsWarning?: string | null;
  reason: string | null;
};

type DailySendPlan = {
  summary: DailySendPlanSummary;
  diagnostics: DailySendPlanDiagnostics;
  schedule: DailySendScheduleRow[];
  ok?: boolean;
  message?: string;
} & DailySendPlanDiagnostics;

type Campaign = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  daily_limit: number;
  daily_send_limit: number | null;
  broker_domain_daily_limit: number | null;
  cooldown_days: number;
  stop_on_reply: boolean | null;
  stop_on_bounce: boolean | null;
  stop_on_unsubscribe: boolean | null;
  created_at: string | null;
  updated_at: string | null;
};

type CampaignStep = {
  id: string;
  campaign_id: string;
  step_number: number;
  delay_days: number;
  subject_template: string;
  body_template: string;
  status: string;
};

type EmailTemplate = {
  id: string;
  campaign_id: string | null;
  name: string;
  subject: string;
  body: string;
  created_at: string | null;
  updated_at: string | null;
};

type ClientEvent = {
  id: string;
  client_id: string | null;
  event_type: string;
  details: string | null;
  created_at: string | null;
};

type ClientForm = {
  first_name: string;
  last_name: string;
  company: string;
  email: string;
  phone: string;
  notes: string;
};

type CampaignForm = {
  name: string;
  description: string;
  daily_limit: string;
  cooldown_days: string;
};

type TemplateForm = {
  campaign_id: string;
  name: string;
  subject: string;
  body: string;
};

type CampaignStepForm = {
  subject_template: string;
  body_template: string;
};

type ClientInsert = {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  email: string;
  phone: string | null;
  notes: string | null;
};

type ImportSummary = {
  rowsProcessed: number;
  clientsImported: number;
  duplicatesSkipped: number;
  invalidRowsSkipped: number;
};

type RecommendedClient = {
  client: Client;
  score: number;
  reasons: string[];
};

type ContactTemperature = "Hot" | "Warm" | "Neutral" | "Cold" | "Unsubscribed";

type CsvColumn =
  | "first_name"
  | "last_name"
  | "company"
  | "email"
  | "phone"
  | "notes";

const emptyClientForm: ClientForm = {
  first_name: "",
  last_name: "",
  company: "",
  email: "",
  phone: "",
  notes: "",
};

const emptyCampaignForm: CampaignForm = {
  name: "",
  description: "",
  daily_limit: "10",
  cooldown_days: "30",
};

const emptyTemplateForm: TemplateForm = {
  campaign_id: "",
  name: "",
  subject: "",
  body: "",
};

const emptyImportSummary: ImportSummary = {
  rowsProcessed: 0,
  clientsImported: 0,
  duplicatesSkipped: 0,
  invalidRowsSkipped: 0,
};

const emptyDailySendPlan: DailySendPlan = {
  summary: {
    scheduledDate: new Date().toISOString().slice(0, 10),
    totalScheduled: 0,
    brokerDomainsProtected: 0,
    skippedDueToDomainLimits: 0,
    dueEmail1: 0,
    dueEmail2: 0,
    dueEmail3: 0,
  },
  diagnostics: {
    hasActiveCampaign: false,
    activeCampaignCount: 0,
    eligibleContactCount: 0,
    enrolledContactCount: 0,
    hasCampaignSteps: false,
    campaignStepCount: 0,
    reason: null,
  },
  hasActiveCampaign: false,
  activeCampaignCount: 0,
  eligibleContactCount: 0,
  enrolledContactCount: 0,
  hasCampaignSteps: false,
  campaignStepCount: 0,
  reason: null,
  schedule: [],
};

const campaignStatuses = [
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Paused", value: "paused" },
  { label: "Done", value: "completed" },
] as const;

async function getSupabase() {
  const { supabase } = await import("@/lib/supabase");

  return supabase;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeCsvHeader(header: string) {
  const normalizedHeader = header
    .trim()
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (normalizedHeader === "e_mail" || normalizedHeader === "email_address") {
    return "email";
  }

  return normalizedHeader;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function reportError(label: string, error: unknown) {
  console.error(label, error);
}

function normalizeNumber(value: string, fallback: number) {
  const parsedValue = Number.parseInt(value, 10);

  if (Number.isNaN(parsedValue) || parsedValue < 1) {
    return fallback;
  }

  return parsedValue;
}

function formatDate(value: string | null) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function getClientName(client: Client) {
  const fullName = [client.first_name, client.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fullName || "Unnamed contact";
}

function isWithinLastDays(value: string | null, days: number) {
  if (!value) {
    return false;
  }

  const contactedAt = new Date(value).getTime();

  if (Number.isNaN(contactedAt)) {
    return false;
  }

  const daysInMilliseconds = days * 24 * 60 * 60 * 1000;

  return Date.now() - contactedAt <= daysInMilliseconds;
}

function isOlderThanDays(value: string | null, days: number) {
  if (!value) {
    return false;
  }

  const dateValue = new Date(value).getTime();

  if (Number.isNaN(dateValue)) {
    return false;
  }

  const daysInMilliseconds = days * 24 * 60 * 60 * 1000;

  return Date.now() - dateValue > daysInMilliseconds;
}

function isUnsubscribed(client: Client) {
  return Boolean(
    client.unsubscribed_at || client.status?.toLowerCase() === "unsubscribed",
  );
}

function isActiveContact(client: Client) {
  return !isUnsubscribed(client) && client.status?.toLowerCase() !== "inactive";
}

function scoreClient(client: Client): RecommendedClient {
  let score = 0;
  const reasons: string[] = [];

  if ((client.clicked_count ?? 0) > 0) {
    score += 20;
    reasons.push("Clicked");
  }

  if ((client.opened_count ?? 0) > 0) {
    score += 10;
    reasons.push("Opened");
  }

  if (!client.last_contacted_at) {
    score += 10;
    reasons.push("Never contacted");
  }

  if (client.status?.toLowerCase() === "active") {
    score += 5;
    reasons.push("Active");
  }

  if (client.unsubscribed_at) {
    score -= 20;
    reasons.push("Unsubscribed");
  }

  if (isWithinLastDays(client.last_contacted_at, 30)) {
    score -= 10;
    reasons.push("Contacted recently");
  }

  if (reasons.length === 0) {
    reasons.push("Best available fit");
  }

  return { client, score, reasons };
}

function getContactTemperature(client: Client, score: number): ContactTemperature {
  if (isUnsubscribed(client)) {
    return "Unsubscribed";
  }

  if (score >= 30) {
    return "Hot";
  }

  if (score >= 15) {
    return "Warm";
  }

  if (score >= 5) {
    return "Neutral";
  }

  return "Cold";
}

function getTemperatureClasses(temperature: ContactTemperature) {
  if (temperature === "Hot") {
    return "bg-red-50 text-red-700 border-red-200";
  }

  if (temperature === "Warm") {
    return "bg-amber-50 text-amber-800 border-amber-200";
  }

  if (temperature === "Neutral") {
    return "bg-cyan-50 text-cyan-800 border-cyan-200";
  }

  if (temperature === "Unsubscribed") {
    return "bg-slate-100 text-slate-500 border-slate-200";
  }

  return "bg-blue-50 text-blue-800 border-blue-200";
}

function getOpportunityLabel(temperature: ContactTemperature) {
  if (temperature === "Hot") {
    return "Ready to call";
  }

  if (temperature === "Warm") {
    return "Warm";
  }

  if (temperature === "Neutral") {
    return "Keep warm";
  }

  if (temperature === "Unsubscribed") {
    return "Do not contact";
  }

  return "Quiet";
}

function getFriendlyQueueReason(
  client: Client,
  isDue: boolean,
  reasons: string[],
) {
  if (reasons.includes("Clicked") || reasons.includes("Opened")) {
    return "Recommended because they opened or clicked before.";
  }

  if (!client.last_contacted_at) {
    return "Recommended because they are due for a friendly check-in.";
  }

  if (isDue) {
    return "Recommended because they haven’t heard from you recently.";
  }

  return "Recommended because they are worth keeping warm.";
}

function getHubSpotStatusLabel(status: HubSpotConnectionStatus) {
  if (status === "private_token") {
    return "Connected via private token";
  }

  if (status === "connected") {
    return "Connected";
  }

  if (status === "needs_reconnect") {
    return "Needs reconnect";
  }

  return "Not connected";
}

function getRecommendationContactName(contact: HubSpotRecommendationContact) {
  const fullName = [contact.first_name, contact.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fullName || "Unnamed contact";
}

function getCampaignStatusLabel(status: string) {
  return (
    campaignStatuses.find((campaignStatus) => campaignStatus.value === status)
      ?.label ?? "Draft"
  );
}

function getCampaignPrimaryAction(status: string) {
  if (status === "paused") {
    return "Resume";
  }

  if (status === "draft") {
    return "Start";
  }

  return "Continue";
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let isQuoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"') {
      if (isQuoted && nextCharacter === '"') {
        field += '"';
        index += 1;
      } else {
        isQuoted = !isQuoted;
      }
    } else if (character === "," && !isQuoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !isQuoted) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }

      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field);
  rows.push(row);

  return rows.filter((csvRow) =>
    csvRow.some((csvField) => csvField.trim().length > 0),
  );
}

function getCsvValue(
  row: string[],
  headerIndexes: Map<string, number>,
  column: CsvColumn,
) {
  const columnIndex = headerIndexes.get(column);

  if (columnIndex === undefined) {
    return "";
  }

  return (row[columnIndex] ?? "").trim();
}

function buildClientsFromCsvRows(
  rows: string[][],
  existingEmails: Set<string>,
) {
  const summary = { ...emptyImportSummary };
  const inserts: ClientInsert[] = [];
  const csvEmails = new Set<string>();
  const [headerRow, ...dataRows] = rows;

  if (!headerRow) {
    return { inserts, summary };
  }

  const headerIndexes = new Map(
    headerRow.map((header, index) => [normalizeCsvHeader(header), index]),
  );

  for (const row of dataRows) {
    summary.rowsProcessed += 1;

    const email = getCsvValue(row, headerIndexes, "email").trim();
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail) {
      summary.invalidRowsSkipped += 1;
      continue;
    }

    if (existingEmails.has(normalizedEmail) || csvEmails.has(normalizedEmail)) {
      summary.duplicatesSkipped += 1;
      continue;
    }

    csvEmails.add(normalizedEmail);
    inserts.push({
      first_name: getCsvValue(row, headerIndexes, "first_name") || null,
      last_name: getCsvValue(row, headerIndexes, "last_name") || null,
      company: getCsvValue(row, headerIndexes, "company") || null,
      email,
      phone: getCsvValue(row, headerIndexes, "phone") || null,
      notes: getCsvValue(row, headerIndexes, "notes") || null,
    });
  }

  summary.clientsImported = inserts.length;

  return { inserts, summary };
}

export default function Dashboard() {
  const [clients, setClients] = useState<Client[]>([]);
  const [hubSpotStatus, setHubSpotStatus] = useState<HubSpotStatus>({
    status: "not_connected",
    lastSyncAt: null,
    contactsSynced: 0,
  });
  const [hubSpotHealth, setHubSpotHealth] = useState<HubSpotHealth>({
    totalSyncedContacts: 0,
    safeToContact: 0,
    unsubscribedExcluded: 0,
    recentlyContactedExcluded: 0,
  });
  const [dailyRecommendations, setDailyRecommendations] = useState<
    DailyRecommendation[]
  >([]);
  const [dailySendPlan, setDailySendPlan] =
    useState<DailySendPlan>(emptyDailySendPlan);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignSteps, setCampaignSteps] = useState<CampaignStep[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [clientEvents, setClientEvents] = useState<ClientEvent[]>([]);
  const [clientForm, setClientForm] = useState<ClientForm>(emptyClientForm);
  const [campaignForm, setCampaignForm] =
    useState<CampaignForm>(emptyCampaignForm);
  const [templateForm, setTemplateForm] =
    useState<TemplateForm>(emptyTemplateForm);
  const [selectedTimelineClientId, setSelectedTimelineClientId] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingClient, setIsSavingClient] = useState(false);
  const [isSavingCampaign, setIsSavingCampaign] = useState(false);
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isSyncingHubSpot, setIsSyncingHubSpot] = useState(false);
  const [isGeneratingSchedule, setIsGeneratingSchedule] = useState(false);
  const [isCreatingStarterCampaign, setIsCreatingStarterCampaign] =
    useState(false);
  const [isEnrollingContacts, setIsEnrollingContacts] = useState(false);
  const [isResettingStarterCopy, setIsResettingStarterCopy] = useState(false);
  const [editingCampaignStepId, setEditingCampaignStepId] = useState<
    string | null
  >(null);
  const [campaignStepForm, setCampaignStepForm] = useState<CampaignStepForm>({
    subject_template: "",
    body_template: "",
  });
  const [isSavingCampaignStep, setIsSavingCampaignStep] = useState(false);
  const [importSummary, setImportSummary] =
    useState<ImportSummary>(emptyImportSummary);
  const [openPanel, setOpenPanel] = useState<
    "client" | "csv" | "campaign" | "template" | null
  >(null);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [showDailyWorkflow, setShowDailyWorkflow] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [showCampaigns, setShowCampaigns] = useState(false);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(
    null,
  );
  const [expandedCampaignId, setExpandedCampaignId] = useState<string | null>(
    null,
  );
  const clientPanelRef = useRef<HTMLFormElement>(null);
  const csvPanelRef = useRef<HTMLDivElement>(null);
  const campaignPanelRef = useRef<HTMLFormElement>(null);
  const templatePanelRef = useRef<HTMLFormElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const sendPlanRef = useRef<HTMLElement>(null);
  const campaignPreviewRef = useRef<HTMLElement>(null);
  const contactsPreviewRef = useRef<HTMLDivElement>(null);
  const messagePlansRef = useRef<HTMLDivElement>(null);
  const clientFirstNameInputRef = useRef<HTMLInputElement>(null);
  const csvFileInputRef = useRef<HTMLInputElement>(null);
  const campaignNameInputRef = useRef<HTMLInputElement>(null);
  const templateCampaignSelectRef = useRef<HTMLSelectElement>(null);
  const templateNameInputRef = useRef<HTMLInputElement>(null);

  const timelineClient = useMemo(() => {
    if (!selectedTimelineClientId) {
      return null;
    }

    return clients.find((client) => client.id === selectedTimelineClientId) ?? null;
  }, [clients, selectedTimelineClientId]);

  const recommendedClients = useMemo(() => {
    return clients
      .filter(isActiveContact)
      .map(scoreClient)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
  }, [clients]);

  const followUpQueue = useMemo(() => {
    return clients
      .filter(isActiveContact)
      .map((client) => {
        const recommendation = scoreClient(client);
        const isDue =
          !client.last_contacted_at ||
          isOlderThanDays(client.last_contacted_at, 30);
        const temperature = getContactTemperature(
          client,
          recommendation.score,
        );
        const reasons = recommendation.reasons.filter(
          (reason) => reason !== "Unsubscribed",
        );

        return {
          client,
          isDue,
          reason: getFriendlyQueueReason(client, isDue, reasons),
          score: recommendation.score,
          temperature,
        };
      })
      .sort((left, right) => {
        if (left.isDue !== right.isDue) {
          return left.isDue ? -1 : 1;
        }

        return right.score - left.score;
      })
      .slice(0, 10);
  }, [clients]);

  const dashboardQueue = useMemo(() => {
    if (dailyRecommendations.length > 0) {
      return dailyRecommendations
        .filter((recommendation) => recommendation.hubspot_contacts)
        .map((recommendation) => {
          const contact = recommendation.hubspot_contacts!;

          return {
            id: recommendation.id,
            name: getRecommendationContactName(contact),
            company: contact.company || "No company",
            email: contact.email || "No email",
            label: "Ready to review",
            recommendedAction: recommendation.recommended_action,
            reason: recommendation.reason,
            status: recommendation.status,
            lastContactedAt: contact.last_contacted_at,
          };
        });
    }

    return followUpQueue.map(({ client, reason, temperature }) => ({
      id: client.id,
      name: getClientName(client),
      company: client.company || "No company",
      email: client.email || "No email",
      label: getOpportunityLabel(temperature),
      recommendedAction: "Send a friendly check-in",
      reason,
      status: "Preview",
      lastContactedAt: client.last_contacted_at,
    }));
  }, [dailyRecommendations, followUpQueue]);

  const clientScores = useMemo(() => {
    return new Map(
      clients.map((client) => {
        const recommendation = scoreClient(client);

        return [client.id, recommendation.score];
      }),
    );
  }, [clients]);

  const hasHubSpotHealth = hubSpotHealth.totalSyncedContacts > 0;
  const healthMetrics = {
    totalContacts: hasHubSpotHealth
      ? hubSpotHealth.totalSyncedContacts
      : clients.length,
    eligibleContacts: dailySendPlan.diagnostics.eligibleContactCount,
    enrolledContacts: dailySendPlan.diagnostics.enrolledContactCount,
    scheduledToday: dailySendPlan.summary.totalScheduled,
    protectedContacts:
      dailySendPlan.summary.skippedDueToDomainLimits +
      (dailySendPlan.diagnostics.suppressionRulesCount ?? 0),
  };
  const activeCampaign =
    campaigns.find((campaign) => campaign.status.toLowerCase() === "active") ??
    campaigns[0] ??
    null;
  const activeCampaignSteps = activeCampaign
    ? campaignSteps
        .filter((step) => step.campaign_id === activeCampaign.id)
        .sort((left, right) => left.step_number - right.step_number)
    : [];
  const hasStarterCampaign = dailySendPlan.diagnostics.activeCampaignCount > 0;
  const hasEnrolledContacts = dailySendPlan.diagnostics.enrolledContactCount > 0;
  const showLegacyPreview = false;
  const scheduledSendRows = dailySendPlan.schedule.filter(
    (scheduleRow) => scheduleRow.status === "scheduled",
  );
  const skippedSendRows = dailySendPlan.schedule.filter(
    (scheduleRow) => scheduleRow.status !== "scheduled",
  );
  const scheduleEmptyReason =
    dailySendPlan.diagnostics.reason ??
    "Generate today's plan after syncing HubSpot and activating a message plan.";

  const filteredClients = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) {
      return clients;
    }

    return clients.filter((client) => {
      const haystack = [
        client.first_name,
        client.last_name,
        client.company,
        client.email,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [clients, search]);

  async function loadClients() {
    setIsLoading(true);
    setError("");

    try {
      const supabase = await getSupabase();
      const { data, error: fetchError } = await supabase
        .from("clients")
        .select("*")
        .order("created_at", { ascending: false });

      if (fetchError) {
        setError(fetchError.message);
        setClients([]);
      } else {
        setClients(data ?? []);
      }
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Unable to load contacts.",
      );
      setClients([]);
    }

    setIsLoading(false);
  }

  async function loadHubSpotDashboardData() {
    try {
      const [statusResponse, recommendationsResponse, scheduleResponse] =
        await Promise.all([
        fetch("/api/hubspot/status"),
        fetch("/api/hubspot/recommendations"),
        fetch("/api/campaign-schedule"),
      ]);

      if (statusResponse.ok) {
        const statusBody = (await statusResponse.json()) as {
          connection: HubSpotStatus;
          health: HubSpotHealth;
        };

        setHubSpotStatus(statusBody.connection);
        setHubSpotHealth(statusBody.health);
      }

      if (recommendationsResponse.ok) {
        const recommendationsBody = (await recommendationsResponse.json()) as {
          recommendations: DailyRecommendation[];
        };

        setDailyRecommendations(recommendationsBody.recommendations);
      }

      if (scheduleResponse.ok) {
        const scheduleBody = (await scheduleResponse.json()) as DailySendPlan;

        setDailySendPlan(scheduleBody);
      }
    } catch (hubSpotError) {
      reportError("Unable to load HubSpot dashboard data", hubSpotError);
    }
  }

  function handleConnectHubSpot() {
    window.location.href = "/api/hubspot/connect";
  }

  async function handleHubSpotSync() {
    setError("");
    setMessage("");
    setIsSyncingHubSpot(true);

    try {
      const response = await fetch("/api/hubspot/sync", {
        method: "POST",
      });
      const body = (await response.json()) as {
        contactsSynced?: number;
        recommendationsCreated?: number;
        connection?: HubSpotStatus;
        health?: HubSpotHealth;
        recommendations?: DailyRecommendation[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(body.error || "Unable to sync HubSpot.");
      }

      if (body.connection) {
        setHubSpotStatus(body.connection);
      }

      if (body.health) {
        setHubSpotHealth(body.health);
      }

      if (body.recommendations) {
        setDailyRecommendations(body.recommendations);
      }

      setMessage(
        `HubSpot sync preview complete. Synced ${
          body.contactsSynced ?? 0
        } contacts and prepared ${body.recommendationsCreated ?? 0} recommendations.`,
      );
    } catch (syncError) {
      setError(getErrorMessage(syncError, "Unable to sync HubSpot."));
      await loadHubSpotDashboardData();
    }

    setIsSyncingHubSpot(false);
  }

  async function handleGenerateDailySchedule() {
    setError("");
    setMessage("");
    setIsGeneratingSchedule(true);

    try {
      const response = await fetch("/api/campaign-schedule", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "generate_today" }),
      });
      const body = (await response.json()) as DailySendPlan & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(body.error || "Unable to generate today's send plan.");
      }

      setDailySendPlan(body);
      setMessage(
        body.summary.totalScheduled > 0
          ? `Today's send plan is ready. ${body.summary.totalScheduled} contacts are scheduled for review.`
          : body.diagnostics.reason || "Today's send plan has no scheduled contacts yet.",
      );
    } catch (scheduleError) {
      setError(
        getErrorMessage(scheduleError, "Unable to generate today's send plan."),
      );
    }

    setIsGeneratingSchedule(false);
  }

  async function handleCampaignScheduleAction(
    action: "create_starter_campaign" | "enroll_eligible_contacts",
  ) {
    setError("");
    setMessage("");

    if (action === "create_starter_campaign") {
      setIsCreatingStarterCampaign(true);
    } else {
      setIsEnrollingContacts(true);
    }

    try {
      const response = await fetch("/api/campaign-schedule", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      const body = (await response.json()) as DailySendPlan & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(body.error || "Unable to update campaign schedule setup.");
      }

      setDailySendPlan(body);
      setMessage(
        action === "create_starter_campaign"
          ? body.message ||
              "Starter campaign is active with Email 1, Email 2, and Email 3."
          : `${body.diagnostics.enrolledContactCount} contacts are enrolled in active campaigns.`,
      );
      await loadCampaignsAndTemplates();
    } catch (scheduleError) {
      setError(
        getErrorMessage(scheduleError, "Unable to update campaign schedule setup."),
      );
    }

    if (action === "create_starter_campaign") {
      setIsCreatingStarterCampaign(false);
    } else {
      setIsEnrollingContacts(false);
    }
  }

  async function handleResetStarterCampaignCopy() {
    setError("");
    setMessage("");
    setIsResettingStarterCopy(true);

    try {
      const response = await fetch("/api/campaign-schedule", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "reset_starter_campaign_copy" }),
      });
      const body = (await response.json()) as DailySendPlan & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(body.error || "Unable to reset starter message copy.");
      }

      setDailySendPlan(body);
      setMessage("Starter message copy reset. Nothing was sent.");
      await loadCampaignsAndTemplates();
    } catch (resetError) {
      setError(
        getErrorMessage(resetError, "Unable to reset starter message copy."),
      );
    }

    setIsResettingStarterCopy(false);
  }

  async function loadCampaignsAndTemplates() {
    try {
      const supabase = await getSupabase();
      const [
        { data: campaignData, error: campaignError },
        { data: templateData, error: templateError },
        { data: stepData, error: stepError },
      ] = await Promise.all([
        supabase.from("campaigns").select("*").order("created_at", {
          ascending: false,
        }),
        supabase.from("email_templates").select("*").order("created_at", {
          ascending: false,
        }),
        supabase
          .from("campaign_steps")
          .select("*")
          .order("step_number", { ascending: true }),
      ]);

      if (campaignError) {
        throw new Error(campaignError.message);
      }

      if (templateError) {
        throw new Error(templateError.message);
      }

      if (stepError) {
        throw new Error(stepError.message);
      }

      setCampaigns(campaignData ?? []);
      setCampaignSteps(stepData ?? []);
      setEmailTemplates(templateData ?? []);
      setTemplateForm((current) => {
        if (current.campaign_id || !campaignData?.[0]) {
          return current;
        }

        return { ...current, campaign_id: campaignData[0].id };
      });
    } catch (campaignError) {
      setError(
        campaignError instanceof Error
          ? campaignError.message
          : "Unable to load message plans.",
      );
    }
  }

  async function loadTimeline(clientId: string) {
    if (!clientId) {
      setClientEvents([]);
      return;
    }

    try {
      const supabase = await getSupabase();
      const { data, error: timelineError } = await supabase
        .from("client_events")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (timelineError) {
        throw new Error(timelineError.message);
      }

      setClientEvents(data ?? []);
    } catch (timelineError) {
      setClientEvents([]);
      setError(
        timelineError instanceof Error
          ? timelineError.message
          : "Unable to load contact timeline.",
      );
    }
  }

  useEffect(() => {
    let isActive = true;

    window.setTimeout(() => {
      void loadHubSpotDashboardData();
    }, 0);

    getSupabase()
      .then((supabase) =>
        Promise.all([
          supabase.from("clients").select("*").order("created_at", {
            ascending: false,
          }),
          supabase.from("campaigns").select("*").order("created_at", {
            ascending: false,
          }),
          supabase.from("email_templates").select("*").order("created_at", {
            ascending: false,
          }),
          supabase
            .from("campaign_steps")
            .select("*")
            .order("step_number", { ascending: true }),
        ]),
      )
      .then(([clientsResult, campaignsResult, templatesResult, stepsResult]) => {
        if (!isActive) {
          return;
        }

        if (clientsResult.error) {
          throw new Error(clientsResult.error.message);
        }

        setClients(clientsResult.data ?? []);

        if (campaignsResult.error) {
          setError(campaignsResult.error.message);
        } else {
          setCampaigns(campaignsResult.data ?? []);
          setTemplateForm((current) => {
            if (current.campaign_id || !campaignsResult.data?.[0]) {
              return current;
            }

            return { ...current, campaign_id: campaignsResult.data[0].id };
          });
        }

        if (templatesResult.error) {
          setError(templatesResult.error.message);
        } else {
          setEmailTemplates(templatesResult.data ?? []);
        }

        if (stepsResult.error) {
          setError(stepsResult.error.message);
        } else {
          setCampaignSteps(stepsResult.data ?? []);
        }

        setIsLoading(false);
      })
      .catch((loadError) => {
        if (!isActive) {
          return;
        }

        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load dashboard data.",
        );
        setClients([]);
        setCampaigns([]);
        setCampaignSteps([]);
        setEmailTemplates([]);
        setIsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;

    if (!timelineClient?.id) {
      return () => {
        isActive = false;
      };
    }

    getSupabase()
      .then((supabase) =>
        supabase
          .from("client_events")
          .select("*")
          .eq("client_id", timelineClient.id)
          .order("created_at", { ascending: false })
          .limit(20),
      )
      .then(({ data, error: timelineError }) => {
        if (!isActive) {
          return;
        }

        if (timelineError) {
          setError(timelineError.message);
          setClientEvents([]);
        } else {
          setClientEvents(data ?? []);
        }
      })
      .catch((timelineError) => {
        if (!isActive) {
          return;
        }

        setError(
          timelineError instanceof Error
            ? timelineError.message
            : "Unable to load contact timeline.",
        );
        setClientEvents([]);
      });

    return () => {
      isActive = false;
    };
  }, [timelineClient?.id]);

  async function handleClientSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");

    const trimmedEmail = clientForm.email.trim();

    if (!trimmedEmail) {
      setError("Email is required to add a contact.");
      return;
    }

    setIsSavingClient(true);

    try {
      const supabase = await getSupabase();
      const { data, error: insertError } = await supabase
        .from("clients")
        .insert({
          first_name: clientForm.first_name.trim() || null,
          last_name: clientForm.last_name.trim() || null,
          company: clientForm.company.trim() || null,
          email: trimmedEmail,
          phone: clientForm.phone.trim() || null,
          notes: clientForm.notes.trim() || null,
        })
        .select("id")
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      if (data?.id) {
        const { error: eventError } = await supabase
          .from("client_events")
          .insert({
            client_id: data.id,
            event_type: "manual_add",
            details: "Contact manually added as a backup option.",
          });

        if (eventError) {
          throw new Error(eventError.message);
        }

        setSelectedTimelineClientId(data.id);
      }

      setMessage("Backup contact added.");
      setClientForm(emptyClientForm);
      await loadClients();
      if (data?.id) {
        await loadTimeline(data.id);
      }
    } catch (insertError) {
      reportError("Unable to add contact", insertError);
      setError(getErrorMessage(insertError, "Unable to add contact."));
    }

    setIsSavingClient(false);
  }

  async function handleCsvImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setMessage("");
    setError("");
    setImportSummary(emptyImportSummary);
    setIsImporting(true);

    try {
      if (!file.name.toLowerCase().endsWith(".csv")) {
        throw new Error("Please upload a .csv file.");
      }

      const csvText = await file.text();
      const csvRows = parseCsv(csvText);

      if (csvRows.length < 2) {
        throw new Error("CSV must include a header row and at least one row.");
      }

      const supabase = await getSupabase();
      const { data: existingClients, error: existingClientsError } =
        await supabase.from("clients").select("email");

      if (existingClientsError) {
        throw new Error(existingClientsError.message);
      }

      const existingEmails = new Set(
        (existingClients ?? [])
          .map((client) => normalizeEmail(client.email ?? ""))
          .filter(Boolean),
      );
      const { inserts, summary } = buildClientsFromCsvRows(
        csvRows,
        existingEmails,
      );

      if (inserts.length > 0) {
        const { data: insertedClients, error: insertError } = await supabase
          .from("clients")
          .insert(inserts)
          .select("id,email");

        if (insertError) {
          throw new Error(insertError.message);
        }

        const eventRows = (insertedClients ?? []).map((client) => ({
          client_id: client.id,
          event_type: "csv_import",
          details: `Imported from ${file.name}.`,
        }));

        if (eventRows.length > 0) {
          const { error: eventError } = await supabase
            .from("client_events")
            .insert(eventRows);

          if (eventError) {
            throw new Error(eventError.message);
          }
        }
      }

      setImportSummary(summary);
      setMessage(
        `CSV import complete. Imported ${summary.clientsImported} contact${
          summary.clientsImported === 1 ? "" : "s"
        }.`,
      );
      await loadClients();
      if (timelineClient?.id) {
        await loadTimeline(timelineClient.id);
      }
    } catch (importError) {
      reportError("Unable to import CSV", importError);
      setError(getErrorMessage(importError, "Unable to import CSV."));
    }

    setIsImporting(false);
    event.target.value = "";
  }

  async function handleCampaignSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    setIsSavingCampaign(true);

    try {
      const supabase = await getSupabase();
      const campaignPayload = {
        name: campaignForm.name.trim(),
        description: campaignForm.description.trim() || null,
        daily_limit: normalizeNumber(campaignForm.daily_limit, 10),
        cooldown_days: normalizeNumber(campaignForm.cooldown_days, 30),
        updated_at: new Date().toISOString(),
      };
      const campaignRequest = editingCampaignId
        ? supabase
            .from("campaigns")
            .update(campaignPayload)
            .eq("id", editingCampaignId)
            .select("*")
            .single()
        : supabase
            .from("campaigns")
            .insert(campaignPayload)
            .select("*")
            .single();
      const { data, error: campaignError } = await campaignRequest;

      if (campaignError) {
        throw new Error(campaignError.message);
      }

      setMessage(
        editingCampaignId ? "Message plan updated." : "Message plan created.",
      );
      setCampaignForm(emptyCampaignForm);
      setEditingCampaignId(null);
      if (data?.id) {
        setTemplateForm((current) => ({ ...current, campaign_id: data.id }));
        setExpandedCampaignId(data.id);
      }
      await loadCampaignsAndTemplates();
    } catch (campaignError) {
      setError(
        campaignError instanceof Error
          ? campaignError.message
          : "Unable to save message plan.",
      );
    }

    setIsSavingCampaign(false);
  }

  async function handleCampaignStatusChange(campaign: Campaign, status: string) {
    setMessage("");
    setError("");

    try {
      const supabase = await getSupabase();
      const { error: statusError } = await supabase
        .from("campaigns")
        .update({
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaign.id);

      if (statusError) {
        throw new Error(statusError.message);
      }

      setMessage(`Message plan marked ${status}.`);
      await loadCampaignsAndTemplates();
    } catch (statusError) {
      setError(
        statusError instanceof Error
          ? statusError.message
          : "Unable to update message plan status.",
      );
    }
  }

  async function handleToggleCampaignStatus(campaign: Campaign) {
    const nextStatus =
      campaign.status.toLowerCase() === "active" ? "paused" : "active";

    await handleCampaignStatusChange(campaign, nextStatus);
  }

  function handleEditCampaign(campaign: Campaign) {
    setEditingCampaignId(campaign.id);
    setCampaignForm({
      name: campaign.name,
      description: campaign.description ?? "",
      daily_limit: String(campaign.daily_limit),
      cooldown_days: String(campaign.cooldown_days),
    });
    openActionPanel("campaign");
  }

  function handleNewCampaign() {
    setEditingCampaignId(null);
    setCampaignForm(emptyCampaignForm);
    setShowCampaigns(true);
    openActionPanel("campaign");
  }

  async function handleDeleteCampaign(campaign: Campaign) {
    const shouldDelete = window.confirm(
      `Delete "${campaign.name}" and its email messages? This cannot be undone.`,
    );

    if (!shouldDelete) {
      return;
    }

    setMessage("");
    setError("");

    try {
      const supabase = await getSupabase();
      const { error: deleteError } = await supabase
        .from("campaigns")
        .delete()
        .eq("id", campaign.id);

      if (deleteError) {
        throw new Error(deleteError.message);
      }

      if (editingCampaignId === campaign.id) {
        setEditingCampaignId(null);
        setCampaignForm(emptyCampaignForm);
      }

      if (expandedCampaignId === campaign.id) {
        setExpandedCampaignId(null);
      }

      setMessage("Message plan deleted.");
      await loadCampaignsAndTemplates();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete message plan.",
      );
    }
  }

  async function handleTemplateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    setIsSavingTemplate(true);

    try {
      if (!templateForm.campaign_id) {
        throw new Error(
          "Create or select a message plan before adding an email message.",
        );
      }

      const supabase = await getSupabase();
      const { error: templateError } = await supabase
        .from("email_templates")
        .insert({
          campaign_id: templateForm.campaign_id,
          name: templateForm.name.trim(),
          subject: templateForm.subject.trim(),
          body: templateForm.body.trim(),
        });

      if (templateError) {
        throw new Error(templateError.message);
      }

      setMessage("Email message created.");
      setTemplateForm((current) => ({
        ...emptyTemplateForm,
        campaign_id: current.campaign_id,
      }));
      await loadCampaignsAndTemplates();
    } catch (templateError) {
      setError(
        templateError instanceof Error
          ? templateError.message
          : "Unable to create email message.",
      );
    }

    setIsSavingTemplate(false);
  }

  function handleEditCampaignStep(step: CampaignStep) {
    setEditingCampaignStepId(step.id);
    setCampaignStepForm({
      subject_template: step.subject_template,
      body_template: step.body_template,
    });
  }

  async function handleSaveCampaignStep(step: CampaignStep) {
    setError("");
    setMessage("");
    setIsSavingCampaignStep(true);

    try {
      const supabase = await getSupabase();
      const { error: stepError } = await supabase
        .from("campaign_steps")
        .update({
          subject_template: campaignStepForm.subject_template.trim(),
          body_template: campaignStepForm.body_template.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", step.id);

      if (stepError) {
        throw new Error(stepError.message);
      }

      setMessage(`Email ${step.step_number} saved. Nothing was sent.`);
      setEditingCampaignStepId(null);
      await loadCampaignsAndTemplates();
    } catch (stepError) {
      setError(getErrorMessage(stepError, "Unable to save campaign step."));
    }

    setIsSavingCampaignStep(false);
  }

  function handleRunTodaysMarketing() {
    setError("");
    setShowDailyWorkflow(true);
    setMessage("Today's send plan is ready for review. Nothing sends automatically.");
  }

  function handleHubSpotSyncPreview() {
    setError("");
    setShowDailyWorkflow(false);
    if (
      hubSpotStatus.status === "connected" ||
      hubSpotStatus.status === "private_token"
    ) {
      setMessage("HubSpot is connected. Use Sync HubSpot to refresh contacts.");
      return;
    }

    setMessage("Connect HubSpot to enable read-only contact sync.");
  }

  function handleReviewComplete() {
    setError("");
    setMessage(
      "Review marked complete. Email sending is not connected yet.",
    );
  }

  function handleGenerateDraftsPreview() {
    setError("");
    setMessage(
      "Draft generation is the next phase. No drafts were generated and nothing was sent.",
    );
  }

  function scrollToElement(ref: { current: HTMLElement | null }) {
    window.setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  function openContactsPreview() {
    setShowContacts(true);
    scrollToElement(contactsPreviewRef);
  }

  function handleSidebarNav(item: string) {
    if (item === "Home") {
      scrollToElement(heroRef);
      return;
    }

    if (item === "Today's Send Plan") {
      scrollToElement(sendPlanRef);
      return;
    }

    if (item === "Campaigns") {
      scrollToElement(campaignPreviewRef);
      return;
    }

    if (item === "Contacts") {
      openContactsPreview();
      return;
    }

    if (item === "HubSpot Sync" || item === "Settings") {
      handleHubSpotSyncPreview();
      scrollToElement(heroRef);
      return;
    }

    setShowMoreActions((current) => !current);
  }

  function openActionPanel(panel: "client" | "csv" | "campaign" | "template") {
    if (panel === "campaign" || panel === "template") {
      setShowCampaigns(true);
    }

    setOpenPanel(panel);

    window.setTimeout(() => {
      const panelRefs = {
        client: clientPanelRef,
        csv: csvPanelRef,
        campaign: campaignPanelRef,
        template: templatePanelRef,
      };
      const focusTargets = {
        client: clientFirstNameInputRef.current,
        csv: csvFileInputRef.current,
        campaign: campaignNameInputRef.current,
        template:
          templateForm.campaign_id || campaigns.length === 0
            ? templateNameInputRef.current
            : templateCampaignSelectRef.current,
      };

      panelRefs[panel].current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      focusTargets[panel]?.focus({ preventScroll: true });
    }, 0);
  }

  return (
    <main className="min-h-screen bg-[#dfe8f3] text-slate-950">
      <div className="mx-auto flex w-full max-w-[104rem] flex-col gap-6 p-4 sm:p-6 xl:flex-row xl:p-8">
        <aside className="flex shrink-0 flex-col justify-between rounded-2xl bg-[#071b33] p-5 text-white shadow-[0_24px_70px_rgba(7,27,51,0.28)] xl:min-h-[calc(100vh-4rem)] xl:w-72">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex size-12 items-center justify-center rounded-xl bg-emerald-400 text-base font-bold text-[#071b33]">
                MA
              </div>
              <div>
                <p className="text-sm font-semibold text-white">
                  Marketing Assistant AI
                </p>
                <p className="mt-0.5 text-xs text-cyan-100/70">
                  HubSpot-first daily workflow
                </p>
              </div>
            </div>

            <nav className="mt-8 grid gap-2 text-sm font-medium">
              {[
                "Home",
                "Today's Send Plan",
                "Campaigns",
                "Contacts",
                "Settings",
              ].map((item, index) => (
                <button
                  className={`rounded-xl px-3 py-2.5 text-left transition ${
                    index === 0
                      ? "bg-white text-[#071b33] shadow-sm hover:bg-cyan-50"
                      : "text-cyan-50/80 hover:bg-white/10 hover:text-white"
                  }`}
                  key={item}
                  onClick={() => handleSidebarNav(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
              <button
                className={`rounded-xl px-3 py-2.5 text-left transition ${
                  showMoreActions
                    ? "bg-white/15 text-white"
                    : "text-cyan-50/80 hover:bg-white/10 hover:text-white"
                }`}
                onClick={() => setShowMoreActions((current) => !current)}
                type="button"
              >
                Developer / Manual Tools
              </button>
              {showMoreActions && (
                <div className="ml-2 grid gap-1 border-l border-white/10 pl-3">
                  <button
                    className="rounded-lg px-3 py-2 text-left text-cyan-50/80 transition hover:bg-white/10 hover:text-white"
                    onClick={() => openActionPanel("client")}
                    type="button"
                  >
                    Add Contact
                  </button>
                  <button
                    className="rounded-lg px-3 py-2 text-left text-cyan-50/80 transition hover:bg-white/10 hover:text-white"
                    onClick={() => openActionPanel("csv")}
                    type="button"
                  >
                    Import CSV
                  </button>
                  <button
                    className="rounded-lg px-3 py-2 text-left text-cyan-50/80 transition hover:bg-white/10 hover:text-white"
                    onClick={handleNewCampaign}
                    type="button"
                  >
                    New Campaign
                  </button>
                  <button
                    className="rounded-lg px-3 py-2 text-left text-cyan-50/80 transition hover:bg-white/10 hover:text-white"
                    onClick={() => openActionPanel("template")}
                    type="button"
                  >
                    New Email Message
                  </button>
                  <button
                    className="rounded-lg px-3 py-2 text-left text-cyan-50/80 transition hover:bg-white/10 hover:text-white"
                    onClick={handleHubSpotSyncPreview}
                    type="button"
                  >
                    HubSpot Sync
                  </button>
                </div>
              )}
            </nav>
          </div>

          <div className="mt-8 rounded-2xl border border-white/10 bg-white/10 p-4 text-sm leading-6 text-cyan-50">
            <p className="font-semibold text-white">Tip</p>
            <p className="mt-1 text-cyan-50/80">
              Work top to bottom: sync HubSpot, confirm the campaign, generate
              today&apos;s plan, then review.
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-8">
        <header className="flex flex-col justify-between gap-4 border-b border-slate-300/70 pb-6 lg:flex-row lg:items-end">
          <div>
            <h1 className="text-3xl font-semibold text-slate-950">
              Marketing Assistant AI
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              HubSpot stays the source of truth. This assistant builds a
              domain-safe daily outreach schedule for review.
            </p>
          </div>
        </header>

        {(message || error) && (
          <div
            className={`rounded-md border px-4 py-3 text-sm ${
              error
                ? "border-red-200 bg-red-50 text-red-800"
                : "border-emerald-200 bg-emerald-50 text-emerald-800"
            }`}
          >
            {error || message}
          </div>
        )}

        <section
          className="scroll-mt-6 overflow-hidden rounded-3xl border border-white/10 bg-[linear-gradient(135deg,#071b33_0%,#0b2a52_48%,#0f766e_100%)] p-7 text-white shadow-[0_30px_90px_rgba(7,27,51,0.34)] sm:p-8"
          ref={heroRef}
        >
          <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-3xl">
              <div className="mb-6 flex size-16 items-center justify-center rounded-2xl border border-white/15 bg-white/10 text-2xl font-semibold shadow-inner">
                MA
              </div>
              <p className="text-sm font-medium uppercase tracking-wide text-cyan-200">
                Morning Briefing
              </p>
              <h2 className="mt-3 text-3xl font-semibold leading-10 text-white sm:text-4xl sm:leading-[3rem]">
                Good morning. Your HubSpot database has been checked.
                Today&apos;s send plan is ready for review.
              </h2>
              <p className="mt-4 max-w-2xl text-base leading-7 text-cyan-50/85">
                {dailySendPlan.summary.totalScheduled} contacts scheduled
                today. Broker domains are protected. Nothing sends
                automatically.
              </p>
              <p className="mt-3 text-sm text-cyan-100/80">
                HubSpot status: {getHubSpotStatusLabel(hubSpotStatus.status)}.
                {hubSpotStatus.lastSyncAt
                  ? ` Last sync: ${formatDateTime(hubSpotStatus.lastSyncAt)}.`
                  : " Last sync unavailable."}
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4 shadow-2xl shadow-slate-950/20 backdrop-blur">
              <button
                className="h-16 w-full rounded-xl bg-emerald-400 px-10 text-lg font-bold text-[#071b33] shadow-lg shadow-emerald-950/20 transition hover:bg-emerald-300 lg:w-auto"
                onClick={handleRunTodaysMarketing}
                type="button"
              >
                Review Today
              </button>
              <p className="mt-3 max-w-52 text-sm leading-5 text-cyan-50/75">
                Opens the workflow for today&apos;s domain-safe send plan.
              </p>
              <div className="mt-4 border-t border-white/10 pt-4">
                {hubSpotStatus.status === "private_token" ? (
                  <div className="mb-3 flex h-12 w-full items-center justify-center rounded-xl border border-emerald-200/40 bg-emerald-300/15 px-6 text-sm font-bold text-emerald-100">
                    Private token connected
                  </div>
                ) : hubSpotStatus.status !== "connected" ? (
                  <button
                    className="mb-3 h-12 w-full rounded-xl border border-white/20 bg-white/10 px-6 text-sm font-bold text-white transition hover:bg-white/20"
                    onClick={handleConnectHubSpot}
                    type="button"
                  >
                    Connect HubSpot
                  </button>
                ) : null}
                <button
                  className="h-12 w-full rounded-xl bg-blue-500 px-6 text-sm font-bold text-white shadow-lg shadow-blue-950/20 transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-300"
                  disabled={isSyncingHubSpot}
                  onClick={handleHubSpotSync}
                  type="button"
                >
                  {isSyncingHubSpot ? "Syncing..." : "Sync HubSpot"}
                </button>
                <p className="mt-2 max-w-56 text-sm leading-5 text-cyan-50/75">
                  Pull the latest contacts and activity from HubSpot.
                </p>
                <p className="mt-2 text-xs font-medium text-cyan-100/70">
                  {hubSpotStatus.status === "connected" ||
                  hubSpotStatus.status === "private_token"
                    ? "HubSpot sync preview ready."
                    : "Connect HubSpot to enable read-only sync."}
                </p>
              </div>
            </div>
          </div>
          {false && showDailyWorkflow && (
            <div className="mt-6 rounded-2xl border border-cyan-200/20 bg-white/10 p-4 text-sm font-medium text-cyan-50">
              <div>✓ HubSpot synced</div>
              <div>✓ Unsubscribes checked</div>
              <div>✓ Follow-up queue prepared</div>
              <div>✓ Health Check refreshed</div>
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-white bg-white p-6 shadow-[0_24px_70px_rgba(15,23,42,0.12)]">
          <div className="mb-4">
            <p className="text-sm font-medium uppercase tracking-wide text-cyan-700">
              Marketing Health Check
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              A quick read on your contact list.
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-2xl border border-teal-100 bg-teal-50 p-5 shadow-sm">
              <p className="text-sm text-slate-500">Synced contacts</p>
              <p className="mt-3 text-4xl font-semibold text-slate-950">
                {healthMetrics.totalContacts}
              </p>
            </div>
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-5 shadow-sm">
              <p className="text-sm text-slate-500">Eligible contacts</p>
              <p className="mt-3 text-4xl font-semibold text-slate-950">
                {healthMetrics.eligibleContacts}
              </p>
            </div>
            <div className="rounded-2xl border border-amber-100 bg-amber-50 p-5 shadow-sm">
              <p className="text-sm text-slate-500">Enrolled contacts</p>
              <p className="mt-3 text-4xl font-semibold text-slate-950">
                {healthMetrics.enrolledContacts}
              </p>
            </div>
            <div className="rounded-2xl border border-blue-100 bg-blue-50 p-5 shadow-sm">
              <p className="text-sm text-slate-500">Scheduled today</p>
              <p className="mt-3 text-4xl font-semibold text-slate-950">
                {healthMetrics.scheduledToday}
              </p>
            </div>
            <div className="rounded-2xl border border-rose-100 bg-rose-50 p-5 shadow-sm">
              <p className="text-sm text-slate-500">Protected / excluded</p>
              <p className="mt-3 text-4xl font-semibold text-slate-950">
                {healthMetrics.protectedContacts}
              </p>
            </div>
          </div>
        </section>

        <section
          className="scroll-mt-6 rounded-3xl border border-cyan-100 bg-white p-6 shadow-[0_24px_70px_rgba(15,23,42,0.10)]"
          ref={sendPlanRef}
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-medium uppercase tracking-wide text-cyan-700">
                Campaign Schedule
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">
                Today&apos;s Send Plan
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
                Today&apos;s list is ready for review. Nothing sends
                automatically.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              {hasStarterCampaign ? (
                <div className="flex h-11 items-center rounded-xl border border-emerald-200 bg-emerald-50 px-4 text-sm font-bold text-emerald-800">
                  Starter campaign ready
                </div>
              ) : (
                <button
                  className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-800 shadow-sm transition hover:border-cyan-600 hover:text-cyan-700 disabled:cursor-not-allowed disabled:text-slate-400"
                  disabled={isCreatingStarterCampaign}
                  onClick={() =>
                    void handleCampaignScheduleAction("create_starter_campaign")
                  }
                  type="button"
                >
                  {isCreatingStarterCampaign
                    ? "Creating..."
                    : "Create Starter Campaign"}
                </button>
              )}
              {hasEnrolledContacts ? (
                <div className="flex h-11 items-center rounded-xl border border-blue-200 bg-blue-50 px-4 text-sm font-bold text-blue-800">
                  {dailySendPlan.diagnostics.enrolledContactCount} contacts enrolled
                </div>
              ) : (
                <button
                  className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-800 shadow-sm transition hover:border-cyan-600 hover:text-cyan-700 disabled:cursor-not-allowed disabled:text-slate-400"
                  disabled={isEnrollingContacts}
                  onClick={() =>
                    void handleCampaignScheduleAction("enroll_eligible_contacts")
                  }
                  type="button"
                >
                  {isEnrollingContacts ? "Enrolling..." : "Enroll Eligible Contacts"}
                </button>
              )}
              <button
                className="h-11 rounded-xl bg-[#071b33] px-5 text-sm font-bold text-white shadow-sm transition hover:bg-[#0b2a52] disabled:cursor-not-allowed disabled:bg-slate-400"
                disabled={isGeneratingSchedule}
                onClick={handleGenerateDailySchedule}
                type="button"
              >
                {isGeneratingSchedule ? "Generating..." : "Generate Today"}
              </button>
              <button
                className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 shadow-sm transition hover:border-cyan-600 hover:text-cyan-700 disabled:cursor-not-allowed disabled:text-slate-400"
                disabled={dailySendPlan.summary.totalScheduled === 0}
                onClick={handleGenerateDraftsPreview}
                type="button"
              >
                Generate Today&apos;s Drafts
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <div className="rounded-2xl border border-cyan-100 bg-cyan-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-700">
                Scheduled
              </p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">
                {dailySendPlan.summary.totalScheduled}
              </p>
            </div>
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                Domains protected
              </p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">
                {dailySendPlan.summary.brokerDomainsProtected}
              </p>
            </div>
            <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                Domain skips
              </p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">
                {dailySendPlan.summary.skippedDueToDomainLimits}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Email 1
              </p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">
                {dailySendPlan.summary.dueEmail1}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Email 2
              </p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">
                {dailySendPlan.summary.dueEmail2}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Email 3
              </p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">
                {dailySendPlan.summary.dueEmail3}
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 text-sm md:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <span className="font-semibold text-slate-950">
                Active campaigns
              </span>
              <p className="mt-1 text-slate-600">
                {dailySendPlan.diagnostics.activeCampaignCount}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <span className="font-semibold text-slate-950">
                Eligible contacts
              </span>
              <p className="mt-1 text-slate-600">
                {dailySendPlan.diagnostics.eligibleContactCount}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <span className="font-semibold text-slate-950">
                Enrolled contacts
              </span>
              <p className="mt-1 text-slate-600">
                {dailySendPlan.diagnostics.enrolledContactCount}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <span className="font-semibold text-slate-950">
                Campaign steps
              </span>
              <p className="mt-1 text-slate-600">
                {dailySendPlan.diagnostics.campaignStepCount}
              </p>
            </div>
          </div>

          {dailySendPlan.summary.totalScheduled === 0 && (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
              {scheduleEmptyReason}
            </div>
          )}

          <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-sm font-semibold text-slate-950">
                Contacts ready for review
              </p>
            </div>
            <div className="divide-y divide-slate-100">
              {scheduledSendRows.length > 0 ? (
                scheduledSendRows.map((scheduleRow) => {
                  const contact = scheduleRow.hubspot_contacts;
                  const contactName =
                    [contact?.first_name, contact?.last_name]
                      .filter(Boolean)
                      .join(" ")
                      .trim() || "Unnamed contact";

                  return (
                    <div
                      className="grid gap-3 px-4 py-4 text-sm md:grid-cols-[1.2fr_1fr_0.8fr_1fr]"
                      key={scheduleRow.id}
                    >
                      <div>
                        <p className="font-semibold text-slate-950">
                          {contactName}
                        </p>
                        <p className="mt-1 text-slate-500">
                          {contact?.email || "No email"}
                        </p>
                        <p className="mt-1 text-slate-500">
                          {contact?.company || "No company"}
                        </p>
                      </div>
                      <div>
                        <p className="font-medium text-slate-950">
                          {scheduleRow.campaigns?.name || "Campaign"}
                        </p>
                        <p className="mt-1 text-slate-500">
                          Email {scheduleRow.campaign_steps?.step_number ?? 1}
                        </p>
                      </div>
                      <div>
                        <p className="font-medium text-slate-950">
                          {scheduleRow.broker_domain}
                        </p>
                        <p className="mt-1 text-slate-500">
                          {scheduleRow.safety_status}
                        </p>
                      </div>
                      <p className="text-slate-600">{scheduleRow.reason}</p>
                    </div>
                  );
                })
              ) : (
                <div className="px-4 py-5 text-sm text-slate-500">
                  {scheduleEmptyReason}
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="grid gap-3 text-sm md:grid-cols-5">
              <div className="rounded-xl border border-cyan-100 bg-white p-4">
                <p className="font-semibold text-slate-950">
                  1. Generate Today&apos;s Send Plan
                </p>
                <p className="mt-1 text-slate-600">
                  Builds the domain-safe list from enrolled contacts.
                </p>
              </div>
              <div className="rounded-xl border border-cyan-100 bg-white p-4">
                <p className="font-semibold text-slate-950">
                  2. Generate Today&apos;s Drafts
                </p>
                <p className="mt-1 text-slate-600">
                  Coming next. Drafts will use the campaign message steps.
                </p>
              </div>
              <div className="rounded-xl border border-cyan-100 bg-white p-4">
                <p className="font-semibold text-slate-950">
                  3. Review drafts
                </p>
                <p className="mt-1 text-slate-600">
                  Read every draft before anything is approved.
                </p>
              </div>
              <div className="rounded-xl border border-cyan-100 bg-white p-4">
                <p className="font-semibold text-slate-950">
                  4. Edit / approve / skip
                </p>
                <p className="mt-1 text-slate-600">
                  The user stays in control of each contact.
                </p>
              </div>
              <div className="rounded-xl border border-amber-100 bg-amber-50 p-4">
                <p className="font-semibold text-amber-950">
                  Later: send approved emails
                </p>
                <p className="mt-1 text-amber-800">
                  Sending is not connected in this phase.
                </p>
              </div>
            </div>
          </div>

          {skippedSendRows.length > 0 && (
            <div className="mt-4 rounded-2xl border border-amber-100 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">
                Protected contacts rolled forward
              </p>
              <div className="mt-3 grid gap-2 text-sm text-amber-900 lg:grid-cols-2">
                {skippedSendRows.slice(0, 6).map((scheduleRow) => {
                  const contact = scheduleRow.hubspot_contacts;
                  const contactName =
                    [contact?.first_name, contact?.last_name]
                      .filter(Boolean)
                      .join(" ")
                      .trim() ||
                    contact?.email ||
                    "Unnamed contact";

                  return (
                    <div
                      className="rounded-xl border border-amber-100 bg-white/70 p-3"
                      key={scheduleRow.id}
                    >
                      <span className="font-medium">{contactName}</span>
                      <span className="text-amber-700">
                        {" "}
                        - {scheduleRow.reason}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <section
          className="scroll-mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_24px_70px_rgba(15,23,42,0.08)]"
          ref={campaignPreviewRef}
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-medium uppercase tracking-wide text-cyan-700">
                Campaign Preview
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">
                Message Steps
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
                These are the messages that will eventually be used for this
                campaign. Nothing sends automatically.
              </p>
            </div>
            <button
              className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-800 shadow-sm transition hover:border-cyan-600 hover:text-cyan-700 disabled:cursor-not-allowed disabled:text-slate-400"
              disabled={isResettingStarterCopy || !activeCampaign}
              onClick={() => void handleResetStarterCampaignCopy()}
              type="button"
            >
              {isResettingStarterCopy
                ? "Resetting..."
                : "Reset starter message copy"}
            </button>
            {activeCampaign && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 lg:min-w-80">
                <p className="font-semibold text-slate-950">
                  {activeCampaign.name}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Daily limit
                    </p>
                    <p className="mt-1">
                      {activeCampaign.daily_send_limit ??
                        activeCampaign.daily_limit}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Domain limit
                    </p>
                    <p className="mt-1">
                      {activeCampaign.broker_domain_daily_limit ?? 3}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Cooldown
                    </p>
                    <p className="mt-1">{activeCampaign.cooldown_days} days</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Stops
                    </p>
                    <p className="mt-1">
                      {[
                        activeCampaign.stop_on_reply !== false ? "reply" : null,
                        activeCampaign.stop_on_bounce !== false ? "bounce" : null,
                        activeCampaign.stop_on_unsubscribe !== false
                          ? "unsubscribe"
                          : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            {activeCampaignSteps.length > 0 ? (
              activeCampaignSteps.map((step) => {
                const isEditing = editingCampaignStepId === step.id;

                return (
                  <div
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                    key={step.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">
                          Email {step.step_number}
                        </p>
                        <p className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                          Delay: {step.delay_days} days
                        </p>
                      </div>
                      <button
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-cyan-600 hover:text-cyan-700"
                        onClick={() =>
                          isEditing
                            ? setEditingCampaignStepId(null)
                            : handleEditCampaignStep(step)
                        }
                        type="button"
                      >
                        {isEditing ? "Cancel" : "Edit"}
                      </button>
                    </div>

                    {isEditing ? (
                      <div className="mt-4 flex flex-col gap-3">
                        <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                          Subject
                          <input
                            className="h-10 rounded-xl border border-slate-300 bg-white px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                            onChange={(event) =>
                              setCampaignStepForm((current) => ({
                                ...current,
                                subject_template: event.target.value,
                              }))
                            }
                            value={campaignStepForm.subject_template}
                          />
                        </label>
                        <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                          Body
                          <textarea
                            className="min-h-64 resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 font-normal leading-6 outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                            onChange={(event) =>
                              setCampaignStepForm((current) => ({
                                ...current,
                                body_template: event.target.value,
                              }))
                            }
                            value={campaignStepForm.body_template}
                          />
                        </label>
                        <button
                          className="h-10 rounded-xl bg-[#071b33] px-4 text-sm font-bold text-white transition hover:bg-[#0b2a52] disabled:cursor-not-allowed disabled:bg-slate-400"
                          disabled={isSavingCampaignStep}
                          onClick={() => void handleSaveCampaignStep(step)}
                          type="button"
                        >
                          {isSavingCampaignStep ? "Saving..." : "Save step"}
                        </button>
                      </div>
                    ) : (
                      <div className="mt-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Subject
                        </p>
                        <p className="mt-1 font-semibold text-slate-950">
                          {step.subject_template || "No subject yet"}
                        </p>
                        <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Body
                        </p>
                        <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-700">
                          {step.body_template || "No body copy yet"}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900 lg:col-span-3">
                Create the starter campaign to preview Email 1, Email 2, and
                Email 3.
              </div>
            )}
          </div>
        </section>

        <section className="rounded-3xl border border-violet-100 bg-violet-50/70 p-6 shadow-[0_24px_70px_rgba(76,29,149,0.10)]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">
                What to do next
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Follow the workflow from HubSpot sync to a reviewed draft path.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-6">
            <div className="rounded-2xl border border-white bg-white p-5 text-sm text-slate-700 shadow-sm">
              <span className="font-semibold text-slate-950">
                1. Sync HubSpot
              </span>
              <p className="mt-1">
                {hubSpotStatus.lastSyncAt
                  ? `Last sync: ${formatDateTime(hubSpotStatus.lastSyncAt)}.`
                  : "Refresh HubSpot before planning today."}
              </p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-5 text-sm text-slate-700 shadow-sm">
              <span className="font-semibold text-slate-950">
                2. Confirm campaign
              </span>
              <p className="mt-1">
                {hasStarterCampaign
                  ? "Starter campaign and message steps are ready."
                  : "Create the starter campaign before enrolling contacts."}
              </p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-5 text-sm text-slate-700 shadow-sm">
              <span className="font-semibold text-slate-950">
                3. Enroll contacts
              </span>
              <p className="mt-1">
                {hasEnrolledContacts
                  ? `${dailySendPlan.diagnostics.enrolledContactCount} contacts are enrolled.`
                  : "Enroll eligible HubSpot contacts into the campaign."}
              </p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-5 text-sm text-slate-700 shadow-sm">
              <span className="font-semibold text-slate-950">
                4. Generate send plan
              </span>
              <p className="mt-1">
                {dailySendPlan.summary.totalScheduled > 0
                  ? `${dailySendPlan.summary.totalScheduled} contacts are scheduled for review.`
                  : "Generate today's plan when setup is ready."}
              </p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-5 text-sm text-slate-700 shadow-sm">
              <span className="font-semibold text-slate-950">
                5. Generate drafts
              </span>
              <p className="mt-1">
                Next phase: create draft emails from the approved message steps.
              </p>
            </div>
            <div className="rounded-2xl border border-white bg-white p-5 text-sm text-slate-700 shadow-sm">
              <span className="font-semibold text-slate-950">
                6. Review / approve / skip
              </span>
              <p className="mt-1">
                Sending stays off until a later approved-email phase.
              </p>
            </div>
          </div>
        </section>

        {showLegacyPreview && (
        <>
        <section className="rounded-3xl border border-emerald-200 bg-emerald-50/80 shadow-[0_24px_70px_rgba(16,185,129,0.16)]">
          <div className="flex flex-col gap-2 border-b border-emerald-100 bg-emerald-100/70 p-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium uppercase tracking-wide text-cyan-700">
                Who should I contact today?
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">
                Today&apos;s Best Opportunities
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Start with the contacts most likely to appreciate a friendly
                check-in.
              </p>
            </div>
            <span className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-emerald-900 shadow-sm">
              Top {recommendedClients.length}
            </span>
          </div>
          <div className="grid gap-5 p-6 xl:grid-cols-2">
            {recommendedClients.length > 0 ? (
              recommendedClients.map(({ client, score, reasons }) => {
                const temperature = getContactTemperature(client, score);

                return (
                  <div
                    className="rounded-2xl border border-emerald-100 bg-white p-6 text-left shadow-sm transition hover:border-emerald-300 hover:shadow-md"
                    key={client.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${getTemperatureClasses(
                              temperature,
                            )}`}
                          >
                            {getOpportunityLabel(temperature)}
                          </span>
                        </div>
                        <p className="mt-4 font-semibold text-slate-950">
                          {getClientName(client)}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {client.company || "No company"} |{" "}
                          {client.email || "No email"}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col gap-2">
                        <button
                          className="rounded-xl bg-[#071b33] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b2a52]"
                          onClick={() => setSelectedTimelineClientId(client.id)}
                          type="button"
                        >
                          View Contact
                        </button>
                        <button
                          className="rounded-xl border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-800 transition hover:border-emerald-400 hover:bg-emerald-50"
                          onClick={() => {
                            setError("");
                            setMessage(
                              "This contact is already considered in today's queue preview.",
                            );
                          }}
                          type="button"
                        >
                          Add to Queue
                        </button>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {reasons.map((reason) => (
                        <span
                          className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700"
                          key={reason}
                        >
                          {reason}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="p-4 text-sm text-slate-500">
                Add or import contacts to generate recommendations.
              </p>
            )}
          </div>
        </section>

        <section className="rounded-3xl border border-blue-100 bg-white shadow-[0_24px_70px_rgba(37,99,235,0.12)]">
          <div className="flex flex-col gap-3 border-b border-blue-100 bg-blue-50 p-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium uppercase tracking-wide text-cyan-700">
                Preview only
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">
                Today&apos;s Follow-Up Queue
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Review the people this assistant would prepare for outreach.
                Nothing sends yet. You&apos;ll review everything before email
                sending is connected.
              </p>
            </div>
            <button
              className="h-12 rounded-xl bg-blue-700 px-6 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-800"
              onClick={handleReviewComplete}
              type="button"
            >
              Review Complete
            </button>
          </div>
          <div>
            <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_220px_180px] gap-4 border-b border-slate-100 bg-white px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 lg:grid">
              <div>Contact</div>
              <div>Email</div>
              <div>Reason</div>
              <div>Last contacted</div>
            </div>
            {dashboardQueue.length > 0 ? (
              dashboardQueue.map((item) => (
                  <div
                    className="grid w-full gap-4 border-b border-slate-100 p-5 text-left transition last:border-b-0 hover:bg-blue-50/70 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_220px_180px]"
                    key={item.id}
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-800"
                        >
                          {item.label}
                        </span>
                      </div>
                      <p className="mt-2 font-semibold text-slate-950">
                        {item.name}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        {item.company}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Email
                      </p>
                      <p className="mt-1 text-sm text-slate-700">
                        {item.email}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {item.recommendedAction}
                      </p>
                      <p className="mt-1 text-sm text-slate-700">{item.reason}</p>
                      <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Status: {item.status}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Last contacted
                      </p>
                      <p className="mt-1 text-sm text-slate-700">
                        {formatDate(item.lastContactedAt)}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          className="rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-800"
                          onClick={() =>
                            setMessage(
                              "Approval is saved for review only. Email sending is not connected yet.",
                            )
                          }
                          type="button"
                        >
                          Mark Reviewed
                        </button>
                        <button
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-blue-300 hover:text-blue-700"
                          onClick={() =>
                            setMessage(
                              "Skip is a placeholder for this read-only phase.",
                            )
                          }
                          type="button"
                        >
                          Skip
                        </button>
                        <button
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-blue-300 hover:text-blue-700"
                          onClick={() =>
                            setMessage(
                              "Snooze is a placeholder for this read-only phase.",
                            )
                          }
                          type="button"
                        >
                          Snooze
                        </button>
                      </div>
                    </div>
                  </div>
                ))
            ) : (
              <p className="p-5 text-sm text-slate-500">
                Sync HubSpot or use backup import tools to preview a follow-up
                queue.
              </p>
            )}
          </div>
        </section>
        </>
        )}

        <section className="flex flex-col gap-4 rounded-lg border border-slate-200/80 bg-white/60 p-4 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="h-10 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-cyan-600 hover:text-cyan-700"
              onClick={() => setShowContacts((current) => !current)}
              type="button"
            >
              {showContacts ? "Hide Contacts Preview" : "View Contacts Preview"}
            </button>
            <button
              className="h-10 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-cyan-600 hover:text-cyan-700"
              onClick={() => setShowCampaigns((current) => !current)}
              type="button"
            >
              {showCampaigns
                ? "Hide Message Plans"
                : "Manage Message Plans"}
            </button>
          </div>

          {(showContacts ||
            showCampaigns ||
            openPanel === "client" ||
            openPanel === "csv" ||
            timelineClient) && (
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
              <div className="flex min-w-0 flex-col gap-6">
                {showContacts && (
            <div
              className="scroll-mt-6 rounded-lg border border-white bg-white shadow-[0_18px_50px_rgba(15,23,42,0.08)]"
              ref={contactsPreviewRef}
            >
              <div className="flex flex-col gap-4 border-b border-slate-200 bg-slate-50 p-5 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">
                    HubSpot Contact Preview
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Contacts come from HubSpot. Search the local preview and
                    open a timeline when needed.
                  </p>
                </div>
                <label className="w-full lg:max-w-md">
                  <span className="sr-only">Search contacts</span>
                  <input
                    className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search name, company, or email"
                    type="search"
                  />
                </label>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] border-collapse text-left text-sm">
                  <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Name</th>
                      <th className="px-4 py-3 font-semibold">Company</th>
                      <th className="px-4 py-3 font-semibold">Email</th>
                      <th className="px-4 py-3 font-semibold">Temperature</th>
                      <th className="px-4 py-3 font-semibold">Signal</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold">Last contacted</th>
                      <th className="px-4 py-3 font-semibold">Opens</th>
                      <th className="px-4 py-3 font-semibold">Clicks</th>
                      <th className="px-4 py-3 font-semibold">Timeline</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {isLoading ? (
                      <tr>
                        <td
                          className="px-4 py-8 text-center text-slate-500"
                          colSpan={10}
                        >
                          Loading contacts...
                        </td>
                      </tr>
                    ) : filteredClients.length > 0 ? (
                      filteredClients.map((client) => {
                        const score = clientScores.get(client.id) ?? 0;
                        const temperature = getContactTemperature(client, score);

                        return (
                          <tr
                            className="transition hover:bg-slate-50"
                            key={client.id}
                          >
                            <td className="px-4 py-3 font-medium text-slate-950">
                              {getClientName(client)}
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {client.company || "-"}
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {client.email || "-"}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${getTemperatureClasses(
                                  temperature,
                                )}`}
                              >
                                {temperature}
                              </span>
                            </td>
                            <td className="px-4 py-3 font-semibold text-slate-950">
                              {getOpportunityLabel(temperature)}
                            </td>
                            <td className="px-4 py-3">
                              <span className="inline-flex rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                                {client.status || "New"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {formatDate(client.last_contacted_at)}
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {client.opened_count ?? 0}
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {client.clicked_count ?? 0}
                            </td>
                            <td className="px-4 py-3">
                              <button
                                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:border-cyan-600 hover:text-cyan-700"
                                onClick={() =>
                                  setSelectedTimelineClientId(client.id)
                                }
                                type="button"
                              >
                                View
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td
                          className="px-4 py-8 text-center text-slate-500"
                          colSpan={10}
                        >
                          No contacts found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
                )}

                {showCampaigns && (
            <div
              className="scroll-mt-6 rounded-lg border border-white bg-white shadow-[0_18px_50px_rgba(15,23,42,0.08)]"
              ref={messagePlansRef}
            >
              <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">
                    Message Plans and Email Messages
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Draft calm follow-up plans without sending email yet.
                  </p>
                </div>
              </div>

              {(openPanel === "campaign" || openPanel === "template") && (
              <div className="grid gap-6 border-b border-slate-200 bg-slate-50 p-4 lg:grid-cols-2">
                {openPanel === "campaign" && (
                <form
                  className="flex flex-col gap-4 scroll-mt-6"
                  onSubmit={handleCampaignSubmit}
                  ref={campaignPanelRef}
                >
                  <h3 className="text-sm font-semibold text-slate-950">
                    {editingCampaignId
                      ? "Edit message plan"
                      : "Create message plan"}
                  </h3>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                    Name
                    <input
                      className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                      onChange={(event) =>
                        setCampaignForm((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      ref={campaignNameInputRef}
                      required
                      value={campaignForm.name}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                    Description
                    <textarea
                      className="min-h-24 resize-y rounded-md border border-slate-300 px-3 py-2 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                      onChange={(event) =>
                        setCampaignForm((current) => ({
                          ...current,
                          description: event.target.value,
                        }))
                      }
                      value={campaignForm.description}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                      Daily limit
                      <input
                        className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                        min={1}
                        onChange={(event) =>
                          setCampaignForm((current) => ({
                            ...current,
                            daily_limit: event.target.value,
                          }))
                        }
                        type="number"
                        value={campaignForm.daily_limit}
                      />
                    </label>
                    <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                      Cooldown days
                      <input
                        className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                        min={1}
                        onChange={(event) =>
                          setCampaignForm((current) => ({
                            ...current,
                            cooldown_days: event.target.value,
                          }))
                        }
                        type="number"
                        value={campaignForm.cooldown_days}
                      />
                    </label>
                  </div>
                  <button
                    className="h-10 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                    disabled={isSavingCampaign}
                    type="submit"
                  >
                    {isSavingCampaign
                      ? "Saving..."
                      : editingCampaignId
                        ? "Save message plan"
                        : "Create message plan"}
                  </button>
                </form>
                )}

                {openPanel === "template" && (
                <form
                  className="flex flex-col gap-4 scroll-mt-6"
                  onSubmit={handleTemplateSubmit}
                  ref={templatePanelRef}
                >
                  <h3 className="text-sm font-semibold text-slate-950">
                    Create email message
                  </h3>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                    Message plan
                    <select
                      className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                      onChange={(event) =>
                        setTemplateForm((current) => ({
                          ...current,
                          campaign_id: event.target.value,
                        }))
                      }
                      ref={templateCampaignSelectRef}
                      value={templateForm.campaign_id}
                    >
                      <option value="">Select message plan</option>
                      {campaigns.map((campaign) => (
                        <option key={campaign.id} value={campaign.id}>
                          {campaign.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                    Message name
                    <input
                      className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                      onChange={(event) =>
                        setTemplateForm((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      ref={templateNameInputRef}
                      required
                      value={templateForm.name}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                    Subject
                    <input
                      className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                      onChange={(event) =>
                        setTemplateForm((current) => ({
                          ...current,
                          subject: event.target.value,
                        }))
                      }
                      required
                      value={templateForm.subject}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                    Body
                    <textarea
                      className="min-h-24 resize-y rounded-md border border-slate-300 px-3 py-2 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                      onChange={(event) =>
                        setTemplateForm((current) => ({
                          ...current,
                          body: event.target.value,
                        }))
                      }
                      required
                      value={templateForm.body}
                    />
                  </label>
                  <button
                    className="h-10 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                    disabled={isSavingTemplate}
                    type="submit"
                  >
                    {isSavingTemplate ? "Creating..." : "Create email message"}
                  </button>
                </form>
                )}
              </div>
              )}

              <div className="grid gap-3 border-t border-slate-200 p-4 lg:grid-cols-2">
                {campaigns.length > 0 ? (
                  campaigns.map((campaign) => {
                    const templatesForCampaign = emailTemplates.filter(
                      (template) => template.campaign_id === campaign.id,
                    );
                    const campaignStatus = campaign.status.toLowerCase();
                    const isExpanded = expandedCampaignId === campaign.id;
                    const primaryAction =
                      getCampaignPrimaryAction(campaignStatus);

                    return (
                      <div
                        className="rounded-md border border-slate-200 p-4"
                        key={campaign.id}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold text-slate-950">
                              {campaign.name}
                            </p>
                            <p className="mt-1 text-sm text-slate-500">
                              This message plan helps you stay in touch with
                              contacts without overwhelming them.
                            </p>
                          </div>
                          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                            {getCampaignStatusLabel(campaignStatus)}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                          <span>{campaign.daily_limit}/day</span>
                          <span>{campaign.cooldown_days} day cooldown</span>
                          <span>
                            {templatesForCampaign.length} email messages
                          </span>
                        </div>
                        <div className="mt-4">
                          <button
                            className="h-10 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
                            onClick={() =>
                              setExpandedCampaignId((current) =>
                                current === campaign.id ? null : campaign.id,
                              )
                            }
                            type="button"
                          >
                            {isExpanded ? "Close" : primaryAction}
                          </button>
                        </div>
                        {isExpanded && (
                          <div className="mt-4 rounded-md bg-slate-50 p-4 text-sm text-slate-700">
                            <div className="grid gap-3 sm:grid-cols-2">
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                  Description
                                </p>
                                <p className="mt-1">
                                  {campaign.description || "No description"}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                  Created
                                </p>
                                <p className="mt-1">
                                  {formatDateTime(campaign.created_at)}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                  Daily limit
                                </p>
                                <p className="mt-1">{campaign.daily_limit}</p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                  Cooldown
                                </p>
                                <p className="mt-1">
                                  {campaign.cooldown_days} days
                                </p>
                              </div>
                            </div>
                            <div className="mt-4">
                              <label className="flex max-w-xs flex-col gap-1.5 text-sm font-medium text-slate-700">
                                Status
                                <select
                                  className="h-10 rounded-md border border-slate-300 bg-white px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                                  onChange={(event) =>
                                    void handleCampaignStatusChange(
                                      campaign,
                                      event.target.value,
                                    )
                                  }
                                  value={campaignStatus}
                                >
                                  {campaignStatuses.map((status) => (
                                    <option
                                      key={status.value}
                                      value={status.value}
                                    >
                                      {status.label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            <div className="mt-4">
                              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                Email messages
                              </p>
                              <div className="mt-2 flex flex-col gap-2">
                                {templatesForCampaign.length > 0 ? (
                                  templatesForCampaign.map((template) => (
                                    <div
                                      className="rounded-md border border-slate-200 bg-white p-3"
                                      key={template.id}
                                    >
                                      <p className="font-semibold text-slate-950">
                                        {template.name}
                                      </p>
                                      <p className="mt-1 text-slate-600">
                                        {template.subject}
                                      </p>
                                    </div>
                                  ))
                                ) : (
                                  <p>No email messages yet.</p>
                                )}
                              </div>
                            </div>
                            <div className="mt-4 flex flex-wrap gap-3 border-t border-slate-200 pt-4">
                              <button
                                className="text-sm font-medium text-slate-600 transition hover:text-cyan-700"
                                onClick={() => handleEditCampaign(campaign)}
                                type="button"
                              >
                                Edit
                              </button>
                              <button
                                className="text-sm font-medium text-slate-600 transition hover:text-cyan-700"
                                onClick={() =>
                                  void handleToggleCampaignStatus(campaign)
                                }
                                type="button"
                              >
                                {campaignStatus === "active"
                                  ? "Pause"
                                  : "Resume"}
                              </button>
                              <button
                                className="text-sm font-medium text-red-600 transition hover:text-red-700"
                                onClick={() =>
                                  void handleDeleteCampaign(campaign)
                                }
                                type="button"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <p className="text-sm text-slate-500">
                    Create a message plan to start drafting email messages.
                  </p>
                )}
              </div>
            </div>
                )}
          </div>

          {(openPanel === "client" || openPanel === "csv" || timelineClient) && (
          <aside className="flex flex-col gap-6">
            {(openPanel === "client" || openPanel === "csv") && (
            <div className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-950">
                    Backup Import Tools
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Use these only if a contact is not already in HubSpot.
                  </p>
                </div>
              </div>

              {openPanel === "client" && (
              <form
                className="mt-5 flex flex-col gap-4 border-t border-slate-200 pt-5 scroll-mt-6"
                onSubmit={handleClientSubmit}
                ref={clientPanelRef}
              >
                  <h3 className="text-sm font-semibold text-slate-950">
                  Add backup contact
                </h3>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                    First name
                    <input
                      className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                    onChange={(event) =>
                      setClientForm((current) => ({
                        ...current,
                        first_name: event.target.value,
                      }))
                    }
                    ref={clientFirstNameInputRef}
                    value={clientForm.first_name}
                  />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                    Last name
                    <input
                      className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                      onChange={(event) =>
                        setClientForm((current) => ({
                          ...current,
                          last_name: event.target.value,
                        }))
                      }
                      value={clientForm.last_name}
                    />
                  </label>
                </div>

                <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                  Company
                  <input
                    className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                    onChange={(event) =>
                      setClientForm((current) => ({
                        ...current,
                        company: event.target.value,
                      }))
                    }
                    value={clientForm.company}
                  />
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                  Email
                  <input
                    className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                    onChange={(event) =>
                      setClientForm((current) => ({
                        ...current,
                        email: event.target.value,
                      }))
                    }
                    required
                    type="email"
                    value={clientForm.email}
                  />
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                  Phone
                  <input
                    className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                    onChange={(event) =>
                      setClientForm((current) => ({
                        ...current,
                        phone: event.target.value,
                      }))
                    }
                    type="tel"
                    value={clientForm.phone}
                  />
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                  Notes
                  <textarea
                    className="min-h-28 resize-y rounded-md border border-slate-300 px-3 py-2 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                    onChange={(event) =>
                      setClientForm((current) => ({
                        ...current,
                        notes: event.target.value,
                      }))
                    }
                    value={clientForm.notes}
                  />
                </label>

                <button
                  className="h-10 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                  disabled={isSavingClient}
                  type="submit"
                >
                  {isSavingClient ? "Adding..." : "Add backup contact"}
                </button>
              </form>
              )}

              {openPanel === "csv" && (
              <div
                className="mt-6 border-t border-slate-200 pt-5 scroll-mt-6"
                ref={csvPanelRef}
              >
                <h2 className="text-base font-semibold text-slate-950">
                  Import CSV
                </h2>
                <div className="mt-4 flex flex-col gap-3">
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                    CSV file
                    <input
                      accept=".csv,text/csv"
                      className="block w-full rounded-md border border-slate-300 text-sm font-normal text-slate-700 file:mr-3 file:h-10 file:border-0 file:bg-slate-100 file:px-3 file:text-sm file:font-semibold file:text-slate-700 hover:file:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isImporting}
                      onChange={handleCsvImport}
                      ref={csvFileInputRef}
                      type="file"
                    />
                  </label>
                  <p className="text-xs leading-5 text-slate-500">
                    Expected headers: first_name, last_name, company, email,
                    phone, notes. Email also accepts e-mail, Email Address, and
                    email_address.
                  </p>

                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-md bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Rows processed</p>
                      <p className="mt-1 font-semibold text-slate-950">
                        {importSummary.rowsProcessed}
                      </p>
                    </div>
                    <div className="rounded-md bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Imported</p>
                      <p className="mt-1 font-semibold text-slate-950">
                        {importSummary.clientsImported}
                      </p>
                    </div>
                    <div className="rounded-md bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">
                        Duplicates skipped
                      </p>
                      <p className="mt-1 font-semibold text-slate-950">
                        {importSummary.duplicatesSkipped}
                      </p>
                    </div>
                    <div className="rounded-md bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Invalid skipped</p>
                      <p className="mt-1 font-semibold text-slate-950">
                        {importSummary.invalidRowsSkipped}
                      </p>
                    </div>
                  </div>

                  {isImporting && (
                    <p className="text-sm font-medium text-cyan-700">
                      Importing contacts...
                    </p>
                  )}
                </div>
              </div>
              )}
              {openPanel !== "client" && openPanel !== "csv" && (
                <p className="mt-4 rounded-md bg-slate-50 p-4 text-sm text-slate-600">
                  Use More Actions when you need to add a contact manually or
                  import a CSV. Use these only if a contact is not already in
                  HubSpot.
                </p>
              )}
            </div>
            )}

            {timelineClient && (
            <div className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-950">
                    Contact timeline
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {timelineClient
                      ? getClientName(timelineClient)
                      : "Select a contact"}
                  </p>
                </div>
                {timelineClient && (
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                    {clientEvents.length} events
                  </span>
                )}
              </div>

              <div className="mt-4 flex flex-col gap-3">
                {clientEvents.length > 0 ? (
                  clientEvents.map((event) => (
                    <div
                      className="border-l-2 border-cyan-600 pl-3"
                      key={event.id}
                    >
                      <p className="text-sm font-semibold text-slate-950">
                        {event.event_type}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {formatDateTime(event.created_at)}
                      </p>
                      {event.details && (
                        <p className="mt-1 text-sm text-slate-600">
                          {event.details}
                        </p>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-500">
                    No timeline events for this contact yet.
                  </p>
                )}
              </div>
            </div>
            )}
          </aside>
          )}
            </div>
          )}
        </section>
        </div>
      </div>
    </main>
  );
}
