/**
 * @jest-environment jsdom
 */

import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import Button, { ButtonLink, buttonClassName } from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Icon, { BrandMark, ICON_NAMES } from "@/components/ui/Icon";
import Menu, {
  MenuItem,
  MenuLabel,
  MenuLink,
  MenuSeparator,
} from "@/components/ui/Menu";
import SegmentedControl, {
  ChipGroup,
  ToggleChip,
} from "@/components/ui/Segmented";
import Tabs, { TabPanel } from "@/components/ui/Tabs";
import {
  Badge,
  Callout,
  EmptyState,
  ErrorState,
  LoadingState,
  MetaList,
  ProgressBar,
  Skeleton,
  Spinner,
  Stat,
} from "@/components/ui/Feedback";
import {
  Checkbox,
  Field,
  FieldError,
  Fieldset,
  FormActions,
  Radio,
  Select,
  Switch,
  TextArea,
  TextInput,
} from "@/components/ui/Form";
import {
  Card,
  Disclosure,
  Divider,
  Eyebrow,
  PageHeader,
  SectionHeader,
  Toolbar,
} from "@/components/ui/Surface";

describe("design system: icons", () => {
  test("renders known icons decoratively and labelled icons as images", () => {
    const { container } = render(
      <>
        <Icon name="calendar" className="decorative" />
        <Icon name="mail" label="Email" size="2rem" />
        <Icon name="not-a-real-icon" />
        <BrandMark className="mark" />
      </>,
    );

    expect(container.querySelector("svg.decorative")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    const labelled = screen.getByRole("img", { name: "Email" });
    expect(labelled).toHaveAttribute("width", "2rem");
    expect(container.querySelector("svg.mark")).toBeInTheDocument();
    // Unknown names render nothing rather than an empty box.
    expect(container.querySelectorAll("svg")).toHaveLength(3);
    expect(ICON_NAMES).toContain("refresh");
  });
});

describe("design system: buttons", () => {
  test("defaults to a non-submitting button and forwards handlers", async () => {
    const onClick = jest.fn();
    render(
      <>
        <Button onClick={onClick} aria-pressed="true">
          Save
        </Button>
        <Button type="submit" disabled>
          Cancel
        </Button>
      </>,
    );

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("type", "button");
    expect(save).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(save);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  test("exposes every variant, size and busy state through one class builder", () => {
    render(
      <>
        <Button variant="primary" size="lg" icon="plus" iconEnd="arrowRight">
          Create
        </Button>
        <Button variant="danger" busy>
          Deleting
        </Button>
        <Button
          variant="ghost"
          block
          iconOnly
          icon="close"
          aria-label="Close"
        />
        <Button variant="unknown-variant">Fallback</Button>
        <ButtonLink href="/dashboard" variant="subtle" icon="calendar">
          Dashboard
        </ButtonLink>
      </>,
    );

    expect(screen.getByRole("button", { name: "Create" })).toHaveClass(
      "rv-btn--primary",
      "rv-btn--lg",
    );
    const busyButton = screen.getByRole("button", { name: "Deleting" });
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    expect(busyButton.querySelector(".rv-btn__spinner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
      "rv-btn--block",
      "rv-btn--icon",
    );
    // An unknown variant still renders a usable secondary button.
    expect(screen.getByRole("button", { name: "Fallback" })).toHaveClass(
      "rv-btn--secondary",
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(buttonClassName()).toBe("rv-btn rv-btn--secondary");
    expect(buttonClassName({ size: "sm", className: "extra" })).toContain(
      "extra",
    );
  });
});

describe("design system: form controls", () => {
  test("wires label, hint and error to a single control child", () => {
    render(
      <Field
        label="Email"
        hint="We only use this for verification."
        error="Enter a valid email address."
        required
      >
        <TextInput defaultValue="ada" />
      </Field>,
    );

    const input = screen.getByLabelText("Email");
    expect(input).toHaveAccessibleDescription(
      "We only use this for verification. Enter a valid email address.",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a valid email address.",
    );
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  test("supports render-prop children, explicit ids and hidden labels", () => {
    render(
      <>
        <Field label="Timezone" id="tz" optional>
          {({ id, describedBy, invalid }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            >
              <option value="UTC">UTC</option>
            </Select>
          )}
        </Field>
        <Field label="Search" labelHidden>
          <TextInput id="explicit-search" type="search" />
        </Field>
      </>,
    );

    expect(screen.getByLabelText("Timezone")).toHaveAttribute("id", "tz");
    expect(screen.getByText("Optional")).toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toHaveAttribute(
      "id",
      "explicit-search",
    );
    expect(FieldError({ children: "" })).toBeNull();
  });

  test("renders checkbox, radio, switch and textarea affordances", async () => {
    const onToggle = jest.fn();
    render(
      <Fieldset legend="Notifications">
        <Checkbox
          label="Email me"
          hint="Only for this event."
          onChange={onToggle}
        />
        <Radio name="cadence" label="Weekly" defaultChecked />
        <Switch label="Reminders" hint="Sent before the deadline." />
        <TextArea aria-label="Notes" rows={3} />
        <TextInput size="sm" aria-label="Small" />
        <Select size="sm" aria-label="Small select">
          <option value="a">A</option>
        </Select>
        <FormActions align="start">
          <Button>Apply</Button>
        </FormActions>
      </Fieldset>,
    );

    expect(screen.getByText("Notifications")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Email me/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("radio", { name: /Weekly/ })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: /Reminders/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Small")).toHaveClass("rv-input--sm");
    expect(screen.getByLabelText("Small select")).toHaveClass("rv-select--sm");
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
  });
});

describe("design system: surfaces", () => {
  test("cards, headers and disclosures compose without page-specific styling", async () => {
    const titleRef = { current: null };
    render(
      <Card as="article" tone="accent" raised compact interactive>
        <PageHeader
          eyebrow="Workspace"
          eyebrowIcon="calendar"
          title="Dashboard"
          description="Everything you organize."
          actions={<Button>New</Button>}
          meta={<p>meta row</p>}
        />
        <SectionHeader
          title="Roster"
          titleId="roster-heading"
          titleRef={titleRef}
          description="People and groups."
          badge={<Badge>12</Badge>}
          actions={<Button>Invite</Button>}
        />
        <Divider />
        <Toolbar>
          <Button>Toolbar action</Button>
        </Toolbar>
        <Eyebrow>Plain eyebrow</Eyebrow>
        <Disclosure
          summary={<span>Advanced</span>}
          hint="Rarely needed settings."
        >
          <p>Advanced content</p>
        </Disclosure>
      </Card>,
    );

    const card = screen.getByRole("article");
    expect(card).toHaveClass("rv-card--accent", "rv-card--raised");
    expect(
      screen.getByRole("heading", { level: 1, name: "Dashboard" }),
    ).toBeInTheDocument();
    expect(screen.getByText("meta row")).toBeInTheDocument();
    const sectionHeading = screen.getByRole("heading", { name: /Roster/ });
    expect(sectionHeading).toHaveAttribute("id", "roster-heading");
    expect(sectionHeading).toHaveAttribute("tabindex", "-1");
    expect(titleRef.current).toBe(sectionHeading);

    const details = screen.getByText("Advanced").closest("details");
    expect(details).not.toHaveAttribute("open");
    await userEvent.click(screen.getByText("Advanced"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("Advanced content")).toBeVisible();
  });

  test("card falls back to a plain surface for unknown tones", () => {
    const { container } = render(
      <>
        <Card tone="mystery">plain</Card>
        <Card tone="muted">muted</Card>
        <Card tone="flat">flat</Card>
      </>,
    );
    expect(container.firstChild).toHaveClass("rv-card");
    expect(container.firstChild.className.trim()).toBe("rv-card");
    expect(screen.getByText("muted")).toHaveClass("rv-card--muted");
    expect(screen.getByText("flat")).toHaveClass("rv-card--flat");
  });
});

describe("design system: feedback", () => {
  test("badges keep a text label alongside tone and glyph", () => {
    render(
      <>
        <Badge tone="success" dot icon="checkCircle">
          Submitted
        </Badge>
        <Badge tone="danger">Failed</Badge>
        <Badge tone="warning">Pending</Badge>
        <Badge tone="accent">Organizer</Badge>
        <Badge tone="outline" mono>
          #ABC123
        </Badge>
        <Badge tone="not-a-tone">Neutral</Badge>
      </>,
    );

    expect(screen.getByText("Submitted")).toHaveClass("rv-badge--success");
    expect(screen.getByText("Failed")).toHaveClass("rv-badge--danger");
    expect(screen.getByText("Pending")).toHaveClass("rv-badge--warning");
    expect(screen.getByText("Organizer")).toHaveClass("rv-badge--accent");
    expect(screen.getByText("#ABC123")).toHaveClass("rv-badge--code");
    expect(screen.getByText("Neutral").className.trim()).toBe("rv-badge");
  });

  test("meta lists drop empty values and label each one for screen readers", () => {
    render(
      <MetaList
        items={[
          { label: "Code", value: "ABC123", icon: "link" },
          { label: "Location", value: "" },
          null,
          { label: "Deadline", value: "Tomorrow" },
        ]}
      />,
    );

    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText("Code:")).toHaveClass("rv-visually-hidden");
    expect(screen.queryByText("Location:")).not.toBeInTheDocument();
    expect(screen.getByText("Tomorrow")).toBeInTheDocument();
  });

  test("callouts announce through the element that holds the message", async () => {
    const onAction = jest.fn();
    render(
      <>
        <Callout tone="danger" role="alert">
          Could not save
        </Callout>
        <Callout tone="success" role="status">
          Saved
        </Callout>
        <Callout tone="warning" title="Heads up" bare>
          Reactivate first
        </Callout>
        <Callout
          tone="info"
          actions={<Button onClick={onAction}>Retry</Button>}
        >
          Refreshing
        </Callout>
        <Callout>Neutral note</Callout>
      </>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByText("Heads up")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Neutral note")).toBeInTheDocument();
  });

  test("loading, empty and error states each offer their next step", async () => {
    const onRetry = jest.fn();
    render(
      <>
        <LoadingState />
        <LoadingState inline message="Loading roster…" />
        <Skeleton width="8rem" height="1rem" />
        <Spinner large />
        <EmptyState
          title="No participants yet"
          description="Invite someone to begin."
          action={<Button>Invite</Button>}
        />
        <ErrorState
          description="The network dropped."
          onRetry={onRetry}
          retryLabel="Retry now"
          headingLevel={2}
        />
        <ErrorState description="No retry available" />
      </>,
    );

    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(screen.getByText("Loading roster…")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: "No participants yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Something went wrong" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });

  test("stats and progress bars stay readable without colour", () => {
    render(
      <>
        <Stat label="Submitted" value={12} hint="of 20" tone="accent" />
        <Stat label="Excluded" value={0} />
        <ProgressBar value={5} max={10} label="Delivery" valueText="5 of 10" />
        <ProgressBar value={99} max={0} label="Fallback" tone="success" />
        <ProgressBar value={-4} label="Clamped" tone="warning" />
      </>,
    );

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("of 20")).toBeInTheDocument();
    const delivery = screen.getByRole("progressbar", { name: "Delivery" });
    expect(delivery).toHaveAttribute("aria-valuenow", "5");
    expect(delivery).toHaveAttribute("aria-valuetext", "5 of 10");
    expect(
      screen.getByRole("progressbar", { name: "Fallback" }),
    ).toHaveAttribute("aria-valuemax", "100");
    expect(
      screen
        .getByRole("progressbar", { name: "Clamped" })
        .querySelector(".rv-progress__bar").style.width,
    ).toBe("0%");
  });
});

describe("design system: dialog", () => {
  function DialogHarness({ closeDisabled = false, variant = "modal" }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open dialog</Button>
        <Dialog
          open={open}
          variant={variant}
          wide
          title="Delete event"
          eyebrow="Permanent action"
          description="This cannot be undone."
          closeLabel="Close dialog"
          closeDisabled={closeDisabled}
          onClose={() => setOpen(false)}
          footer={<Button onClick={() => setOpen(false)}>Cancel</Button>}
        >
          <Button>Confirm</Button>
        </Dialog>
      </>
    );
  }

  test("traps focus, closes on Escape and restores focus to the trigger", async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();
    await userEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Delete event" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Permanent action")).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");

    const close = within(dialog).getByRole("button", { name: "Close dialog" });
    expect(close).toHaveFocus();

    // Tab wraps from the last focusable control back to the first.
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(document, { key: "a" });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  test("keeps a drawer open while a save is in flight", async () => {
    render(<DialogHarness closeDisabled variant="drawer" />);
    await userEvent.click(screen.getByRole("button", { name: "Open dialog" }));

    const dialog = screen.getByRole("dialog", { name: "Delete event" });
    expect(dialog).toHaveClass("rv-dialog--drawer", "rv-dialog--wide");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Close dialog" }),
    ).toBeDisabled();
  });
});

describe("design system: menu", () => {
  test("opens with the keyboard, rolls through items and closes on Escape", () => {
    const onSelect = jest.fn();
    render(
      <Menu label="Prachi" triggerIcon="users">
        {({ close }) => (
          <>
            <MenuLabel>prachi@example.com</MenuLabel>
            <MenuLink href="/dashboard" icon="calendar" onClick={close}>
              Dashboard
            </MenuLink>
            <MenuSeparator />
            <MenuItem icon="logOut" danger onClick={onSelect}>
              Log out
            </MenuItem>
          </>
        )}
      </Menu>,
    );

    const trigger = screen.getByRole("button", { name: "Prachi" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const dashboard = screen.getByRole("menuitem", { name: "Dashboard" });
    expect(dashboard).toHaveFocus();
    fireEvent.keyDown(dashboard, { key: "ArrowDown" });
    const logout = screen.getByRole("menuitem", { name: "Log out" });
    expect(logout).toHaveFocus();
    fireEvent.keyDown(logout, { key: "Home" });
    expect(dashboard).toHaveFocus();
    fireEvent.keyDown(dashboard, { key: "End" });
    expect(logout).toHaveFocus();
    fireEvent.keyDown(logout, { key: "ArrowUp" });
    expect(dashboard).toHaveFocus();
    fireEvent.keyDown(dashboard, { key: "x" });

    fireEvent.click(logout);
    expect(onSelect).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test("closes when a pointer press lands outside the menu", () => {
    render(
      <>
        <Menu ariaLabel="Row actions" triggerIconOnly triggerIcon="settings">
          {() => <MenuItem>Duplicate</MenuItem>}
        </Menu>
        <button type="button">Outside</button>
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Row actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("design system: segmented control and tabs", () => {
  test("segmented options report pressed state and disabled options", async () => {
    const onChange = jest.fn();
    render(
      <>
        <SegmentedControl
          label="Availability status"
          block
          value={0.5}
          onChange={onChange}
          options={[
            { label: "Busy", value: 0 },
            { label: "If needed", value: 0.5 },
            { label: "Available", value: 1, disabled: true },
          ]}
        />
        <ChipGroup label="Days">
          <ToggleChip label="Mon" pressed onClick={onChange} />
          <ToggleChip label="Tue" pressed={false} onClick={onChange} disabled />
        </ChipGroup>
      </>,
    );

    const group = screen.getByRole("group", { name: "Availability status" });
    expect(group).toHaveClass("rv-segmented--block");
    expect(
      within(group).getByRole("button", { name: "If needed" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(group).getByRole("button", { name: "Available" }),
    ).toBeDisabled();
    await userEvent.click(within(group).getByRole("button", { name: "Busy" }));
    expect(onChange).toHaveBeenCalledWith(0);

    expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Tue" })).toBeDisabled();
  });

  test("tabs move with arrow keys and label their panel", async () => {
    function TabsHarness() {
      const [active, setActive] = useState("one");
      return (
        <>
          <Tabs
            label="Sections"
            idPrefix="demo"
            activeId={active}
            onChange={setActive}
            tabs={[
              { id: "one", label: "One" },
              { id: "two", label: "Two" },
            ]}
          />
          <TabPanel idPrefix="demo" id={active} className="panel">
            Panel {active}
          </TabPanel>
        </>
      );
    }
    render(<TabsHarness />);

    const first = screen.getByRole("tab", { name: "One" });
    const second = screen.getByRole("tab", { name: "Two" });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");

    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(second).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Two" })).toHaveTextContent(
      "Panel two",
    );
    await userEvent.keyboard("{ArrowLeft}");
    expect(first).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(second).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(first).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(first).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(first).toHaveFocus();
  });
});
