import { forwardRef } from "react";

/**
 * White content surface (Bootstrap card) with an optional heading row.
 *
 * - `title` renders as the heading level given by `headingLevel` (default h2)
 *   and can be focused programmatically through `headingRef` / `headingProps`.
 * - `description` renders muted copy under the title.
 * - `actions` render on the right of the heading row and wrap on small screens.
 * - `footer` renders inside a bordered card footer.
 */
const Panel = forwardRef(function Panel(
  {
    as: Component = "section",
    title = null,
    titleId,
    headingLevel = 2,
    headingRef,
    headingProps = {},
    description = null,
    actions = null,
    footer = null,
    className = "",
    bodyClassName = "",
    children,
    ...props
  },
  ref,
) {
  const Heading = `h${headingLevel}`;
  const hasHeader = Boolean(title || description || actions);
  return (
    <Component
      ref={ref}
      className={`card panel ${className}`.trim()}
      {...props}
    >
      <div className={`card-body ${bodyClassName}`.trim()}>
        {hasHeader && (
          <div className="panel__header">
            <div className="panel__heading">
              {title && (
                <Heading
                  id={titleId}
                  ref={headingRef}
                  className="panel__title h3"
                  {...headingProps}
                >
                  {title}
                </Heading>
              )}
              {description && (
                <p className="panel__description">{description}</p>
              )}
            </div>
            {actions && <div className="panel__actions">{actions}</div>}
          </div>
        )}
        {children}
      </div>
      {footer && <div className="card-footer">{footer}</div>}
    </Component>
  );
});

export default Panel;
