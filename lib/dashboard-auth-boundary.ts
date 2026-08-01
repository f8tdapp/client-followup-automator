export function createDashboardAuthBoundary(
  clearPrivateState: () => void,
  redirect: (path: "/login" | "/denied") => void,
) {
  let generation = 0;
  let failed = false;
  return {
    capture: () => generation,
    canCommit: (captured: number) => !failed && captured === generation,
    handleStatus(status: number) {
      if (status !== 401 && status !== 403) return false;
      if (!failed) {
        failed = true;
        generation += 1;
        clearPrivateState();
        redirect(status === 401 ? "/login" : "/denied");
      }
      return true;
    },
  };
}
