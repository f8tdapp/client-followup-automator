import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptHubSpotToken,
  encryptHubSpotToken,
  getHubSpotTokenEncryptionKey,
} from "./hubspot-token-crypto.ts";

const key = Buffer.alloc(32, 7).toString("base64");

test("HubSpot tokens round-trip with randomized authenticated envelopes", () => {
  const first = encryptHubSpotToken("secret-token", key);
  const second = encryptHubSpotToken("secret-token", key);
  assert.notEqual(first, second);
  assert.equal(decryptHubSpotToken(first, key), "secret-token");
  assert.equal(first.includes("secret-token"), false);
});

test("HubSpot token encryption rejects missing and malformed keys", () => {
  assert.throws(() => getHubSpotTokenEncryptionKey(""), /not configured/);
  assert.throws(() => getHubSpotTokenEncryptionKey(Buffer.alloc(31).toString("base64")), /32 bytes/);
  assert.throws(() => getHubSpotTokenEncryptionKey("not-base64!"), /32 bytes|malformed/);
});

test("HubSpot token decryption rejects tampering, plaintext, and unsupported versions", () => {
  const envelope = encryptHubSpotToken("secret-token", key);
  const tampered = `${envelope.slice(0, -1)}${envelope.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => decryptHubSpotToken(tampered, key), /malformed|authentication/);
  assert.throws(() => decryptHubSpotToken("plaintext-token", key), /supported encrypted envelope/);
  assert.throws(() => decryptHubSpotToken(envelope.replace("v1", "v2"), key), /supported encrypted envelope/);
});
