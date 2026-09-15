"use client";

import { forwardRef } from "react";

// Semantic variants map to Bootstrap button styles so every screen shares one
// primary/secondary/tertiary/destructive hierarchy.
const VARIANT_CLASS = {
  filled: "btn-primary",
  primary: "btn-primary",
  outlined: "btn-outline-secondary",
  secondary: "btn-outline-secondary",
  text: "btn-link",
  danger: "btn-outline-danger",
  "danger-filled": "btn-danger",
  success: "btn-success",
};

const SIZE_CLASS = {
  sm: "btn-sm",
  md: "",
  lg: "btn-lg",
};

const AppButton = forwardRef(function AppButton(
  {
    variant = "filled",
    size = "md",
    icon = null,
    fullWidth = false,
    className = "",
    type = "button",
    busy = false,
    children,
    ...props
  },
  ref,
) {
  // The legacy `app-btn-danger` modifier still selects the destructive style.
  const resolvedVariant =
    className.split(/\s+/).includes("app-btn-danger") && variant !== "filled"
      ? "danger"
      : variant;
  const classes = [
    "btn",
    "app-btn",
    VARIANT_CLASS[resolvedVariant] || VARIANT_CLASS.filled,
    SIZE_CLASS[size] || "",
    `app-btn-${variant}`,
    fullWidth ? "app-btn-full w-100" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? (
        <span
          className="spinner-border spinner-border-sm app-btn-icon"
          aria-hidden="true"
        />
      ) : (
        icon && (
          <span className="app-btn-icon" aria-hidden="true">
            {icon}
          </span>
        )
      )}
      <span className="app-btn-label">{children}</span>
    </button>
  );
});

export default AppButton;
