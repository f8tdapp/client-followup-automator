import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardAuthBoundary } from "./dashboard-auth-boundary.ts";

for (const [status, destination] of [[401, "/login"], [403, "/denied"]]) {
  test(`dashboard ${status} clears private state and rejects late success`, () => {
    const privateState = { contacts: [1], drafts: [2], forecast: { private: true } };
    const redirects = [];
    const boundary = createDashboardAuthBoundary(() => {
      privateState.contacts = [];
      privateState.drafts = [];
      privateState.forecast = null;
    }, (path) => redirects.push(path));
    const inFlightGeneration = boundary.capture();
    assert.equal(boundary.handleStatus(status), true);
    assert.deepEqual(privateState, { contacts: [], drafts: [], forecast: null });
    assert.deepEqual(redirects, [destination]);
    assert.equal(boundary.canCommit(inFlightGeneration), false);
  });
}
