"use client";

function AppButton({
  variant = "filled",
  icon = null,
  fullWidth = false,
  className = "",
  type = "button",
  children,
  ...props
}) {
  const classes = ["app-btn", `app-btn-${variant}`, fullWidth ? "app-btn-full" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <button type={type} className={classes} {...props}>
      {icon && (
        <span className="app-btn-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="app-btn-label">{children}</span>
    </button>
  );
}

export default AppButton;
