/**
 * Spinner plus label for loading states. `page` centers it in the viewport.
 * The label is exposed as a polite status message.
 */
export default function LoadingState({
  label = "Loading…",
  page = false,
  className = "",
  as: Component = "div",
  ...props
}) {
  return (
    <Component
      className={`loading-state ${page ? "loading-state--page" : ""} ${className}`.trim()}
      role="status"
      aria-live="polite"
      aria-busy="true"
      {...props}
    >
      <span className="spinner-border spinner-border-sm" aria-hidden="true" />
      <span>{label}</span>
    </Component>
  );
}
