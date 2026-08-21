"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Icon from "@/components/ui/Icon";

/**
 * Popup menu with the keyboard contract users expect: Arrow keys open it and
 * move between items, Home/End jump to the ends, Escape closes it and returns
 * focus to the trigger, and a pointer press outside dismisses it.
 *
 * `children` is called with `{ close }` so items can dismiss the menu after
 * running their action.
 */
export default function Menu({
  label,
  ariaLabel,
  triggerVariant = "ghost",
  triggerSize = "md",
  triggerIcon,
  triggerIconEnd = "chevronDown",
  triggerIconOnly = false,
  triggerClassName,
  className = "",
  children,
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const keyboardOpeningRef = useRef(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;

    const closeOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target))
        setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    if (keyboardOpeningRef.current) {
      keyboardOpeningRef.current = false;
      menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    }

    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const handleMenuKeyDown = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    const items = [
      ...(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? []),
    ];
    if (!items.length) return;

    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement);
    let nextIndex;

    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    else if (event.key === "ArrowDown")
      nextIndex = (currentIndex + 1) % items.length;
    else nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;

    items[nextIndex]?.focus();
  };

  return (
    <div className={`rv-menu ${className}`.trim()} ref={menuRef}>
      <Button
        ref={triggerRef}
        variant={triggerVariant}
        size={triggerSize}
        icon={triggerIcon}
        iconEnd={triggerIconOnly ? undefined : triggerIconEnd}
        iconOnly={triggerIconOnly}
        className={triggerClassName}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          keyboardOpeningRef.current = true;
          setOpen(true);
        }}
      >
        {label}
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="rv-menu__panel"
          onKeyDown={handleMenuKeyDown}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  );
}

export function MenuLabel({ children }) {
  return (
    <p className="rv-menu__label" role="presentation">
      {children}
    </p>
  );
}

export function MenuSeparator() {
  return <div className="rv-menu__separator" role="separator" />;
}

export function MenuLink({ icon, children, className = "", ...props }) {
  return (
    <Link
      role="menuitem"
      className={`rv-menu__item ${className}`.trim()}
      {...props}
    >
      {icon && <Icon name={icon} className="rv-menu__icon" />}
      {children}
    </Link>
  );
}

export function MenuItem({
  icon,
  danger = false,
  className = "",
  children,
  ...props
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={[
        "rv-menu__item",
        danger ? "rv-menu__item--danger" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      {icon && <Icon name={icon} className="rv-menu__icon" />}
      {children}
    </button>
  );
}
