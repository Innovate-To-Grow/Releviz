export function navigateTo(url, locationObject = window.location) {
  locationObject.assign(url);
}

export function safeNextPath(value, fallback = "/dashboard") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const baseUrl = "https://releviz.invalid";
    const resolved = new URL(value, baseUrl);
    return resolved.origin === baseUrl
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

export function reloadPage(locationObject = window.location) {
  locationObject.reload();
}

export function replaceUrl(url, historyObject = window.history) {
  historyObject.replaceState({}, "", url);
}
