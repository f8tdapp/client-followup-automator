export type ForecastRequestStatus = "loading" | "success" | "empty" | "error";

export type ForecastUiState<T extends { summary: {
  totalForecastWorkload: number;
  projectedBacklogAfter30Days: number;
} }> = {
  status: ForecastRequestStatus;
  data: T | null;
  error: string | null;
  stale: boolean;
};

export function createForecastUiState<T extends { summary: {
  totalForecastWorkload: number;
  projectedBacklogAfter30Days: number;
} }>(): ForecastUiState<T> {
  return { status: "loading", data: null, error: null, stale: false };
}

export function beginForecastRequest<T extends { summary: {
  totalForecastWorkload: number;
  projectedBacklogAfter30Days: number;
} }>(state: ForecastUiState<T>): ForecastUiState<T> {
  return { ...state, status: "loading" };
}

export function completeForecastRequest<T extends { summary: {
  totalForecastWorkload: number;
  projectedBacklogAfter30Days: number;
} }>(data: T): ForecastUiState<T> {
  const empty =
    data.summary.totalForecastWorkload === 0 &&
    data.summary.projectedBacklogAfter30Days === 0;
  return {
    status: empty ? "empty" : "success",
    data,
    error: null,
    stale: false,
  };
}

export function failForecastRequest<T extends { summary: {
  totalForecastWorkload: number;
  projectedBacklogAfter30Days: number;
} }>(
  state: ForecastUiState<T>,
  error: string,
): ForecastUiState<T> {
  return {
    status: "error",
    data: state.data,
    error,
    stale: Boolean(state.data),
  };
}

export async function readForecastResponse<T>(
  response: Pick<Response, "ok" | "json">,
): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error || "Unable to load the workload forecast.");
  }
  return (await response.json()) as T;
}

export async function runForecastRequest<T>(options: {
  request: () => Promise<T>;
  onSuccess: (value: T) => void;
  onFailure: (error: Error) => void;
  isCurrent: () => boolean;
  onFinally?: () => void;
}) {
  try {
    const value = await options.request();
    if (options.isCurrent()) options.onSuccess(value);
    return { status: "fulfilled" as const, value };
  } catch (error) {
    const normalized =
      error instanceof Error
        ? error
        : new Error("Unable to load the workload forecast.");
    if (options.isCurrent()) options.onFailure(normalized);
    return { status: "rejected" as const, reason: normalized };
  } finally {
    if (options.isCurrent()) options.onFinally?.();
  }
}

export function createLatestRequestGuard() {
  let generation = 0;
  let mounted = true;
  return {
    start() {
      generation += 1;
      return generation;
    },
    isCurrent(token: number) {
      return mounted && token === generation;
    },
    invalidateAll() {
      generation += 1;
    },
    mount() {
      mounted = true;
      generation += 1;
    },
    unmount() {
      mounted = false;
      generation += 1;
    },
  };
}

export async function runForecastAlongside<TForecast, TOther>(options: {
  forecast: () => Promise<TForecast>;
  other: () => Promise<TOther>;
  onForecastSuccess: (value: TForecast) => void;
  onForecastFailure: (error: Error) => void;
  onOtherSuccess: (value: TOther) => void;
  onOtherFailure: (error: Error) => void;
  isForecastCurrent: () => boolean;
  onForecastFinally?: () => void;
}) {
  const forecast = runForecastRequest({
    request: options.forecast,
    onSuccess: options.onForecastSuccess,
    onFailure: options.onForecastFailure,
    isCurrent: options.isForecastCurrent,
    onFinally: options.onForecastFinally,
  });
  const other = options.other().then(
    (value) => {
      options.onOtherSuccess(value);
      return { status: "fulfilled" as const, value };
    },
    (error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      options.onOtherFailure(normalized);
      return { status: "rejected" as const, reason: normalized };
    },
  );
  const [forecastResult, otherResult] = await Promise.all([forecast, other]);
  return { forecast: forecastResult, other: otherResult };
}
