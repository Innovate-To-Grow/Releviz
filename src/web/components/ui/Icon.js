/*
 * Inline icon set.
 *
 * Icons are drawn with `currentColor` strokes so they inherit tone from their
 * surrounding component, and they are decorative by default. An icon is only
 * exposed to assistive technology when it is given an explicit `label`, which
 * never happens for an icon that sits next to visible text.
 */

const ICON_PATHS = {
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  alertCircle: "M12 8v5M12 16.5v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  alertTriangle:
    "M12 9v4M12 17v.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  calendar:
    "M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  check: "M4.5 12.5 9.5 17.5 19.5 6.5",
  checkCircle: "M8.5 12.5 11 15l5-5.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  chevronDown: "M6 9.5 12 15.5 18 9.5",
  chevronLeft: "M14.5 6 8.5 12 14.5 18",
  chevronRight: "M9.5 6 15.5 12 9.5 18",
  clock: "M12 7.5V12l2.75 1.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  close: "M6 6 18 18M18 6 6 18",
  copy: "M9 9V5.5A1.5 1.5 0 0 1 10.5 4h8A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H15M5.5 9h8A1.5 1.5 0 0 1 15 10.5v8A1.5 1.5 0 0 1 13.5 20h-8A1.5 1.5 0 0 1 4 18.5v-8A1.5 1.5 0 0 1 5.5 9Z",
  download: "M12 4v11M7.5 10.5 12 15l4.5-4.5M4 19h16",
  filter: "M3.5 5.5h17l-6.5 7.5v5.5l-4 2v-7.5Z",
  inbox:
    "M3.5 13h4l1.5 3h6l1.5-3h4M6 4.5h12l3 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18v-5Z",
  info: "M12 11.5V16M12 7.75v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  lock: "M8 10.5V7.5a4 4 0 0 1 8 0v3M6.5 10.5h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z",
  link: "M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.5 1.5M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.5-1.5",
  logOut:
    "M15 17l4.5-5L15 7M19 12H9M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9",
  mail: "M3.5 7.5 12 13l8.5-5.5M4.5 5.5h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z",
  mapPin:
    "M12 12.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 11.5a8 8 0 1 1-2.6-5.4M20 4v5h-5",
  scale: "M12 4v16M7 8h10M5.5 8 3 14.5h5ZM18.5 8 16 14.5h5ZM7.5 20h9",
  search: "M20 20l-3.6-3.6M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  settings:
    "M12 15.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5ZM19.4 14.4a1.5 1.5 0 0 0 .3 1.65l.06.06a1.8 1.8 0 1 1-2.55 2.55l-.06-.06a1.5 1.5 0 0 0-2.55 1.07V20a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-2.6-1.02l-.06.06a1.8 1.8 0 1 1-2.55-2.55l.06-.06A1.5 1.5 0 0 0 4.5 13.8H4.3a1.8 1.8 0 1 1 0-3.6h.1A1.5 1.5 0 0 0 5.47 7.6l-.06-.06A1.8 1.8 0 1 1 7.96 5l.06.06a1.5 1.5 0 0 0 2.55-1.07V3.8a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 2.55 1.07l.06-.06A1.8 1.8 0 1 1 19.33 7.5l-.06.06a1.5 1.5 0 0 0 1.07 2.55h.16a1.8 1.8 0 0 1 0 3.6h-.1a1.5 1.5 0 0 0-1.4.94Z",
  shield:
    "M9.5 12.25 11.25 14l3.5-3.75M12 3.5 5 6v6c0 4.5 3 7.4 7 8.5 4-1.1 7-4 7-8.5V6Z",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
  sparkle:
    "M12 3.5 13.9 9.1 19.5 11 13.9 12.9 12 18.5 10.1 12.9 4.5 11 10.1 9.1ZM18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z",
  trash:
    "M4.5 7h15M10 4.5h4M9.5 11v6M14.5 11v6M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7",
  upload: "M12 15V4M7.5 8.5 12 4l4.5 4.5M4 19h16",
  users:
    "M16.5 20v-1.5a4 4 0 0 0-4-4h-5a4 4 0 0 0-4 4V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM21 20v-1.5a4 4 0 0 0-3-3.87M16.5 4.13a4 4 0 0 1 0 7.75",
  video:
    "M15 10.5 20.5 7v10L15 13.5M4.5 6h9A1.5 1.5 0 0 1 15 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 16.5v-9A1.5 1.5 0 0 1 4.5 6Z",
};

export const ICON_NAMES = Object.keys(ICON_PATHS);

export default function Icon({ name, label, className, size, ...rest }) {
  const path = ICON_PATHS[name];
  if (!path) return null;

  return (
    <svg
      viewBox="0 0 24 24"
      width={size || "1em"}
      height={size || "1em"}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : "true"}
      focusable="false"
      {...rest}
    >
      <path d={path} />
    </svg>
  );
}

/**
 * Product mark: three stacked availability bars inside a rounded tile, with the
 * strongest overlap filled. It reads as "schedule" at 20px without needing a
 * bitmap asset or a network font.
 */
export function BrandMark({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="1.25"
        y="1.25"
        width="21.5"
        height="21.5"
        rx="6.5"
        fill="currentColor"
        opacity="0.12"
      />
      <rect
        x="6"
        y="6.75"
        width="8.5"
        height="3"
        rx="1.5"
        fill="currentColor"
        opacity="0.55"
      />
      <rect x="6" y="10.5" width="12" height="3" rx="1.5" fill="currentColor" />
      <rect
        x="6"
        y="14.25"
        width="6"
        height="3"
        rx="1.5"
        fill="currentColor"
        opacity="0.55"
      />
    </svg>
  );
}
