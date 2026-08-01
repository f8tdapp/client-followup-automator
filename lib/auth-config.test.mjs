import assert from "node:assert/strict";
import test from "node:test";
import { getAllowedOwnerEmails, getPipelineCueAppUrl, normalizeEmail } from "./auth-config.ts";

test("owner allowlist comparison trims, normalizes case, and ignores blanks", () => {
  assert.equal(normalizeEmail("  Owner@Example.COM "), "owner@example.com");
  assert.deepEqual(
    [...getAllowedOwnerEmails(" Owner@Example.COM, second@example.com, ,")],
    ["owner@example.com", "second@example.com"],
  );
});

test("application URL is fixed, absolute, and HTTPS outside local development", () => {
  assert.equal(getPipelineCueAppUrl("https://pipelinecue.example/", "production"), "https://pipelinecue.example");
  assert.equal(getPipelineCueAppUrl("http://localhost:3000", "development"), "http://localhost:3000");
  for (const value of [undefined, "http://pipelinecue.example", "https://user:pass@pipelinecue.example", "https://pipelinecue.example/path", "https://pipelinecue.example/?next=evil", "https://pipelinecue.example/#evil"]) {
    assert.throws(() => getPipelineCueAppUrl(value, "production"));
  }
});
