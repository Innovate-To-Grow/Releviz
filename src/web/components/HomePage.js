"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import FormField from "@/components/ui/FormField";
import Panel from "@/components/ui/Panel";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  AddIcon,
  ArrowRightIcon,
  BestIcon,
  GroupIcon,
  LinkIcon,
  SearchIcon,
  SuccessIcon,
} from "@/components/ui/icons";
import { useAuth } from "@/components/auth/AuthContext";

// Illustrative heatmap for the hero: five weekday columns, four morning rows,
// with the strongest overlap (5 of 5) landing on Tuesday at 11 AM.
const PREVIEW_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const PREVIEW_ROWS = [
  { time: "9 AM", overlaps: [2, 3, 1, 2, 2] },
  { time: "10 AM", overlaps: [3, 4, 3, 2, 3] },
  { time: "11 AM", overlaps: [3, 5, 4, 3, 2] },
  { time: "12 PM", overlaps: [2, 3, 2, 1, 2] },
];
// `.home-preview-grid` (scheduling.css) reads this custom property for its
// weekday column count, so the layout stays in step with PREVIEW_DAYS.
const PREVIEW_GRID_STYLE = { "--rv-preview-columns": PREVIEW_DAYS.length };

const STEPS = [
  {
    title: "Suggest the options",
    copy: "Pick the dates, time range, location, and response deadline.",
  },
  {
    title: "Share one link",
    copy: "Invite your group with a secure link or event code—no spreadsheet required.",
  },
  {
    title: "Choose the best time",
    copy: "Compare everyone's availability and finalize the strongest overlap.",
  },
];

function HomePage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [eventCode, setEventCode] = useState("");

  const handleOrganize = () => {
    if (loading) return;
    router.push(user ? "/create" : "/login?next=%2Fcreate");
  };

  const handleJoin = (submitEvent) => {
    submitEvent?.preventDefault();
    if (loading) return;
    const code = eventCode.trim();
    if (!code) return;
    const eventPath = `/event?code=${encodeURIComponent(code)}`;
    router.push(
      user ? eventPath : `/login?next=${encodeURIComponent(eventPath)}`,
    );
  };

  return (
    <>
      <AppHeader />
      <main className="page-shell home-page">
        <section
          className="row g-4 g-lg-5 align-items-center home-hero"
          aria-labelledby="home-heading"
        >
          <div className="col-lg-6 home-hero-copy">
            <span className="eyebrow">
              Group scheduling without the back-and-forth
            </span>
            <h1 id="home-heading" className="display-6 fw-semibold mb-3">
              Find a time that works for everyone.
            </h1>
            <p className="lead text-secondary mb-4">
              Create a scheduling poll, share one link, and watch the best
              meeting times appear as your group responds.
            </p>

            <div className="d-flex flex-wrap align-items-center gap-3 home-hero-actions">
              <AppButton
                onClick={handleOrganize}
                icon={<AddIcon />}
                size="lg"
                disabled={loading}
                className="home-create-button"
              >
                Create a scheduling poll
              </AppButton>
              {user ? (
                <Link
                  className="btn btn-outline-secondary btn-lg app-btn home-secondary-link"
                  href="/dashboard"
                >
                  <span className="app-btn-label">Go to my dashboard</span>
                  <span className="app-btn-icon" aria-hidden="true">
                    <ArrowRightIcon />
                  </span>
                </Link>
              ) : (
                <p className="text-secondary mb-0 home-action-note">
                  Continue with your email to create a free account.
                </p>
              )}
            </div>
          </div>

          <div className="col-lg-6">
            <aside
              className="card home-preview"
              aria-label="Example group availability"
            >
              <div className="card-body">
                <div className="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-3">
                  <div className="min-w-0">
                    <p className="fw-semibold mb-0">Project kickoff</p>
                    <span className="text-secondary small">
                      5 people responded
                    </span>
                  </div>
                  <StatusBadge status="success" dot={false}>
                    <span className="icon-inline" aria-hidden="true">
                      <SuccessIcon />
                    </span>
                    Live
                  </StatusBadge>
                </div>

                <div
                  className="home-preview-grid"
                  aria-hidden="true"
                  style={PREVIEW_GRID_STYLE}
                >
                  <span></span>
                  {PREVIEW_DAYS.map((day) => (
                    <strong key={day}>{day}</strong>
                  ))}
                  {PREVIEW_ROWS.map((row) => (
                    <PreviewRow key={row.time} row={row} />
                  ))}
                </div>

                {/* The legend explains the decorative heatmap above (how many
                    of the five people are free), so it is decorative too. */}
                <div
                  className="home-preview-legend d-flex align-items-center gap-2 mt-3 small text-secondary"
                  aria-hidden="true"
                >
                  <span>Fewer free</span>
                  <span className="home-preview-scale d-inline-flex gap-1">
                    {[1, 2, 3, 4, 5].map((overlap) => (
                      <i key={overlap} className={`overlap-${overlap}`}></i>
                    ))}
                  </span>
                  <span>Everyone free</span>
                </div>

                <p className="d-flex align-items-center gap-2 mt-3 mb-0 home-preview-result">
                  <span className="icon-inline text-primary" aria-hidden="true">
                    <BestIcon />
                  </span>
                  <span>
                    <strong>Best overlap:</strong> Tuesday at 11:00 AM
                  </span>
                </p>
              </div>
            </aside>
          </div>
        </section>

        <Panel
          className="mt-5 home-join-section"
          aria-labelledby="join-heading"
        >
          <div className="row g-4 align-items-start">
            <div className="col-lg-6 d-flex gap-3 home-role-intro">
              <span
                className="empty-state__icon mb-0 flex-shrink-0 home-role-icon"
                aria-hidden="true"
              >
                <GroupIcon />
              </span>
              <div className="min-w-0">
                <span className="eyebrow">I&apos;ve been invited</span>
                <h2 id="join-heading" className="h3">
                  Open an existing poll
                </h2>
                <p className="text-secondary mb-0">
                  Use the event code from your organizer to add or update your
                  availability.
                </p>
              </div>
            </div>

            <div className="col-lg-6">
              <form className="home-code-form" onSubmit={handleJoin}>
                <FormField
                  id="event-code"
                  label="Event code"
                  help={
                    !user
                      ? "We'll verify your email, then bring you straight to the event."
                      : null
                  }
                >
                  {(fieldProps) => (
                    <div className="input-group home-code-row">
                      <input
                        {...fieldProps}
                        type="text"
                        className="form-control"
                        name="eventCode"
                        value={eventCode}
                        onChange={(event) => setEventCode(event.target.value)}
                        placeholder="e.g. ABC123"
                        autoCapitalize="characters"
                        autoComplete="off"
                        spellCheck="false"
                      />
                      <AppButton
                        type="submit"
                        icon={<SearchIcon />}
                        disabled={loading || !eventCode.trim()}
                      >
                        Open event
                      </AppButton>
                    </div>
                  )}
                </FormField>
              </form>
            </div>
          </div>
        </Panel>

        <section className="mt-5 home-steps" aria-labelledby="steps-heading">
          <span className="eyebrow">One shared view, one clear answer</span>
          <h2 id="steps-heading" className="mb-3">
            How Releviz works
          </h2>
          <ol className="row g-3 list-unstyled mb-3" role="list">
            {STEPS.map((step, index) => (
              <li key={step.title} className="col-md-4 d-flex">
                <div className="card w-100">
                  <div className="card-body">
                    <span className="section-index mb-3">{index + 1}</span>
                    <h3 className="h5">{step.title}</h3>
                    <p className="text-secondary mb-0">{step.copy}</p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <p className="d-flex align-items-center gap-2 text-secondary small mb-0 home-trust-note">
            <span className="icon-inline" aria-hidden="true">
              <LinkIcon />
            </span>
            <span>
              Each poll keeps its own shareable code, participants, and live
              result.
            </span>
          </p>
        </section>
      </main>
    </>
  );
}

// One time row of the preview heatmap: the label cell plus one overlap cell
// per weekday. Rendered as siblings so the CSS grid places them directly.
function PreviewRow({ row }) {
  return (
    <>
      <span>{row.time}</span>
      {row.overlaps.map((overlap, index) => (
        <i
          key={`${row.time}-${PREVIEW_DAYS[index]}`}
          className={`overlap-${overlap}`}
        ></i>
      ))}
    </>
  );
}

export default HomePage;
