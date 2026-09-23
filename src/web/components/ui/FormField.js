"use client";

import { cloneElement, isValidElement, useId } from "react";

/**
 * Labelled form control with help text and inline validation.
 *
 * The child control receives `id`, `aria-describedby`, `aria-invalid`, and an
 * `is-invalid` class automatically, so labels, descriptions, and errors are
 * always associated. Pass either a React element or a render function:
 *
 *   <FormField label="Email" error={error}>
 *     <input type="email" className="form-control" />
 *   </FormField>
 *
 *   <FormField label="Weight">{(props) => <input {...props} />}</FormField>
 */
export default function FormField({
  id,
  label,
  labelClassName = "",
  hideLabel = false,
  help = null,
  error = null,
  errorId,
  required = false,
  optional = false,
  className = "",
  children,
  ...props
}) {
  const generatedId = useId();
  const controlId = id || `field-${generatedId}`;
  const helpId = help ? `${controlId}-help` : null;
  const resolvedErrorId = error ? errorId || `${controlId}-error` : null;
  const describedBy = [helpId, resolvedErrorId].filter(Boolean).join(" ");

  const controlProps = {
    id: controlId,
    "aria-describedby": describedBy || undefined,
    ...(error ? { "aria-invalid": "true" } : {}),
  };

  let control = null;
  if (typeof children === "function") {
    control = children(controlProps);
  } else if (isValidElement(children)) {
    const existingClassName = children.props.className || "";
    control = cloneElement(children, {
      ...controlProps,
      "aria-describedby":
        [children.props["aria-describedby"], describedBy]
          .filter(Boolean)
          .join(" ") || undefined,
      ...(error || children.props["aria-invalid"]
        ? {
            "aria-invalid": error ? "true" : children.props["aria-invalid"],
          }
        : {}),
      className: error
        ? `${existingClassName} is-invalid`.trim()
        : existingClassName,
    });
  } else {
    control = children;
  }

  return (
    <div className={`form-field ${className}`.trim()} {...props}>
      <label
        htmlFor={controlId}
        className={`form-label ${hideLabel ? "visually-hidden" : ""} ${labelClassName}`.trim()}
      >
        {label}
        {required && (
          <span className="text-danger ms-1" aria-hidden="true">
            *
          </span>
        )}
        {optional && (
          <span className="text-secondary fw-normal ms-1">(optional)</span>
        )}
      </label>
      {control}
      {help && (
        <div id={helpId} className="form-text">
          {help}
        </div>
      )}
      {error && (
        <div
          id={resolvedErrorId}
          className="invalid-feedback d-block"
          role="alert"
        >
          {error}
        </div>
      )}
    </div>
  );
}
