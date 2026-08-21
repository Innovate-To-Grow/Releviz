/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { useContext } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import DemoEventPage from "@/components/event/DemoEventPage";
import EventContext from "@/components/event/EventContext";
import { DEMO_EVENT, DEMO_ORGANIZER } from "@/lib/demo/eventData";

jest.mock(
  "@/components/event/EventHeader",
  () =>
    function MockEventHeader({ eventName, eventCode, isOrganizer }) {
      return (
        <header>
          {eventName} · {eventCode} ·{" "}
          {isOrganizer ? "Organizer" : "Participant"}
        </header>
      );
    },
);

jest.mock(
  "@/components/schedule/OrganizerScaleView",
  () =>
    function MockOrganizerScaleView() {
      const { event, isOrganizer, numSlots } = useContext(EventContext);
      const { user, loading, getToken } = useAuth();
      return (
        <section>
          <span>{event.name}</span>
          <span>{user.displayName}</span>
          <span>{`${isOrganizer}:${numSlots}:${loading}`}</span>
          <button type="button" onClick={() => void getToken()}>
            Read demo token
          </button>
        </section>
      );
    },
);

test("renders the real workspace boundary with local organizer and event contexts", () => {
  render(<DemoEventPage />);

  expect(screen.getByRole("note", { name: "" })).toHaveTextContent(
    "All people, responses, and delivery details below are sample data",
  );
  expect(screen.getByRole("banner")).toHaveTextContent(DEMO_EVENT.name);
  expect(screen.getByText(DEMO_EVENT.name)).toBeInTheDocument();
  expect(screen.getByText(DEMO_ORGANIZER.displayName)).toBeInTheDocument();
  expect(
    screen.getByText(`true:${DEMO_EVENT.slotCount}:false`),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Read demo token" })).toBeEnabled();
});
