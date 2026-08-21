"use client";

import Link from "next/link";
import Icon from "@/components/ui/Icon";

const VARIANT_CLASS = {
  primary: "rv-btn--primary",
  secondary: "rv-btn--secondary",
  subtle: "rv-btn--subtle",
  ghost: "rv-btn--ghost",
  danger: "rv-btn--danger",
  dangerOutline: "rv-btn--danger-outline",
  link: "rv-btn--link",
};

const SIZE_CLASS = { sm: "rv-btn--sm", md: "", lg: "rv-btn--lg" };

export function buttonClassName({
  variant = "secondary",
  size = "md",
  block = false,
  iconOnly = false,
  className = "",
} = {}) {
  return [
    "rv-btn",
    VARIANT_CLASS[variant] ?? VARIANT_CLASS.secondary,
    SIZE_CLASS[size] ?? "",
    block ? "rv-btn--block" : "",
    iconOnly ? "rv-btn--icon" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

function ButtonContent({ icon, iconEnd, busy, children }) {
  return (
    <>
      {busy ? (
        <span className="rv-btn__spinner" aria-hidden="true" />
      ) : (
        icon && <Icon name={icon} className="rv-btn__icon" />
      )}
      {children}
      {iconEnd && <Icon name={iconEnd} className="rv-btn__icon" />}
    </>
  );
}

/**
 * The only button in the product. Every affordance — primary action, quiet
 * action, destructive action, toggle, icon button — is a variant of this
 * component so that focus, sizing, disabled contrast and touch targets stay
 * identical everywhere.
 */
export default function Button({
  type = "button",
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  block = false,
  iconOnly = false,
  busy = false,
  className,
  children,
  ...props
}) {
  return (
    <button
      type={type}
      className={buttonClassName({ variant, size, block, iconOnly, className })}
      aria-busy={busy || undefined}
      {...props}
    >
      <ButtonContent icon={icon} iconEnd={iconEnd} busy={busy}>
        {children}
      </ButtonContent>
    </button>
  );
}

/** A `next/link` that looks and sizes exactly like a Button. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  block = false,
  iconOnly = false,
  className,
  children,
  ...props
}) {
  return (
    <Link
      className={buttonClassName({ variant, size, block, iconOnly, className })}
      {...props}
    >
      <ButtonContent icon={icon} iconEnd={iconEnd}>
        {children}
      </ButtonContent>
    </Link>
  );
}
