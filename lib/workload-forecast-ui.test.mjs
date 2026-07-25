import assert from "node:assert/strict";
import test from "node:test";
import {
  beginForecastRequest,
  completeForecastRequest,
  createLatestRequestGuard,
  createForecastUiState,
  failForecastRequest,
  readForecastResponse,
  runForecastAlongside,
  runForecastRequest,
} from "./workload-forecast-ui.ts";

function forecast(total = 1, backlog = 0) {
  return {
    summary: {
      totalForecastWorkload: total,
      projectedBacklogAfter30Days: backlog,
    },
  };
}

test("forecast UI distinguishes loading, success, and empty states", () => {
  const loading = createForecastUiState();
  const success = completeForecastRequest(forecast(3));
  const empty = completeForecastRequest(forecast(0));

  assert.equal(loading.status, "loading");
  assert.equal(loading.data, null);
  assert.equal(success.status, "success");
  assert.equal(empty.status, "empty");
});

test("failed refresh visibly retains stale results and retry remains loading", () => {
  const success = completeForecastRequest(forecast(3));
  const failed = failForecastRequest(success, "Forecast failed.");
  const retrying = beginForecastRequest(failed);

  assert.equal(failed.status, "error");
  assert.equal(failed.stale, true);
  assert.strictEqual(failed.data, success.data);
  assert.equal(retrying.status, "loading");
  assert.equal(retrying.error, "Forecast failed.");
});

test("initial failure has no misleading zero forecast", () => {
  const failed = failForecastRequest(
    createForecastUiState(),
    "Forecast failed.",
  );

  assert.equal(failed.status, "error");
  assert.equal(failed.data, null);
  assert.equal(failed.stale, false);
});

function orchestrationHarness(initial = createForecastUiState()) {
  let state = initial;
  let dashboardValue = null;
  let dashboardError = null;
  let finallyCount = 0;
  const guard = createLatestRequestGuard();
  function start() {
    const token = guard.start();
    state = beginForecastRequest(state);
    return token;
  }
  return {
    run(forecastResponse, other) {
      const token = start();
      return runForecastAlongside({
        forecast: async () =>
          readForecastResponse(await forecastResponse()),
        other,
        onForecastSuccess: (value) => {
          state = completeForecastRequest(value);
        },
        onForecastFailure: (error) => {
          state = failForecastRequest(state, error.message);
        },
        onOtherSuccess: (value) => {
          dashboardValue = value;
        },
        onOtherFailure: (error) => {
          dashboardError = error;
        },
        isForecastCurrent: () => guard.isCurrent(token),
        onForecastFinally: () => {
          finallyCount += 1;
        },
      });
    },
    retry(response) {
      const token = start();
      return runForecastRequest({
        request: async () => readForecastResponse(await response()),
        onSuccess: (value) => {
          state = completeForecastRequest(value);
        },
        onFailure: (error) => {
          state = failForecastRequest(state, error.message);
        },
        isCurrent: () => guard.isCurrent(token),
        onFinally: () => {
          finallyCount += 1;
        },
      });
    },
    unmount() { guard.unmount(); },
    get state() { return state; },
    get dashboardValue() { return dashboardValue; },
    get dashboardError() { return dashboardError; },
    get finallyCount() { return finallyCount; },
  };
}

const successfulForecastResponse = () =>
  Promise.resolve(Response.json(forecast(7)));

for (const unrelatedFailure of ["drafts", "settings", "HubSpot"]) {
  test(`actual orchestration preserves forecast success when ${unrelatedFailure} fails`, async () => {
    const harness = orchestrationHarness();
    await harness.run(successfulForecastResponse, async () => {
      throw new Error(`${unrelatedFailure} failed`);
    });
    assert.equal(harness.state.status, "success");
    assert.equal(harness.state.stale, false);
    assert.match(harness.dashboardError.message, /failed/);
  });
}

test("forecast failure does not prevent successful dashboard responses", async () => {
  const harness = orchestrationHarness();
  await harness.run(
    () => Promise.resolve(Response.json({ error: "Forecast failed." }, { status: 500 })),
    async () => ({ drafts: 3, settingsLoaded: true }),
  );
  assert.equal(harness.state.status, "error");
  assert.deepEqual(harness.dashboardValue, { drafts: 3, settingsLoaded: true });
});

test("refresh success remains successful after unrelated parsing failure", async () => {
  const harness = orchestrationHarness(completeForecastRequest(forecast(2)));
  await harness.run(successfulForecastResponse, async () => {
    throw new SyntaxError("Draft JSON malformed");
  });
  assert.equal(harness.state.status, "success");
  assert.equal(harness.state.data.summary.totalForecastWorkload, 7);
});

test("refresh failure retains stale data and retry success clears stale error", async () => {
  const harness = orchestrationHarness(completeForecastRequest(forecast(2)));
  await harness.retry(() => Promise.reject(new Error("Network failed.")));
  assert.equal(harness.state.status, "error");
  assert.equal(harness.state.stale, true);
  assert.equal(harness.state.data.summary.totalForecastWorkload, 2);

  await harness.retry(successfulForecastResponse);
  assert.equal(harness.state.status, "success");
  assert.equal(harness.state.stale, false);
  assert.equal(harness.state.error, null);
});

test("malformed forecast JSON changes only forecast state", async () => {
  const harness = orchestrationHarness();
  await harness.run(
    () => Promise.resolve(new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    })),
    async () => ({ drafts: 4 }),
  );
  assert.equal(harness.state.status, "error");
  assert.deepEqual(harness.dashboardValue, { drafts: 4 });
});

test("non-2xx forecast response uses its error without blocking other data", async () => {
  const harness = orchestrationHarness();
  await harness.run(
    () => Promise.resolve(Response.json({ error: "Forecast unavailable." }, { status: 503 })),
    async () => ({ settingsLoaded: true }),
  );
  assert.equal(harness.state.status, "error");
  assert.equal(harness.state.error, "Forecast unavailable.");
  assert.deepEqual(harness.dashboardValue, { settingsLoaded: true });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("newer success wins when older request succeeds later", async () => {
  const harness = orchestrationHarness();
  const older = deferred();
  const newer = deferred();
  const olderRun = harness.retry(() => older.promise);
  const newerRun = harness.retry(() => newer.promise);
  newer.resolve(Response.json(forecast(9)));
  await newerRun;
  older.resolve(Response.json(forecast(2)));
  await olderRun;
  assert.equal(harness.state.status, "success");
  assert.equal(harness.state.data.summary.totalForecastWorkload, 9);
  assert.equal(harness.finallyCount, 1);
});

test("older failure cannot replace newer success", async () => {
  const harness = orchestrationHarness();
  const older = deferred();
  const newer = deferred();
  const olderRun = harness.retry(() => older.promise);
  const newerRun = harness.retry(() => newer.promise);
  newer.resolve(Response.json(forecast(8)));
  await newerRun;
  older.reject(new Error("Old failure"));
  await olderRun;
  assert.equal(harness.state.status, "success");
  assert.equal(harness.state.data.summary.totalForecastWorkload, 8);
});

test("newer failure wins and older success is ignored", async () => {
  const harness = orchestrationHarness(completeForecastRequest(forecast(1)));
  const older = deferred();
  const newer = deferred();
  const olderRun = harness.retry(() => older.promise);
  const newerRun = harness.retry(() => newer.promise);
  newer.reject(new Error("Current failure"));
  await newerRun;
  older.resolve(forecast(10));
  await olderRun;
  assert.equal(harness.state.status, "error");
  assert.equal(harness.state.error, "Current failure");
  assert.equal(harness.state.data.summary.totalForecastWorkload, 1);
});

test("Retry supersedes initial loading and refresh supersedes Retry", async () => {
  const harness = orchestrationHarness();
  const initial = deferred();
  const retry = deferred();
  const refresh = deferred();
  const initialRun = harness.retry(() => initial.promise);
  const retryRun = harness.retry(() => retry.promise);
  const refreshRun = harness.run(() => refresh.promise, async () => "dashboard");
  refresh.resolve(Response.json(forecast(12)));
  await refreshRun;
  retry.resolve(forecast(7));
  initial.resolve(forecast(3));
  await Promise.all([retryRun, initialRun]);
  assert.equal(harness.state.status, "success");
  assert.equal(harness.state.data.summary.totalForecastWorkload, 12);
});

for (const completion of ["success", "failure"]) {
  test(`unmount ignores pending ${completion}`, async () => {
    const harness = orchestrationHarness(completeForecastRequest(forecast(4)));
    const pending = deferred();
    const run = harness.retry(() => pending.promise);
    harness.unmount();
    if (completion === "success") pending.resolve(forecast(15));
    else pending.reject(new Error("After unmount"));
    await run;
    assert.equal(harness.state.status, "loading");
    assert.equal(harness.state.data.summary.totalForecastWorkload, 4);
    assert.equal(harness.finallyCount, 0);
  });
}
