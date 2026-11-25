// Await the in-flight daily official FYERS master refresh before deciding that
// a symbol/contract is unavailable. Authenticated requests can arrive in parallel
// with the first request that starts the refresh after a Render process restart.
export async function waitForCurrentFnoMaster({ loadPromise = null, isCurrent = () => false } = {}) {
  if (loadPromise && typeof loadPromise.then === 'function') {
    try { await loadPromise; } catch { /* fail closed using the authoritative current-session check below */ }
  }
  return Boolean(isCurrent());
}
