/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import EmailPreview from "@/components/schedule/email/EmailPreview";

const HTML =
  '<!doctype html><html><body><p class="preview-marker">Hello Ada</p><a href="https://example.com/event?invitation=preview">Open the event</a><script>window.previewRan = true;</script></body></html>';

function email(overrides = {}) {
  return {
    from: "Releviz <noreply@releviz.com>",
    replyTo: "",
    to: "Ada Lovelace <ada@example.com>",
    subject: "You're invited to Planning",
    html: HTML,
    text: "Hello Ada,\n\nOpen the event: https://example.com/event?invitation=preview",
    attachments: [],
    ...overrides,
  };
}

// Label/value pairs of the envelope (a definition list), in order.
function envelope() {
  return screen.getAllByRole("term").map((term) => {
    const value = term.nextElementSibling;
    expect(value).toHaveRole("definition");
    return [term.textContent, value.textContent];
  });
}

describe("EmailPreview", () => {
  test("renders nothing without an email", () => {
    const { container } = render(<EmailPreview email={null} note="Shown" />);
    expect(container).toBeEmptyDOMElement();
  });

  test("shows the envelope, the note, and the rendered email in an inert frame", () => {
    render(
      <EmailPreview
        email={email()}
        note="Shown for Ada Lovelace. Each person gets their own private link."
      />,
    );

    expect(envelope()).toEqual([
      ["From", "Releviz <noreply@releviz.com>"],
      ["To", "Ada Lovelace <ada@example.com>"],
      ["Subject", "You're invited to Planning"],
    ]);
    expect(
      screen.getByText(
        "Shown for Ada Lovelace. Each person gets their own private link.",
      ),
    ).toHaveClass("email-preview__note");

    const frame = screen.getByTitle("Email preview");
    expect(frame.tagName).toBe("IFRAME");
    // An empty sandbox: no scripts, top-level navigation, popups or forms.
    expect(frame).toHaveAttribute("sandbox", "");
    // The email as sent, with its links pointed at a new window, which the
    // sandbox refuses to open (see the inert-links test).
    expect(frame.getAttribute("srcdoc")).toBe(
      HTML.replace("<html>", '<html><base target="_blank">'),
    );
    expect(frame).not.toHaveAttribute("src");
    expect(frame).toBeVisible();
    // The email's markup stays inside the frame, never in this page's DOM.
    expect(document.querySelector(".preview-marker")).toBeNull();
    expect(screen.queryByText("Hello Ada")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open the event" }),
    ).not.toBeInTheDocument();
    expect(window.previewRan).toBeUndefined();
  });

  test("keeps the email's links inert and the frame out of the tab order", () => {
    // Without a target, a link in the sandboxed frame navigates the frame
    // itself to a page that refuses to be framed. With every link opening a
    // new window, which the sandbox (no `allow-popups`) blocks, a click does
    // nothing and nothing is requested.
    const branded =
      '<!doctype html>\n<html lang="en">\n  <HEAD data-x="1">\n    <meta charset="utf-8">\n  </HEAD>\n  <body><a href="https://example.com/event?invitation=preview">Share your availability</a></body>\n</html>';
    const { rerender } = render(<EmailPreview email={email({ html: branded })} />);
    const frame = screen.getByTitle("Email preview");
    // First in the head, so it is the base target and the rest of the
    // email is left as it was.
    expect(frame.getAttribute("srcdoc")).toBe(
      branded.replace(
        '<HEAD data-x="1">',
        '<HEAD data-x="1"><base target="_blank">',
      ),
    );
    // Focus never moves into the frame, where the dialog could no longer
    // hear Escape.
    expect(frame).toHaveAttribute("tabindex", "-1");

    // An email with no <head> or <html> still gets the base first.
    const fragments = [
      [
        "<!DOCTYPE html><p>Hi</p>",
        '<!DOCTYPE html><base target="_blank"><p>Hi</p>',
      ],
      ["<p>Hi</p>", '<base target="_blank"><p>Hi</p>'],
      // An element whose name starts with `head` is not the head.
      [
        "<header>Hi</header>",
        '<base target="_blank"><header>Hi</header>',
      ],
    ];
    for (const [html, expected] of fragments) {
      rerender(<EmailPreview email={email({ html })} />);
      expect(
        screen.getByTitle("Email preview").getAttribute("srcdoc"),
      ).toBe(expected);
    }
  });

  test("lists the reply-to address and attachments only when there are any", () => {
    const { rerender } = render(<EmailPreview email={email()} />);
    expect(envelope().map(([label]) => label)).toEqual([
      "From",
      "To",
      "Subject",
    ]);
    expect(document.querySelector(".email-preview__note")).toBeNull();

    rerender(
      <EmailPreview
        email={email({
          replyTo: "Grace Hopper <grace@example.com>",
          attachments: ["meeting.ics", "", "agenda.pdf"],
        })}
      />,
    );
    expect(envelope()).toEqual([
      ["From", "Releviz <noreply@releviz.com>"],
      ["Reply to", "Grace Hopper <grace@example.com>"],
      ["To", "Ada Lovelace <ada@example.com>"],
      ["Subject", "You're invited to Planning"],
      ["Attachments", "meeting.ics, agenda.pdf"],
    ]);

    // A payload without the optional keys still renders the envelope.
    rerender(
      <EmailPreview
        email={{ from: "a@x.com", to: "b@x.com", subject: "Hi", html: "" }}
      />,
    );
    expect(envelope()).toEqual([
      ["From", "a@x.com"],
      ["To", "b@x.com"],
      ["Subject", "Hi"],
    ]);
    expect(screen.getByTitle("Email preview").getAttribute("srcdoc")).toBe("");
  });

  test("switches between the rendered email and the plain-text part", async () => {
    const user = userEvent.setup();
    render(<EmailPreview email={email()} />);

    const tablist = screen.getByRole("tablist", { name: "Email format" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Email", "Plain text"]);
    const [emailTab, textTab] = tabs;
    expect(emailTab).toHaveAttribute("aria-selected", "true");
    expect(emailTab).toHaveAttribute("tabindex", "0");
    expect(textTab).toHaveAttribute("aria-selected", "false");
    expect(textTab).toHaveAttribute("tabindex", "-1");

    const emailPanel = screen.getByRole("tabpanel", { name: "Email" });
    expect(emailPanel).toContainElement(screen.getByTitle("Email preview"));
    expect(emailTab).toHaveAttribute("aria-controls", emailPanel.id);
    expect(
      screen.queryByRole("tabpanel", { name: "Plain text" }),
    ).not.toBeInTheDocument();

    await user.click(textTab);
    expect(textTab).toHaveAttribute("aria-selected", "true");
    expect(emailTab).toHaveAttribute("aria-selected", "false");
    const textPanel = screen.getByRole("tabpanel", { name: "Plain text" });
    expect(textTab).toHaveAttribute("aria-controls", textPanel.id);
    // The scrolling panel can take focus so keyboard users can scroll it.
    expect(textPanel).toHaveAttribute("tabindex", "0");
    const pre = textPanel.querySelector("pre");
    expect(pre).toHaveClass("email-preview__text");
    expect(pre.textContent).toBe(email().text);
    // The frame stays mounted (so it does not reload) but is hidden.
    expect(screen.getByTitle("Email preview")).not.toBeVisible();
    expect(
      screen.queryByRole("tabpanel", { name: "Email" }),
    ).not.toBeInTheDocument();

    await user.click(emailTab);
    expect(screen.getByTitle("Email preview")).toBeVisible();
  });

  test("arrow keys, Home and End move between the tabs", () => {
    render(<EmailPreview email={email()} />);
    const emailTab = screen.getByRole("tab", { name: "Email" });
    const textTab = screen.getByRole("tab", { name: "Plain text" });
    emailTab.focus();

    fireEvent.keyDown(emailTab, { key: "ArrowRight" });
    expect(textTab).toHaveAttribute("aria-selected", "true");
    expect(textTab).toHaveFocus();

    fireEvent.keyDown(textTab, { key: "ArrowRight" });
    expect(emailTab).toHaveAttribute("aria-selected", "true");
    expect(emailTab).toHaveFocus();

    fireEvent.keyDown(emailTab, { key: "ArrowLeft" });
    expect(textTab).toHaveFocus();

    fireEvent.keyDown(textTab, { key: "Home" });
    expect(emailTab).toHaveFocus();

    fireEvent.keyDown(emailTab, { key: "End" });
    expect(textTab).toHaveFocus();
    expect(textTab).toHaveAttribute("aria-selected", "true");

    // Other keys leave the selection alone.
    const other = fireEvent.keyDown(textTab, { key: "a" });
    expect(other).toBe(true);
    expect(textTab).toHaveAttribute("aria-selected", "true");
  });
});
