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

type Campaign = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  daily_limit: number;
  cooldown_days: number;
  created_at: string | null;
  updated_at: string | null;
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

  return fullName || "Unnamed client";
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
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
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
  const [importSummary, setImportSummary] =
    useState<ImportSummary>(emptyImportSummary);
  const [openPanel, setOpenPanel] = useState<
    "client" | "csv" | "campaign" | "template" | null
  >(null);
  const clientPanelRef = useRef<HTMLFormElement>(null);
  const csvPanelRef = useRef<HTMLDivElement>(null);
  const campaignPanelRef = useRef<HTMLFormElement>(null);
  const templatePanelRef = useRef<HTMLFormElement>(null);
  const clientFirstNameInputRef = useRef<HTMLInputElement>(null);
  const csvFileInputRef = useRef<HTMLInputElement>(null);
  const campaignNameInputRef = useRef<HTMLInputElement>(null);
  const templateCampaignSelectRef = useRef<HTMLSelectElement>(null);
  const templateNameInputRef = useRef<HTMLInputElement>(null);

  const timelineClient = useMemo(() => {
    return (
      clients.find((client) => client.id === selectedTimelineClientId) ??
      clients[0] ??
      null
    );
  }, [clients, selectedTimelineClientId]);

  const recommendedClients = useMemo(() => {
    return clients
      .map(scoreClient)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
  }, [clients]);

  const clientScores = useMemo(() => {
    return new Map(
      clients.map((client) => {
        const recommendation = scoreClient(client);

        return [client.id, recommendation.score];
      }),
    );
  }, [clients]);

  const marketingHealth = useMemo(() => {
    const activeClients = clients.filter(isActiveContact);
    const healthyContacts = activeClients.filter(
      (client) =>
        !client.last_contacted_at ||
        isWithinLastDays(client.last_contacted_at, 30),
    );
    const dueForFollowUp = activeClients.filter(
      (client) =>
        !client.last_contacted_at || isOlderThanDays(client.last_contacted_at, 30),
    );
    const coldContacts = activeClients.filter((client) =>
      isOlderThanDays(client.last_contacted_at, 90),
    );
    const unsubscribedContacts = clients.filter(isUnsubscribed);
    const warmLeads = activeClients.filter(
      (client) => (client.opened_count ?? 0) > 0 || (client.clicked_count ?? 0) > 0,
    );

    return {
      healthyContacts,
      dueForFollowUp,
      coldContacts,
      unsubscribedContacts,
      warmLeads,
    };
  }, [clients]);

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
          : "Unable to load clients.",
      );
      setClients([]);
    }

    setIsLoading(false);
  }

  async function loadCampaignsAndTemplates() {
    try {
      const supabase = await getSupabase();
      const [
        { data: campaignData, error: campaignError },
        { data: templateData, error: templateError },
      ] = await Promise.all([
        supabase.from("campaigns").select("*").order("created_at", {
          ascending: false,
        }),
        supabase.from("email_templates").select("*").order("created_at", {
          ascending: false,
        }),
      ]);

      if (campaignError) {
        throw new Error(campaignError.message);
      }

      if (templateError) {
        throw new Error(templateError.message);
      }

      setCampaigns(campaignData ?? []);
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
          : "Unable to load campaigns.",
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
          : "Unable to load client timeline.",
      );
    }
  }

  useEffect(() => {
    let isActive = true;

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
        ]),
      )
      .then(([clientsResult, campaignsResult, templatesResult]) => {
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
            : "Unable to load client timeline.",
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
      setError("Email is required to add a client.");
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
            details: "Client manually added from dashboard.",
          });

        if (eventError) {
          throw new Error(eventError.message);
        }

        setSelectedTimelineClientId(data.id);
      }

      setMessage("Client added successfully.");
      setClientForm(emptyClientForm);
      await loadClients();
      if (data?.id) {
        await loadTimeline(data.id);
      }
    } catch (insertError) {
      reportError("Unable to add client", insertError);
      setError(getErrorMessage(insertError, "Unable to add client."));
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
      const { data, error: campaignError } = await supabase
        .from("campaigns")
        .insert({
          name: campaignForm.name.trim(),
          description: campaignForm.description.trim() || null,
          daily_limit: normalizeNumber(campaignForm.daily_limit, 10),
          cooldown_days: normalizeNumber(campaignForm.cooldown_days, 30),
        })
        .select("*")
        .single();

      if (campaignError) {
        throw new Error(campaignError.message);
      }

      setMessage("Campaign created.");
      setCampaignForm(emptyCampaignForm);
      if (data?.id) {
        setTemplateForm((current) => ({ ...current, campaign_id: data.id }));
      }
      await loadCampaignsAndTemplates();
    } catch (campaignError) {
      setError(
        campaignError instanceof Error
          ? campaignError.message
          : "Unable to create campaign.",
      );
    }

    setIsSavingCampaign(false);
  }

  async function handleTemplateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    setIsSavingTemplate(true);

    try {
      if (!templateForm.campaign_id) {
        throw new Error("Create or select a campaign before adding a template.");
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

      setMessage("Email template created.");
      setTemplateForm((current) => ({
        ...emptyTemplateForm,
        campaign_id: current.campaign_id,
      }));
      await loadCampaignsAndTemplates();
    } catch (templateError) {
      setError(
        templateError instanceof Error
          ? templateError.message
          : "Unable to create template.",
      );
    }

    setIsSavingTemplate(false);
  }

  function handleRunTodaysMarketing() {
    setError("");
    setMessage(
      "Email sending is not connected yet. Today's queue is ready for review.",
    );
  }

  function openActionPanel(panel: "client" | "csv" | "campaign" | "template") {
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
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-cyan-700">
              Marketing Assistant
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-slate-950">
              Marketing Assistant
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Keeps your contacts warm without overwhelming them.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="h-10 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
              onClick={() => openActionPanel("client")}
              type="button"
            >
              Add Contact
            </button>
            <button
              className="h-10 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-cyan-600 hover:text-cyan-700"
              onClick={() => openActionPanel("csv")}
              type="button"
            >
              Import CSV
            </button>
            <button
              className="h-10 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-cyan-600 hover:text-cyan-700"
              onClick={() => openActionPanel("campaign")}
              type="button"
            >
              New Campaign
            </button>
            <button
              className="h-10 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-cyan-600 hover:text-cyan-700"
              onClick={() => openActionPanel("template")}
              type="button"
            >
              New Template
            </button>
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

        <section>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium uppercase tracking-wide text-cyan-700">
                Morning Marketing Health Check
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">
                Good morning. You have{" "}
                {marketingHealth.dueForFollowUp.length} contacts due for a
                friendly follow-up. I recommend starting with the warmest 10.
              </h2>
            </div>
            <button
              className="h-11 rounded-md bg-cyan-700 px-5 text-sm font-semibold text-white transition hover:bg-cyan-800"
              onClick={handleRunTodaysMarketing}
              type="button"
            >
              Run Today&apos;s Marketing
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Total contacts</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {clients.length}
              </p>
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Healthy contacts</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {marketingHealth.healthyContacts.length}
              </p>
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Due for follow-up</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {marketingHealth.dueForFollowUp.length}
              </p>
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Cold contacts</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {marketingHealth.coldContacts.length}
              </p>
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Unsubscribed</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {marketingHealth.unsubscribedContacts.length}
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">
                Today&apos;s Tasks
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                A practical queue for keeping your list warm.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-4">
            <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-700">
              Send follow-up emails to{" "}
              <span className="font-semibold text-slate-950">
                {marketingHealth.dueForFollowUp.length}
              </span>{" "}
              contacts due this month.
            </div>
            <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-700">
              Call{" "}
              <span className="font-semibold text-slate-950">
                {marketingHealth.warmLeads.length}
              </span>{" "}
              warm leads who opened or clicked.
            </div>
            <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-700">
              Review{" "}
              <span className="font-semibold text-slate-950">
                {marketingHealth.coldContacts.length}
              </span>{" "}
              cold contacts that have not engaged recently.
            </div>
            <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-700">
              Do not contact{" "}
              <span className="font-semibold text-slate-950">
                {marketingHealth.unsubscribedContacts.length}
              </span>{" "}
              unsubscribed contacts.
            </div>
          </div>
        </section>

        <section className="rounded-md border border-cyan-200 bg-white shadow-sm">
          <div className="flex flex-col gap-2 border-b border-cyan-100 bg-cyan-50 p-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium uppercase tracking-wide text-cyan-700">
                Who should I email today?
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">
                Warm Leads &amp; Recommended Follow-ups
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Start with the contacts most likely to appreciate a friendly
                check-in.
              </p>
            </div>
            <span className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-cyan-900 shadow-sm">
              Top {recommendedClients.length}
            </span>
          </div>
          <div className="grid gap-3 p-4 xl:grid-cols-2">
            {recommendedClients.length > 0 ? (
              recommendedClients.map(({ client, score, reasons }) => {
                const temperature = getContactTemperature(client, score);

                return (
                  <button
                    className="rounded-md border border-slate-200 bg-white p-4 text-left transition hover:border-cyan-300 hover:bg-cyan-50"
                    key={client.id}
                    onClick={() => setSelectedTimelineClientId(client.id)}
                    type="button"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-md border px-2 py-1 text-xs font-semibold ${getTemperatureClasses(
                              temperature,
                            )}`}
                          >
                            {temperature}
                          </span>
                          <span className="text-xs text-slate-500">
                            Score {score}
                          </span>
                        </div>
                        <p className="mt-3 font-semibold text-slate-950">
                          {getClientName(client)}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {client.company || "No company"} |{" "}
                          {client.email || "No email"}
                        </p>
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
                  </button>
                );
              })
            ) : (
              <p className="p-4 text-sm text-slate-500">
                Add or import contacts to generate recommendations.
              </p>
            )}
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="flex min-w-0 flex-col gap-6">
            <div className="rounded-md border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-col gap-4 border-b border-slate-200 p-5 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">
                    Contact Database
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Search, review temperature, and open timelines for every
                    contact.
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
                      <th className="px-4 py-3 font-semibold">Lead score</th>
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
                              {score}
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

            <div className="rounded-md border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">
                    Campaigns and templates
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Draft future follow-up campaigns without sending email yet.
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
                    Create campaign
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
                    {isSavingCampaign ? "Creating..." : "Create campaign"}
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
                    Create email template
                  </h3>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                    Campaign
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
                      <option value="">Select campaign</option>
                      {campaigns.map((campaign) => (
                        <option key={campaign.id} value={campaign.id}>
                          {campaign.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                    Template name
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
                    {isSavingTemplate ? "Creating..." : "Create template"}
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
                              {campaign.description || "No description"}
                            </p>
                          </div>
                          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                            {campaign.status}
                          </span>
                        </div>
                        <div className="mt-3 flex gap-2 text-xs text-slate-600">
                          <span>{campaign.daily_limit}/day</span>
                          <span>{campaign.cooldown_days} day cooldown</span>
                          <span>{templatesForCampaign.length} templates</span>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-sm text-slate-500">
                    Create a campaign to start drafting templates.
                  </p>
                )}
              </div>
            </div>
          </div>

          <aside className="flex flex-col gap-6">
            <div className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-950">
                    Contact tools
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Use the buttons at the top to add contacts or import a CSV.
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
                  Add contact
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
                  {isSavingClient ? "Adding..." : "Add contact"}
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
                  Choose Add Contact or Import CSV from the top action bar when
                  you want to update your contact list.
                </p>
              )}
            </div>

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
          </aside>
        </section>
      </div>
    </main>
  );
}
