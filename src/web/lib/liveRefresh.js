// How often the organizer workspace checks for new responses. The organizer
// picks one per browser; 0 turns the automatic checks off (Refresh still
// works).
export const LIVE_REFRESH_OPTIONS = [
  { value: 5000, label: "Every 5 seconds" },
  { value: 15000, label: "Every 15 seconds" },
  { value: 30000, label: "Every 30 seconds" },
  { value: 60000, label: "Every minute" },
  { value: 0, label: "Off" },
];

export const DEFAULT_LIVE_REFRESH_MS = 5000;

const STORAGE_KEY = "releviz.organizer.live-refresh-ms";

function isOption(value) {
  return LIVE_REFRESH_OPTIONS.some((option) => option.value === value);
}

export function readLiveRefreshInterval() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null && isOption(Number(stored))) return Number(stored);
  } catch {
    // Storage can be missing or blocked (private windows, site data off).
  }
  return DEFAULT_LIVE_REFRESH_MS;
}

export function storeLiveRefreshInterval(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // The choice still applies to this page; it is just not remembered.
  }
}
