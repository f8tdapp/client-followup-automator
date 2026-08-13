import assert from "node:assert/strict";
import test from "node:test";
import { classifyAuthFailure, requestMagicLink } from "./auth-login.ts";

test("successful submission calls the provider without logging", async () => {
  const calls = [];
  const logs = [];
  const result = await requestMagicLink("owner@example.com", {
    isAllowed: () => true,
    signInWithOtp: async (email) => {
      calls.push(email);
      return { error: null };
    },
    environment: "development",
    log: (message) => logs.push(message),
  });

  assert.equal(result, "accepted");
  assert.deepEqual(calls, ["owner@example.com"]);
  assert.deepEqual(logs, []);
});

test("denied submission does not call the provider or reveal the decision in logs", async () => {
  let called = false;
  const logs = [];
  const result = await requestMagicLink("stranger@example.com", {
    isAllowed: () => false,
    signInWithOtp: async () => {
      called = true;
      return { error: null };
    },
    environment: "development",
    log: (message) => logs.push(message),
  });

  assert.equal(result, "denied");
  assert.equal(called, false);
  assert.deepEqual(logs, []);
});

test("provider failure records only its sanitized code and status", async () => {
  const logs = [];
  const result = await requestMagicLink("owner@example.com", {
    isAllowed: () => true,
    signInWithOtp: async () => ({
      error: {
        code: "smtp_failure",
        status: 500,
        message: "SMTP rejected password super-secret and https://example.test/magic?token=secret",
      },
    }),
    environment: "development",
    log: (message) => logs.push(message),
  });

  assert.equal(result, "provider_error");
  assert.deepEqual(logs, ["[auth.login] result=provider_error category=unknown code=smtp_failure status=500 constructor=Object name=unknown own_properties=code,message,status has_code=true has_status=true has_cause=false has_message=true"]);
  assert.doesNotMatch(logs.join("\n"), /super-secret|example\.test|token=/i);
});

test("malicious provider fields and thrown failures cannot leak secrets", async () => {
  const providerLogs = [];
  await requestMagicLink("owner@example.com", {
    isAllowed: () => true,
    signInWithOtp: async () => ({ error: { code: "bad code secret=value", status: "500 secret" } }),
    environment: "development",
    log: (message) => providerLogs.push(message),
  });
  assert.deepEqual(providerLogs, ["[auth.login] result=provider_error category=unknown code=unknown status=unknown constructor=Object name=unknown own_properties=code,status has_code=true has_status=true has_cause=false has_message=false"]);

  const productionLogs = [];
  const result = await requestMagicLink("owner@example.com", {
    isAllowed: () => true,
    signInWithOtp: async () => {
      throw new Error("password=super-secret");
    },
    environment: "production",
    log: (message) => productionLogs.push(message),
  });
  assert.equal(result, "provider_error");
  assert.deepEqual(productionLogs, []);
});

test("safe failure categories use exact metadata and never expose source text", () => {
  assert.equal(classifyAuthFailure({ name: "AuthApiError", status: 401, message: "Invalid API key" }), "supabase_api_key_rejected");
  assert.equal(classifyAuthFailure({ name: "AuthRetryableFetchError", status: 0 }), "network_failure");
  assert.equal(classifyAuthFailure({ code: "over_email_send_rate_limit" }), "email_rate_limited");
  assert.equal(classifyAuthFailure({ code: "email_address_not_authorized" }), "email_not_authorized");
  assert.equal(classifyAuthFailure({ message: "535-5.7.8 Username and Password not accepted" }), "smtp_authentication_failed");
  assert.equal(classifyAuthFailure({ message: "dial tcp: connection refused" }), "smtp_connection_failed");
  assert.equal(classifyAuthFailure({ message: "553 5.7.1 sender address rejected" }), "smtp_sender_rejected");
  assert.equal(classifyAuthFailure({ message: "some new provider failure" }), "unknown");
});
