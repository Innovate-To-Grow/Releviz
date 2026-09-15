"use client";

import { ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from "./icons";

const ICONS = {
  success: SuccessIcon,
  danger: ErrorIcon,
  warning: WarningIcon,
  info: InfoIcon,
  primary: InfoIcon,
  secondary: InfoIcon,
  light: InfoIcon,
};

// Defaults keep assistive technology announcements sensible: failures are
// announced assertively, everything else politely.
function defaultRole(variant) {
  return variant === "danger" ? "alert" : "status";
}

/**
 * Bootstrap alert with a consistent icon, optional title, and action row.
 *
 * `role` defaults to "alert" for danger variants and "status" otherwise; pass
 * `role={null}` to render a plain, non-live region (for static notes).
 */
export default function Alert({
  variant = "info",
  role,
  title = null,
  icon = true,
  actions = null,
  className = "",
  as: Component = "div",
  children,
  ...props
}) {
  const Icon = ICONS[variant] || InfoIcon;
  const resolvedRole = role === undefined ? defaultRole(variant) : role;
  const liveProps =
    resolvedRole === "alert"
      ? { role: "alert", "aria-live": "assertive" }
      : resolvedRole === "status"
        ? { role: "status", "aria-live": "polite" }
        : resolvedRole
          ? { role: resolvedRole }
          : {};

  return (
    <Component
      className={`alert alert-${variant} app-alert mb-0 ${className}`.trim()}
      {...liveProps}
      {...props}
    >
      {icon && (
        <span className="app-alert__icon" aria-hidden="true">
          <Icon />
        </span>
      )}
      <div className="app-alert__body">
        {title && <strong className="d-block mb-1">{title}</strong>}
        {children}
        {actions && <div className="app-alert__actions">{actions}</div>}
      </div>
    </Component>
  );
}
