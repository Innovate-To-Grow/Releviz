"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import AppButton from "@/components/ui/AppButton";
import { ChevronDownIcon } from "@/components/ui/icons";

/**
 * Open/close state for a dropdown rendered by React (no Bootstrap JS): a
 * pointer press outside closes it, and `close()` gives focus back to the
 * trigger. Escape is handled on the root element so a popover inside a
 * drawer closes itself without also closing the drawer.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const id = useId();

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const handleRootKeyDown = useCallback(
    (event) => {
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
    [close, open],
  );

  return {
    open,
    setOpen,
    close,
    rootRef,
    triggerRef,
    id: `${id}-popover`,
    handleRootKeyDown,
  };
}

const MENU_ITEM = '[role="menuitem"]:not([disabled])';

/** Above the drawer and modal layers and the toast region (participants.css). */
export const MENU_Z_INDEX = 1060;

/**
 * Generic dropdown menu on the pattern of the account menu: the trigger
 * announces `aria-haspopup="menu"`, ArrowDown/ArrowUp open it with the
 * first/last item focused, arrows and Home/End move between items, Escape
 * closes and refocuses the trigger, and choosing an item closes the menu
 * before calling its `onSelect`.
 */
export default function MenuButton({
  label,
  icon = null,
  variant = "outlined",
  size = "md",
  ariaLabel,
  align = "end",
  items = [],
  header = null,
  disabled = false,
  busy = false,
  className = "",
  menuClassName = "",
  caret = true,
}) {
  const { open, setOpen, close, rootRef, triggerRef, id, handleRootKeyDown } =
    usePopover();
  const focusOnOpenRef = useRef(null);
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState(null);
  const visibleItems = items.filter((item) => item && !item.hidden);

  // The menu is fixed to the viewport so it can open past the edge of a
  // scrolling table or drawer body instead of being clipped by it. It opens
  // upward when there is no room below, and follows the trigger on scroll.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const menuHeight = menu.offsetHeight;
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;
      const below = rect.bottom + 4;
      const openUp =
        below + menuHeight > viewportHeight - 8 &&
        rect.top - menuHeight - 4 > 8;
      // Every edge is set so the stylesheet's absolute placement (top and
      // right for an end-aligned menu) cannot combine with these values.
      const style = { position: "fixed", zIndex: MENU_Z_INDEX };
      if (openUp) {
        style.bottom = viewportHeight - rect.top + 4;
        style.top = "auto";
      } else {
        style.top = below;
        style.bottom = "auto";
      }
      if (align === "end") {
        style.right = Math.max(8, viewportWidth - rect.right);
        style.left = "auto";
      } else {
        style.left = Math.max(8, rect.left);
        style.right = "auto";
      }
      setMenuStyle(style);
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      setMenuStyle(null);
    };
  }, [open, align, triggerRef]);

  useEffect(() => {
    if (!open || !focusOnOpenRef.current) return;
    const position = focusOnOpenRef.current;
    focusOnOpenRef.current = null;
    const menuItems = rootRef.current?.querySelectorAll(MENU_ITEM) ?? [];
    const target =
      position === "last" ? menuItems[menuItems.length - 1] : menuItems[0];
    target?.focus();
  }, [open, rootRef]);

  const handleTriggerKeyDown = (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const position = event.key === "ArrowDown" ? "first" : "last";
    if (open) {
      const menuItems = rootRef.current?.querySelectorAll(MENU_ITEM) ?? [];
      const target =
        position === "first" ? menuItems[0] : menuItems[menuItems.length - 1];
      target?.focus();
      return;
    }
    focusOnOpenRef.current = position;
    setOpen(true);
  };

  const handleMenuKeyDown = (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const menuItems = [...(rootRef.current?.querySelectorAll(MENU_ITEM) ?? [])];
    if (!menuItems.length) return;
    event.preventDefault();
    const currentIndex = menuItems.indexOf(document.activeElement);
    let nextIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = menuItems.length - 1;
    else if (event.key === "ArrowDown")
      nextIndex = (currentIndex + 1) % menuItems.length;
    else
      nextIndex = currentIndex <= 0 ? menuItems.length - 1 : currentIndex - 1;
    menuItems[nextIndex].focus();
  };

  return (
    <div
      ref={rootRef}
      className={`dropdown participants-menu${open ? " show" : ""} ${className}`.trim()}
      onKeyDown={handleRootKeyDown}
    >
      <AppButton
        ref={triggerRef}
        variant={variant}
        size={size}
        icon={icon}
        busy={busy}
        disabled={disabled || busy}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        {label}
        {caret && (
          <span className="app-btn-icon ms-1" aria-hidden="true">
            <ChevronDownIcon size="0.75em" />
          </span>
        )}
      </AppButton>
      {open && (
        <div
          id={id}
          ref={menuRef}
          style={menuStyle || undefined}
          className={`dropdown-menu${align === "end" ? " dropdown-menu-end" : ""} show ${menuClassName}`.trim()}
          role="menu"
          aria-label={typeof label === "string" ? label : ariaLabel}
          onKeyDown={handleMenuKeyDown}
        >
          {header && (
            <>
              <div className="dropdown-header participants-menu__header">
                {header}
              </div>
              <div className="dropdown-divider" />
            </>
          )}
          {visibleItems.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={`dropdown-item d-flex align-items-start gap-2${item.danger ? " text-danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onSelect?.();
              }}
            >
              {item.icon && (
                <span className="app-btn-icon mt-1" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              <span className="min-w-0">
                {item.label}
                {item.description && (
                  <span className="d-block small text-secondary text-wrap">
                    {item.description}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The ⋯ menu at the end of a row: a text button whose name is `ariaLabel`. */
export function IconMenuButton({
  ariaLabel,
  size = "sm",
  className = "",
  ...props
}) {
  return (
    <MenuButton
      variant="text"
      size={size}
      ariaLabel={ariaLabel}
      caret={false}
      className={`participants-menu--icon ${className}`.trim()}
      label={
        <span className="participants-menu__glyph" aria-hidden="true">
          ⋯
        </span>
      }
      {...props}
    />
  );
}
