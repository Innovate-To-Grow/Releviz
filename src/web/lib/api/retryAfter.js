export function retryAfterSeconds(response, payload) {
  const header = response.headers?.get("Retry-After");
  if (header?.trim()) {
    const value = header.trim();
    const seconds = /^\d+(\.\d+)?$/.test(value)
      ? Number(value)
      : (Date.parse(value) - Date.now()) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  }
  const fallback = payload?.retry_after;
  if (
    (typeof fallback === "number" || typeof fallback === "string") &&
    String(fallback).trim() &&
    Number.isFinite(Number(fallback)) &&
    Number(fallback) >= 0
  ) {
    return Math.ceil(Number(fallback));
  }
  return undefined;
}
