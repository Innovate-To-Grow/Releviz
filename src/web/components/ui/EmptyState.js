/**
 * Dashed empty-state block with an optional icon, title, description, and
 * actions. Use for "nothing here yet" and "no matches" situations.
 */
export default function EmptyState({
  icon = null,
  title,
  headingLevel = 3,
  children = null,
  actions = null,
  className = "",
  ...props
}) {
  const Heading = `h${headingLevel}`;
  return (
    <div className={`empty-state ${className}`.trim()} {...props}>
      {icon && (
        <span className="empty-state__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {title && <Heading className="empty-state__title h5">{title}</Heading>}
      {children && <div className="empty-state__body">{children}</div>}
      {actions && <div className="empty-state__actions">{actions}</div>}
    </div>
  );
}
