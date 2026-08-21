"use client";

import Icon from "@/components/ui/Icon";

const CARD_TONE = {
  default: "",
  muted: "rv-card--muted",
  accent: "rv-card--accent",
  flat: "rv-card--flat",
};

/** The single container surface. Sections never draw their own borders. */
export function Card({
  tone = "default",
  raised = false,
  compact = false,
  interactive = false,
  as: Tag = "div",
  className = "",
  children,
  ...props
}) {
  return (
    <Tag
      className={[
        "rv-card",
        CARD_TONE[tone] ?? "",
        raised ? "rv-card--raised" : "",
        compact ? "rv-card--compact" : "",
        interactive ? "rv-card--interactive" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      {children}
    </Tag>
  );
}

export function Eyebrow({ icon, className = "", children }) {
  return (
    <p className={`rv-eyebrow ${className}`.trim()}>
      {icon && <Icon name={icon} />}
      {children}
    </p>
  );
}

/** Top-of-page identity: eyebrow, title, one-line explanation, page actions. */
export function PageHeader({
  eyebrow,
  eyebrowIcon,
  title,
  titleId,
  description,
  actions,
  meta,
  plain = false,
  as: Tag = "h1",
  className = "",
}) {
  return (
    <header
      className={`rv-page-header ${plain ? "rv-page-header--plain" : ""} ${className}`.trim()}
    >
      <div className="rv-split">
        <div className="rv-stack rv-stack--sm rv-fill">
          {eyebrow && <Eyebrow icon={eyebrowIcon}>{eyebrow}</Eyebrow>}
          <Tag className="rv-page-header__title" id={titleId}>
            {title}
          </Tag>
          {description && <p className="rv-page-header__lede">{description}</p>}
        </div>
        {actions && <div className="rv-btn-row">{actions}</div>}
      </div>
      {meta}
    </header>
  );
}

/** Header for a section inside a page. */
export function SectionHeader({
  title,
  titleId,
  titleRef,
  description,
  actions,
  badge,
  as: Tag = "h2",
  className = "",
  ...props
}) {
  return (
    <div className={`rv-section-header ${className}`.trim()} {...props}>
      <div className="rv-section-header__text">
        <Tag
          className="rv-section-header__title"
          id={titleId}
          ref={titleRef}
          tabIndex={titleRef ? -1 : undefined}
        >
          {title}
          {badge}
        </Tag>
        {description && (
          <p className="rv-section-header__description">{description}</p>
        )}
      </div>
      {actions && <div className="rv-section-header__actions">{actions}</div>}
    </div>
  );
}

export function Divider({ className = "" }) {
  return <hr className={`rv-divider ${className}`.trim()} />;
}

export function Toolbar({ className = "", children, ...props }) {
  return (
    <div className={`rv-btn-row ${className}`.trim()} {...props}>
      {children}
    </div>
  );
}

/**
 * Progressive disclosure built on native <details> so deep links, find-in-page
 * and keyboard operation all keep working.
 */
export function Disclosure({
  summary,
  hint,
  className = "",
  children,
  ...props
}) {
  return (
    <details className={`rv-disclosure ${className}`.trim()} {...props}>
      <summary className="rv-disclosure__summary">
        <span className="rv-disclosure__summary-text">
          {summary}
          {hint && <span className="rv-disclosure__hint">{hint}</span>}
        </span>
        <Icon name="chevronDown" className="rv-disclosure__chevron" />
      </summary>
      <div className="rv-disclosure__content">{children}</div>
    </details>
  );
}
