import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Pilot finding (Oct 2026): every day's plan reset each brokerage it touched
// back to a limit of 3, so an owner-lowered limit (e.g. 1 for a firm whose
// spam filter blocks cold email) never lasted past the next morning.
test("daily plan generation never overwrites an existing brokerage limit", async () => {
  const source = await readFile(new URL("./campaign-schedule.ts", import.meta.url), "utf8");
  const start = source.indexOf('.from("broker_domain_limits").upsert(');
  assert.notEqual(start, -1, "the brokerage-limit upsert should still exist");
  const upsert = source.slice(start, source.indexOf("),", source.indexOf("onConflict", start)) + 2);

  assert.match(upsert, /onConflict: "broker_domain", ignoreDuplicates: true/);
  assert.doesNotMatch(upsert, /daily_limit:\s*3\b/);
  assert.match(upsert, /daily_limit: getDefaultBrokerDomainLimit\(campaigns\)/);
});

test("new brokerages start at the strictest active campaign limit", async () => {
  const source = await readFile(new URL("./campaign-schedule.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function getDefaultBrokerDomainLimit(");
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf("\n}\n", start) + 3);
  // Evaluate the helper on its own: it has no imports or side effects.
  const js = body
    .replace("export function", "function")
    .replace(/\(\s*campaigns:[\s\S]*?\)\s*\{/, "(campaigns) {")
    .replace(/\(limit\): limit is number =>/, "(limit) =>");
  const getDefaultBrokerDomainLimit = new Function(`${js}; return getDefaultBrokerDomainLimit;`)();

  assert.equal(getDefaultBrokerDomainLimit([{ broker_domain_daily_limit: 2 }]), 2);
  assert.equal(getDefaultBrokerDomainLimit([{ broker_domain_daily_limit: 3 }, { broker_domain_daily_limit: 1 }]), 1);
  assert.equal(getDefaultBrokerDomainLimit([{ broker_domain_daily_limit: null }]), 3);
  assert.equal(getDefaultBrokerDomainLimit([]), 3);
});
