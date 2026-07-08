export type HubSpotTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  hub_id?: number;
  scope?: string;
  token_type?: string;
};

type HubSpotContactProperties = {
  email?: string;
  firstname?: string;
  lastname?: string;
  company?: string;
  company_domain?: string;
  domain?: string;
  website?: string;
  phone?: string;
  lifecyclestage?: string;
  hs_email_optout?: string;
  notes_last_contacted?: string;
  last_contacted?: string;
  lastmodifieddate?: string;
  hs_analytics_last_visit_timestamp?: string;
};

type HubSpotContact = {
  id: string;
  properties: HubSpotContactProperties;
  createdAt?: string;
  updatedAt?: string;
};

type HubSpotContactsResponse = {
  results: HubSpotContact[];
  paging?: {
    next?: {
      after?: string;
    };
  };
};

export type NormalizedHubSpotContact = {
  hubspot_contact_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  lifecycle_stage: string | null;
  is_unsubscribed: boolean;
  last_contacted_at: string | null;
  last_engaged_at: string | null;
  raw_properties: HubSpotContactProperties;
  updated_at: string;
};

const hubSpotTokenUrl = "https://api.hubapi.com/oauth/v1/token";
const hubSpotContactsUrl = "https://api.hubapi.com/crm/v3/objects/contacts";

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

export function getHubSpotScopes() {
  return (
    process.env.HUBSPOT_SCOPES?.trim() ||
    "crm.objects.contacts.read oauth"
  );
}

export function getHubSpotPrivateAppToken() {
  return process.env.HUBSPOT_PRIVATE_APP_TOKEN?.trim() || null;
}

export function hasHubSpotPrivateToken() {
  return Boolean(process.env.HUBSPOT_PRIVATE_APP_TOKEN?.trim());
}

export function getHubSpotAuthorizationUrl(state: string) {
  // TODO: OAuth is required later for multi-user/customer installations.
  // Private app tokens are only the early development sync path.
  const searchParams = new URLSearchParams({
    client_id: getRequiredEnv("HUBSPOT_CLIENT_ID"),
    redirect_uri: getRequiredEnv("HUBSPOT_REDIRECT_URI"),
    scope: getHubSpotScopes(),
    state,
  });

  return `https://app.hubspot.com/oauth/authorize?${searchParams.toString()}`;
}

export async function exchangeOAuthCodeForTokens(code: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: getRequiredEnv("HUBSPOT_CLIENT_ID"),
    client_secret: getRequiredEnv("HUBSPOT_CLIENT_SECRET"),
    redirect_uri: getRequiredEnv("HUBSPOT_REDIRECT_URI"),
    code,
  });

  return requestToken(body);
}

export async function refreshHubSpotTokens(refreshToken: string) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: getRequiredEnv("HUBSPOT_CLIENT_ID"),
    client_secret: getRequiredEnv("HUBSPOT_CLIENT_SECRET"),
    refresh_token: refreshToken,
  });

  return requestToken(body);
}

async function requestToken(body: URLSearchParams) {
  const response = await fetch(hubSpotTokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`HubSpot token request failed: ${errorBody}`);
  }

  return (await response.json()) as HubSpotTokenResponse;
}

export async function fetchHubSpotContacts(accessToken: string) {
  const contacts: HubSpotContact[] = [];
  let after: string | undefined;

  do {
    const searchParams = new URLSearchParams({
      limit: "100",
      properties: [
        "email",
        "firstname",
        "lastname",
        "company",
        "company_domain",
        "domain",
        "website",
        "phone",
        "lifecyclestage",
        "hs_email_optout",
        "notes_last_contacted",
        "last_contacted",
        "lastmodifieddate",
        "hs_analytics_last_visit_timestamp",
      ].join(","),
    });

    if (after) {
      searchParams.set("after", after);
    }

    const response = await fetch(`${hubSpotContactsUrl}?${searchParams}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HubSpot contacts request failed: ${errorBody}`);
    }

    const body = (await response.json()) as HubSpotContactsResponse;
    contacts.push(...body.results);
    after = body.paging?.next?.after;
  } while (after);

  return contacts.map(normalizeHubSpotContact);
}

export function normalizeHubSpotContact(
  contact: HubSpotContact,
): NormalizedHubSpotContact {
  const properties = contact.properties ?? {};
  const lastContactedAt =
    normalizeDate(properties.notes_last_contacted) ??
    normalizeDate(properties.last_contacted);
  const lastEngagedAt =
    normalizeDate(properties.hs_analytics_last_visit_timestamp) ??
    normalizeDate(properties.lastmodifieddate);

  return {
    hubspot_contact_id: contact.id,
    email: normalizeText(properties.email),
    first_name: normalizeText(properties.firstname),
    last_name: normalizeText(properties.lastname),
    company: normalizeText(properties.company),
    phone: normalizeText(properties.phone),
    lifecycle_stage: normalizeText(properties.lifecyclestage),
    is_unsubscribed: properties.hs_email_optout === "true",
    last_contacted_at: lastContactedAt,
    last_engaged_at: lastEngagedAt,
    raw_properties: properties,
    updated_at: new Date().toISOString(),
  };
}

function normalizeText(value: string | undefined) {
  const trimmedValue = value?.trim();

  return trimmedValue || null;
}

function normalizeDate(value: string | undefined) {
  if (!value) {
    return null;
  }

  const date =
    /^\d+$/.test(value) && value.length > 10
      ? new Date(Number(value))
      : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}
