"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AppHeader from "@/components/ui/AppHeader";
import Button, { ButtonLink } from "@/components/ui/Button";
import Icon from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Feedback";
import { Field, TextInput } from "@/components/ui/Form";
import { Card, Eyebrow } from "@/components/ui/Surface";
import { useAuth } from "@/components/auth/AuthContext";

const PREVIEW_DAYS = [
  { label: "Mon", height: "38%" },
  { label: "Tue", height: "92%", best: true },
  { label: "Wed", height: "55%" },
  { label: "Thu", height: "70%" },
  { label: "Fri", height: "30%" },
  { label: "Sat", height: "18%" },
  { label: "Sun", height: "24%" },
];

const STEPS = [
  {
    title: "Suggest the options",
    body: "Pick the dates, time range, location, and response deadline.",
  },
  {
    title: "Share one link",
    body: "Invite your group with a secure link or event code—no spreadsheet required.",
  },
  {
    title: "Choose the best time",
    body: "Compare everyone’s availability and finalize the strongest overlap.",
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
      <main id="main" className="rv-page rv-page--wide">
        <section aria-labelledby="home-heading" className="rv-hero">
          <div className="rv-stack rv-stack--lg">
            <div className="rv-stack rv-stack--md">
              <Eyebrow icon="sparkle">
                Group scheduling without the back-and-forth
              </Eyebrow>
              <h1 id="home-heading" className="rv-hero__title">
                Find a time that works for everyone.
              </h1>
              <p className="rv-hero__lede">
                Create a scheduling poll, share one link, and watch the best
                meeting times appear as your group responds.
              </p>
            </div>

            <div className="rv-btn-row rv-btn-row--stack">
              <Button
                variant="primary"
                size="lg"
                icon="calendar"
                onClick={handleOrganize}
                disabled={loading}
              >
                Create a scheduling poll
              </Button>
              {user ? (
                <ButtonLink href="/dashboard" size="lg" iconEnd="arrowRight">
                  Go to my dashboard
                </ButtonLink>
              ) : null}
            </div>
            {!user && (
              <p className="rv-field__hint">
                Continue with your email to create a free account.
              </p>
            )}
          </div>

          <aside
            aria-label="Example group availability"
            className="rv-hero__preview"
          >
            <div className="rv-split">
              <div className="rv-stack rv-stack--xs">
                <p className="rv-eyebrow">Project kickoff</p>
                <p>5 people responded</p>
              </div>
              <Badge tone="success" dot>
                Live
              </Badge>
            </div>
            <div className="rv-hero__bars" aria-hidden="true">
              {PREVIEW_DAYS.map((day) => (
                <div
                  key={day.label}
                  className={`rv-hero__bar${day.best ? " rv-hero__bar--best" : ""}`}
                >
                  <span
                    className="rv-hero__bar-fill"
                    style={{ height: day.height }}
                  />
                  <span className="rv-hero__bar-label">{day.label}</span>
                </div>
              ))}
            </div>
            <p className="rv-meta__item">
              <Icon name="checkCircle" className="rv-meta__icon" />
              <span>
                <strong>Best overlap:</strong> Tuesday at 11:00 AM
              </span>
            </p>
          </aside>
        </section>

        <section aria-labelledby="join-heading" className="rv-section-gap">
          <Card raised className="rv-stack--md rv-join">
            <div className="rv-stack rv-stack--xs">
              <Eyebrow icon="mail">I&apos;ve been invited</Eyebrow>
              <h2 id="join-heading">Open an existing poll</h2>
              <p className="rv-field__hint">
                Use the event code from your organizer to add or update your
                availability.
              </p>
            </div>
            <form onSubmit={handleJoin} className="rv-stack rv-stack--md">
              <div className="rv-input-group">
                <Field label="Event code" className="rv-fill">
                  <TextInput
                    name="eventCode"
                    value={eventCode}
                    onChange={(event) => setEventCode(event.target.value)}
                    placeholder="e.g. ABC123"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck="false"
                  />
                </Field>
              </div>
              <div className="rv-btn-row rv-btn-row--stack">
                <Button
                  type="submit"
                  variant="primary"
                  iconEnd="arrowRight"
                  disabled={loading || !eventCode.trim()}
                >
                  Open event
                </Button>
              </div>
              {!user && (
                <p className="rv-field__hint">
                  We&apos;ll verify your email, then bring you straight to the
                  event.
                </p>
              )}
            </form>
          </Card>
        </section>

        <section
          aria-labelledby="steps-heading"
          className="rv-stack rv-stack--lg rv-section-gap"
        >
          <div className="rv-stack rv-stack--xs">
            <Eyebrow>One shared view, one clear answer</Eyebrow>
            <h2 id="steps-heading">How Releviz works</h2>
          </div>
          <ol className="rv-steps">
            {STEPS.map((step) => (
              <li key={step.title} className="rv-step">
                <h3 className="rv-step__title">{step.title}</h3>
                <p className="rv-step__body">{step.body}</p>
              </li>
            ))}
          </ol>
          <p className="rv-field__hint">
            Each poll keeps its own shareable code, participants, and live
            result.
          </p>
        </section>
      </main>
    </>
  );
}

export default HomePage;
