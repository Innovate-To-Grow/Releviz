export function navigateTo(url, locationObject = window.location) {
  locationObject.assign(url);
}

export function safeNextPath(value, fallback = "/dashboard") {
  if (!value || !value.startsWith("/") || value.startsWith("//"))
    return fallback;
  try {
    const baseUrl = "https://releviz.invalid";
    const resolved = new URL(value, baseUrl);
    // Dot segments can normalise to a scheme-relative path ("/..//evil.com"
    // becomes "//evil.com"), which location.assign would send off-origin.
    if (resolved.origin !== baseUrl || resolved.pathname.startsWith("//")) {
      return fallback;
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
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
