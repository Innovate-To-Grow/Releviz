/**
 * Consistent page heading: optional eyebrow, an h1 (or custom level), a short
 * lede, and a right-aligned action group that wraps under the copy on small
 * screens.
 */
export default function PageHeader({
  eyebrow = null,
  title,
  titleId,
  lede = null,
  actions = null,
  headingLevel = 1,
  className = "",
  children = null,
}) {
  const Heading = `h${headingLevel}`;
  return (
    <header className={`page-header ${className}`.trim()}>
      <div className="page-header__copy">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <Heading id={titleId}>{title}</Heading>
        {lede && <p className="page-header__lede">{lede}</p>}
        {children}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}
