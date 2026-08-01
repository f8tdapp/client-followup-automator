import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const envelopePrefix = "pipelinecue:v1";

export class HubSpotTokenEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubSpotTokenEncryptionError";
  }
}

export function getHubSpotTokenEncryptionKey(
  encoded = process.env.HUBSPOT_TOKEN_ENCRYPTION_KEY,
) {
  if (!encoded?.trim()) {
    throw new HubSpotTokenEncryptionError("HubSpot token encryption is not configured.");
  }
  let key: Buffer;
  try {
    key = Buffer.from(encoded.trim(), "base64");
  } catch {
    throw new HubSpotTokenEncryptionError("HubSpot token encryption key is malformed.");
  }
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== encoded.trim().replace(/=+$/, "")) {
    throw new HubSpotTokenEncryptionError("HubSpot token encryption key must be exactly 32 bytes encoded as base64.");
  }
  return key;
}

export function encryptHubSpotToken(token: string, encodedKey?: string) {
  if (!token) throw new HubSpotTokenEncryptionError("Cannot encrypt an empty HubSpot token.");
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, getHubSpotTokenEncryptionKey(encodedKey), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [envelopePrefix, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptHubSpotToken(envelope: string, encodedKey?: string) {
  const parts = envelope.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== envelopePrefix) {
    throw new HubSpotTokenEncryptionError("HubSpot token is not a supported encrypted envelope; reconnect HubSpot.");
  }
  try {
    const iv = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    const ciphertext = Buffer.from(parts[4], "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error();
    const decipher = createDecipheriv(algorithm, getHubSpotTokenEncryptionKey(encodedKey), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof HubSpotTokenEncryptionError) throw error;
    throw new HubSpotTokenEncryptionError("HubSpot token envelope is malformed or failed authentication.");
  }
}

export function isEncryptedHubSpotTokenEnvelope(value: string | null | undefined) {
  return Boolean(value?.startsWith(`${envelopePrefix}:`));
}
