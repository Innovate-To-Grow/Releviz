// Shared vocabulary for lifecycle, response, and delivery states so the same
// state always uses the same color and wording everywhere.
const TONES = {
  // Event lifecycle
  active: "success",
  closed: "warning",
  finalized: "primary",
  archived: "secondary",
  // Participant response
  submitted: "success",
  "not-submitted": "secondary",
  draft: "info",
  // Invitation delivery
  sent: "info",
  accepted: "success",
  "not-sent": "secondary",
  // Generic
  success: "success",
  info: "info",
  warning: "warning",
  danger: "danger",
  neutral: "secondary",
  primary: "primary",
};

function toneFor(status) {
  const key = String(status || "")
    .toLowerCase()
    .replaceAll("_", "-");
  return TONES[key] || "secondary";
}

/**
 * Subtle Bootstrap badge with a colored dot. `status` chooses the tone;
 * `children` (or `label`) provides the text.
 */
export default function StatusBadge({
  status = "neutral",
  label,
  dot = true,
  className = "",
  children,
  ...props
}) {
  const tone = toneFor(status);
  const text = children ?? label ?? status;
  const singleWord = typeof text === "string" && !/\s/.test(text.trim());
  return (
    <span
      className={`badge rounded-pill status-badge${singleWord ? " status-badge--word" : ""} bg-${tone}-subtle text-${tone}-emphasis border border-${tone}-subtle ${className}`.trim()}
      {...props}
    >
      {dot && <span className="status-badge__dot" aria-hidden="true" />}
      {text}
    </span>
  );
}

export { toneFor };
