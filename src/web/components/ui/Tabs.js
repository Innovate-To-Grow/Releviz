"use client";

import { useRef } from "react";

/**
 * Roving tablist. Arrow keys move and activate, Home/End jump to the ends, and
 * only the selected tab is in the tab order — the standard APG pattern, in one
 * place so every tabbed surface behaves identically.
 */
export default function Tabs({
  label,
  tabs,
  activeId,
  onChange,
  idPrefix,
  className = "",
}) {
  const tabRefs = useRef({});

  const select = (nextId, { focus = false } = {}) => {
    onChange(nextId);
    if (focus) tabRefs.current[nextId]?.focus();
  };

  const handleKeyDown = (event) => {
    const ids = tabs.map((tab) => tab.id);
    const currentIndex = ids.indexOf(activeId);
    let nextIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % ids.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + ids.length) % ids.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = ids.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    select(ids[nextIndex], { focus: true });
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={`rv-tabs ${className}`.trim()}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="rv-tab"
          id={`${idPrefix}-${tab.id}-tab`}
          aria-controls={`${idPrefix}-${tab.id}-panel`}
          aria-selected={activeId === tab.id}
          tabIndex={activeId === tab.id ? 0 : -1}
          ref={(node) => {
            tabRefs.current[tab.id] = node;
          }}
          onClick={() => select(tab.id)}
          onKeyDown={handleKeyDown}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idPrefix, id, className = "", children }) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-${id}-panel`}
      aria-labelledby={`${idPrefix}-${id}-tab`}
      className={className}
    >
      {children}
    </div>
  );
}
