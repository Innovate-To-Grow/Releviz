"use client";

import { useId, useRef, useState } from "react";

const TABS = [
  { key: "html", label: "Email" },
  { key: "text", label: "Plain text" },
];

const TAB_KEYS = TABS.map((tab) => tab.key);

// Where the preview's `<base>` goes: first in the head, so it is the one that
// counts; failing that, as early as the markup allows.
const BASE_AFTER = [
  /<head(?:\s[^>]*)?>/i,
  /<html(?:\s[^>]*)?>/i,
  /<!doctype[^>]*>/i,
];
const INERT_LINKS = '<base target="_blank">';

// The email's HTML for display only, with every link aimed at a new window.
// The frame's sandbox has no `allow-popups`, so the browser refuses to open
// one and a click does nothing. Without it a link would navigate the frame
// itself to the (unframeable) event page and leave an error page in its
// place. What is sent is unchanged.
function inertLinks(html) {
  if (!html) return "";
  for (const pattern of BASE_AFTER) {
    const match = pattern.exec(html);
    if (match) {
      const at = match.index + match[0].length;
      return `${html.slice(0, at)}${INERT_LINKS}${html.slice(at)}`;
    }
  }
  return `${INERT_LINKS}${html}`;
}

/**
 * One email exactly as a recipient gets it: the envelope (From, Reply to when
 * set, To, Subject, and Attachments when there are any), an optional `note`
 * under it, and an `Email` / `Plain text` tab pair for the two parts.
 *
 * The HTML part is handed to an iframe through `srcDoc` with an empty
 * `sandbox`, so the email's markup never enters this page's DOM and it can't
 * run scripts, submit forms, open popups or navigate the page. Its links are
 * aimed at a new window, which the sandbox blocks, so they are inert too. The
 * frame is kept out of the tab order: focus inside it would take keys away
 * from the dialog, Escape included. Both panels stay mounted so switching
 * tabs doesn't reload the frame.
 *
 * `email` is the preview payload from the API
 * (`{ from, replyTo, to, subject, html, text, attachments }`); `null`
 * renders nothing.
 */
export default function EmailPreview({ email, note = null }) {
  const [tab, setTab] = useState("html");
  const tabRefs = useRef({});
  const baseId = useId();

  if (!email) return null;

  const attachments = (email.attachments || []).filter(Boolean);
  const tabId = (key) => `${baseId}-${key}-tab`;
  const panelId = (key) => `${baseId}-${key}-panel`;

  const handleTabKeyDown = (keyEvent) => {
    const current = TAB_KEYS.indexOf(tab);
    let next;
    if (keyEvent.key === "ArrowRight") {
      next = (current + 1) % TAB_KEYS.length;
    } else if (keyEvent.key === "ArrowLeft") {
      next = (current - 1 + TAB_KEYS.length) % TAB_KEYS.length;
    } else if (keyEvent.key === "Home") {
      next = 0;
    } else if (keyEvent.key === "End") {
      next = TAB_KEYS.length - 1;
    } else {
      return;
    }
    keyEvent.preventDefault();
    setTab(TAB_KEYS[next]);
    tabRefs.current[TAB_KEYS[next]]?.focus();
  };

  return (
    <div className="email-preview">
      <dl className="email-preview__envelope">
        <div className="email-preview__field">
          <dt>From</dt>
          <dd>{email.from}</dd>
        </div>
        {email.replyTo && (
          <div className="email-preview__field">
            <dt>Reply to</dt>
            <dd>{email.replyTo}</dd>
          </div>
        )}
        <div className="email-preview__field">
          <dt>To</dt>
          <dd>{email.to}</dd>
        </div>
        <div className="email-preview__field">
          <dt>Subject</dt>
          <dd className="email-preview__subject">{email.subject}</dd>
        </div>
        {attachments.length > 0 && (
          <div className="email-preview__field">
            <dt>Attachments</dt>
            <dd>{attachments.join(", ")}</dd>
          </div>
        )}
      </dl>
      {note && <p className="email-preview__note">{note}</p>}
      <div className="email-preview__body">
        <ul
          className="nav nav-tabs email-preview__tabs"
          role="tablist"
          aria-label="Email format"
        >
          {TABS.map(({ key, label }) => (
            <li className="nav-item" role="presentation" key={key}>
              <button
                type="button"
                role="tab"
                className={`nav-link${tab === key ? " active" : ""}`}
                id={tabId(key)}
                aria-controls={panelId(key)}
                aria-selected={tab === key}
                tabIndex={tab === key ? 0 : -1}
                ref={(node) => {
                  tabRefs.current[key] = node;
                }}
                onClick={() => setTab(key)}
                onKeyDown={handleTabKeyDown}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
        <div
          role="tabpanel"
          id={panelId("html")}
          aria-labelledby={tabId("html")}
          hidden={tab !== "html"}
        >
          <iframe
            title="Email preview"
            className="email-preview__frame"
            sandbox=""
            tabIndex={-1}
            srcDoc={inertLinks(email.html)}
          />
        </div>
        {/* The text panel scrolls and has no controls of its own, so it takes
            focus itself for keyboard scrolling. */}
        <div
          role="tabpanel"
          id={panelId("text")}
          aria-labelledby={tabId("text")}
          className="email-preview__text-panel"
          hidden={tab !== "text"}
          tabIndex={0}
        >
          <pre className="email-preview__text">{email.text}</pre>
        </div>
      </div>
    </div>
  );
}
