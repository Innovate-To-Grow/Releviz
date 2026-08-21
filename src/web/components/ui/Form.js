"use client";

import { Children, cloneElement, isValidElement, useId } from "react";
import Icon from "@/components/ui/Icon";

function joinIds(...ids) {
  const value = ids.filter(Boolean).join(" ");
  return value || undefined;
}

/**
 * Label + control + hint + error, wired together.
 *
 * `children` may be a render function that receives the generated ids, or a
 * single control element that gets `id`, `aria-describedby` and `aria-invalid`
 * injected. Either way the accessible wiring is identical, so no screen can
 * forget to associate its error message.
 */
export function Field({
  label,
  hint,
  error,
  id,
  required = false,
  optional = false,
  labelHidden = false,
  className = "",
  children,
}) {
  const generatedId = useId();
  // A control that already carries an id keeps it, so the label still points at
  // the right element when a caller needs a stable id.
  const explicitId =
    typeof children !== "function" && isValidElement(children)
      ? children.props.id
      : undefined;
  const controlId = id || explicitId || `rv-${generatedId}`;
  const hintId = hint ? `${controlId}-hint` : "";
  const errorId = error ? `${controlId}-error` : "";
  const describedBy = joinIds(hintId, errorId);
  const invalid = error ? "true" : undefined;

  const control =
    typeof children === "function"
      ? children({ id: controlId, describedBy, invalid })
      : Children.map(children, (child) =>
          isValidElement(child)
            ? cloneElement(child, {
                id: child.props.id || controlId,
                "aria-describedby": joinIds(
                  child.props["aria-describedby"],
                  describedBy,
                ),
                "aria-invalid": child.props["aria-invalid"] ?? invalid,
              })
            : child,
        );

  return (
    <div className={`rv-field ${className}`.trim()}>
      {/* The marker sits outside <label> so the accessible name stays exactly
          the field name. */}
      <span
        className={
          labelHidden ? "rv-visually-hidden" : "rv-cluster rv-cluster--sm"
        }
      >
        <label className="rv-field__label" htmlFor={controlId}>
          {label}
        </label>
        {required && <span className="rv-field__optional">Required</span>}
        {optional && <span className="rv-field__optional">Optional</span>}
      </span>
      {control}
      {hint && (
        <p className="rv-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

export function FieldError({ id, children }) {
  if (!children) return null;
  // The message text is a direct child so the announced node and the visible
  // node are the same element.
  return (
    <p className="rv-field__error" id={id} role="alert">
      <Icon name="alertCircle" className="rv-field__error-icon" />
      {children}
    </p>
  );
}

export function TextInput({ className = "", size = "md", ...props }) {
  return (
    <input
      className={`rv-input ${size === "sm" ? "rv-input--sm" : ""} ${className}`.trim()}
      {...props}
    />
  );
}

export function TextArea({ className = "", ...props }) {
  return <textarea className={`rv-textarea ${className}`.trim()} {...props} />;
}

export function Select({ className = "", size = "md", children, ...props }) {
  return (
    <select
      className={`rv-select ${size === "sm" ? "rv-select--sm" : ""} ${className}`.trim()}
      {...props}
    >
      {children}
    </select>
  );
}

/**
 * Checkbox with its own label. `hint` renders a second line inside the label so
 * the explanation is part of the clickable target and the accessible name.
 */
export function Checkbox({
  label,
  hint,
  className = "",
  tight = false,
  ...props
}) {
  return (
    <label
      className={`rv-check ${tight ? "rv-check--tight" : ""} ${className}`.trim()}
    >
      <input type="checkbox" {...props} />
      <span className="rv-check__text">
        <span className="rv-check__title">{label}</span>
        {hint && <span className="rv-check__hint">{hint}</span>}
      </span>
    </label>
  );
}

export function Radio({ label, hint, className = "", ...props }) {
  return (
    <label className={`rv-check ${className}`.trim()}>
      <input type="radio" {...props} />
      <span className="rv-check__text">
        <span className="rv-check__title">{label}</span>
        {hint && <span className="rv-check__hint">{hint}</span>}
      </span>
    </label>
  );
}

export function Switch({ label, hint, className = "", ...props }) {
  return (
    <label className={`rv-switch ${className}`.trim()}>
      <span className="rv-check__text">
        <span className="rv-check__title">{label}</span>
        {hint && <span className="rv-check__hint">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" {...props} />
    </label>
  );
}

export function Fieldset({ legend, className = "", children, ...props }) {
  return (
    <fieldset className={`rv-fieldset ${className}`.trim()} {...props}>
      <legend className="rv-fieldset__legend">{legend}</legend>
      {children}
    </fieldset>
  );
}

export function FormActions({ className = "", align = "end", children }) {
  return (
    <div
      className={`rv-btn-row rv-btn-row--stack ${
        align === "end" ? "rv-btn-row--end" : ""
      } ${className}`.trim()}
    >
      {children}
    </div>
  );
}
