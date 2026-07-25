export function navigateTo(url, locationObject = window.location) {
  locationObject.assign(url);
}

export function reloadPage(locationObject = window.location) {
  locationObject.reload();
}

export function replaceUrl(url, historyObject = window.history) {
  historyObject.replaceState({}, "", url);
}
