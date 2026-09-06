import assert from "node:assert/strict";
import test from "node:test";

import { getEmailComposeUrl } from "./email-compose.ts";

test("Gmail compose selects the PipelineCue sending account", () => {
  const url = new URL(getEmailComposeUrl("gmail", {
    contact_email: "recipient@example.invalid",
    subject: "Test subject",
    body: "Test body",
  }));

  assert.equal(url.origin, "https://mail.google.com");
  assert.equal(url.searchParams.get("authuser"), "tj@listingmediact.com");
  assert.equal(url.searchParams.get("to"), "recipient@example.invalid");
  assert.equal(url.searchParams.get("su"), "Test subject");
  assert.equal(url.searchParams.get("body"), "Test body");
});

test("Outlook compose remains unchanged", () => {
  const url = new URL(getEmailComposeUrl("outlook", {
    contact_email: "recipient@example.invalid",
    subject: "Test subject",
    body: "Test body",
  }));

  assert.equal(url.searchParams.has("authuser"), false);
  assert.equal(url.searchParams.get("to"), "recipient@example.invalid");
});
