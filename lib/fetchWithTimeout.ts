export async function fetchWithTimeout(input: string | URL | Request, init: RequestInit = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`request_timeout_${timeoutMs}ms`)), timeoutMs);
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const message = controller.signal.aborted
      ? `request_timeout after ${timeoutMs}ms: ${url}`
      : `fetch_failed: ${url}: ${error.message}`;
    const wrapped = new Error(message);
    wrapped.cause = cause;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}
