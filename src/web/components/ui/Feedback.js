"use client";

import Icon from "@/components/ui/Icon";
import Button from "@/components/ui/Button";

const TONE_CLASS = {
  neutral: "",
  accent: "rv-badge--accent",
  success: "rv-badge--success",
  warning: "rv-badge--warning",
  danger: "rv-badge--danger",
  outline: "rv-badge--outline",
};

const CALLOUT_CLASS = {
  neutral: "",
  info: "rv-callout--info",
  success: "rv-callout--success",
  warning: "rv-callout--warning",
  danger: "rv-callout--danger",
};

const CALLOUT_ICON = {
  neutral: "info",
  info: "info",
  success: "checkCircle",
  warning: "alertTriangle",
  danger: "alertCircle",
};

/**
 * Status indicator. Always renders its label as text; the dot and tone are
 * redundant reinforcement, never the only signal.
 */
export function Badge({
  tone = "neutral",
  dot = false,
  icon,
  mono = false,
  className = "",
  children,
  ...props
}) {
  return (
    <span
      className={[
        "rv-badge",
        TONE_CLASS[tone] ?? "",
        mono ? "rv-badge--code" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      {dot && <span className="rv-badge__dot" />}
      {icon && <Icon name={icon} className="rv-badge__glyph" />}
      {children}
    </span>
  );
}

export function MetaList({ items = [], className = "" }) {
  return (
    <div className={`rv-meta ${className}`.trim()}>
      {items
        .filter((item) => item && item.value)
        .map((item) => (
          <span className="rv-meta__item" key={item.label}>
            {item.icon && <Icon name={item.icon} className="rv-meta__icon" />}
            {/* The separator sits outside the hidden label so only the whole
                item reads as "Label: value". */}
            <span className="rv-visually-hidden">{item.label}:</span>{" "}
            <span className="rv-truncate">{item.value}</span>
          </span>
        ))}
    </div>
  );
}

/** Inline message. `role` decides how assistive technology announces it. */
export function Callout({
  tone = "neutral",
  title,
  icon,
  role,
  "aria-live": ariaLive,
  bare = false,
  actions,
  className = "",
  children,
  ...props
}) {
  return (
    <div
      className={[
        "rv-callout",
        CALLOUT_CLASS[tone] ?? "",
        bare ? "rv-callout--bare" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      <Icon
        name={icon || CALLOUT_ICON[tone] || "info"}
        className="rv-callout__icon"
      />
      {/* The live-region role lives on the element that directly holds the
          message, so announcements and visible text never diverge. */}
      <div className="rv-callout__body" role={role} aria-live={ariaLive}>
        {title && <p className="rv-callout__title">{title}</p>}
        {children}
        {actions && <div className="rv-btn-row">{actions}</div>}
      </div>
    </div>
  );
}

export function Spinner({ large = false, className = "" }) {
  return (
    <span
      className={`rv-spinner ${large ? "rv-spinner--lg" : ""} ${className}`.trim()}
      aria-hidden="true"
    />
  );
}

/** Busy state with a live-region message. */
export function LoadingState({
  message = "Loading…",
  inline = false,
  className = "",
}) {
  if (inline) {
    return (
      <p className={`rv-loading-row ${className}`.trim()} role="status">
        <Spinner />
        {message}
      </p>
    );
  }
  return (
    <div
      className={`rv-state rv-state--plain ${className}`.trim()}
      aria-busy="true"
    >
      <Spinner large />
      <p className="rv-state__description" role="status">
        {message}
      </p>
    </div>
  );
}

export function Skeleton({ width, height, className = "" }) {
  return (
    <span
      className={`rv-skeleton ${className}`.trim()}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

/** Empty data. Always offers the next action when one exists. */
export function EmptyState({
  icon = "inbox",
  title,
  description,
  action,
  headingLevel = 3,
  className = "",
}) {
  const Heading = `h${headingLevel}`;
  return (
    <div className={`rv-state ${className}`.trim()}>
      <Icon name={icon} className="rv-state__icon" />
      <Heading className="rv-state__title">{title}</Heading>
      {description && <p className="rv-state__description">{description}</p>}
      {action}
    </div>
  );
}

/** Failure with a retry affordance. */
export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  retryLabel = "Try again",
  retrying = false,
  headingLevel = 3,
  className = "",
}) {
  const Heading = `h${headingLevel}`;
  return (
    <div
      className={`rv-state rv-state--danger ${className}`.trim()}
      role="alert"
    >
      <Icon name="alertTriangle" className="rv-state__icon" />
      <Heading className="rv-state__title">{title}</Heading>
      {description && <p className="rv-state__description">{description}</p>}
      {onRetry && (
        <Button
          variant="secondary"
          icon="refresh"
          onClick={onRetry}
          busy={retrying}
        >
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

export function Stat({ label, value, hint, tone = "default", className = "" }) {
  return (
    <div
      className={`rv-stat ${tone === "accent" ? "rv-stat--accent" : ""} ${className}`.trim()}
    >
      <span className="rv-stat__label">{label}</span>
      <span className="rv-stat__value">{value}</span>
      {hint && <span className="rv-stat__hint">{hint}</span>}
    </div>
  );
}

export function ProgressBar({
  value = 0,
  max = 100,
  label,
  tone = "accent",
  valueText,
  className = "",
}) {
  const safeMax = max > 0 ? max : 100;
  const percent = Math.min(100, Math.max(0, (value / safeMax) * 100));
  return (
    <div
      className={[
        "rv-progress",
        tone === "success" ? "rv-progress--success" : "",
        tone === "warning" ? "rv-progress--warning" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className="rv-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuetext={valueText}
      >
        <div className="rv-progress__bar" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
