"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import AppHeader from "@/components/ui/AppHeader";
import Button, { ButtonLink } from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import {
  Badge,
  Callout,
  EmptyState,
  LoadingState,
  MetaList,
} from "@/components/ui/Feedback";
import { Field, TextInput } from "@/components/ui/Form";
import { Card, PageHeader, SectionHeader } from "@/components/ui/Surface";
import { useAuth } from "@/components/auth/AuthContext";
import { fetchDashboardEvents } from "@/lib/api/dashboard";
import {
  deleteEvent,
  duplicateEvent,
  updateEventLifecycle,
} from "@/lib/api/events";
import { formatDateTimeInTimezone, formatMode } from "@/lib/format";
import { navigateTo } from "@/lib/navigation";

const STATUS_TONE = {
  active: "success",
  closed: "warning",
  finalized: "accent",
  archived: "neutral",
};

function newRequestKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random()}`;
}

function statusLabel(status) {
  const value = status || "unknown";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function EventCard({
  event,
  organizerActions = false,
  busy = false,
  onArchive,
  onDuplicate,
  onDeleteRequested,
}) {
  const eventUrl = `/event?code=${encodeURIComponent(event.code)}`;
  const locked = event.status === "finalized" || event.status === "archived";

  return (
    <Card as="article" interactive className="rv-card--compact">
      <div className="rv-split">
        <h3 className="rv-fill">
          <Link href={eventUrl}>{event.name}</Link>
        </h3>
        <Badge tone={STATUS_TONE[event.status] || "neutral"} dot>
          <span className="rv-visually-hidden">Status:</span>{" "}
          {statusLabel(event.status)}
        </Badge>
      </div>

      <MetaList
        items={[
          {
            label: "Meeting type",
            value: formatMode(event.mode),
            icon: "users",
          },
          { label: "Code", value: event.code, icon: "link" },
          {
            label: "Deadline",
            value: event.responseDeadline
              ? formatDateTimeInTimezone(
                  event.responseDeadline,
                  event.timezone,
                  { timeZoneName: "short" },
                )
              : "",
            icon: "clock",
          },
          {
            label: "Location",
            value:
              event.location && event.location !== "TBD" ? event.location : "",
            icon: "mapPin",
          },
        ]}
      />

      {organizerActions && (
        <div className="rv-btn-row" aria-label={`Actions for ${event.name}`}>
          <ButtonLink href={eventUrl} size="sm" variant="subtle">
            View
          </ButtonLink>
          <ButtonLink
            href={`/edit?code=${encodeURIComponent(event.code)}`}
            size="sm"
            aria-disabled={locked}
            title={
              locked ? "Reactivate this event before editing it." : undefined
            }
            onClick={(clickEvent) => {
              if (locked) clickEvent.preventDefault();
            }}
          >
            Edit
          </ButtonLink>
          <Button size="sm" disabled={busy} onClick={() => onDuplicate(event)}>
            Duplicate
          </Button>
          {event.status !== "archived" && (
            <Button size="sm" disabled={busy} onClick={() => onArchive(event)}>
              Archive
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onDeleteRequested(event)}
          >
            Delete
          </Button>
        </div>
      )}
    </Card>
  );
}

function DashboardPage() {
  const { user, loading: authLoading, getToken } = useAuth();
  const [organized, setOrganized] = useState([]);
  const [participating, setParticipating] = useState([]);
  const [loading, setLoading] = useState(true);
  const [eventCode, setEventCode] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [actionCode, setActionCode] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteRequestKey, setDeleteRequestKey] = useState("");
  const duplicateRequestKeys = useRef(new Map());

  useEffect(() => {
    if (!authLoading && !user) {
      navigateTo("/login?next=/dashboard");
      return;
    }
    if (authLoading || !user) return;
    getToken()
      .then((token) => fetchDashboardEvents(token))
      .then((data) => {
        setOrganized(data.organized || []);
        setParticipating(data.participating || []);
      })
      .catch(() =>
        setError("Failed to load your events. Please refresh and try again."),
      )
      .finally(() => setLoading(false));
  }, [user, authLoading, getToken]);

  const replaceOrganizedEvent = (event) => {
    setOrganized((current) =>
      current.map((candidate) =>
        candidate.code === event.code ? event : candidate,
      ),
    );
  };

  const handleArchive = async (event) => {
    setActionCode(event.code);
    setError("");
    setStatus("");
    try {
      const token = await getToken();
      const data = await updateEventLifecycle(
        event.code,
        {
          status: "archived",
          expectedVersion: event.version,
          responseDeadline: event.responseDeadline,
        },
        token,
      );
      replaceOrganizedEvent(data.event);
      setStatus(`${event.name} was archived.`);
    } catch (err) {
      setError(err.message || "Unable to archive this event.");
    } finally {
      setActionCode("");
    }
  };

  const handleDuplicate = async (event) => {
    const fingerprint = `${event.code}:${event.version}`;
    const idempotencyKey =
      duplicateRequestKeys.current.get(fingerprint) || newRequestKey();
    duplicateRequestKeys.current.set(fingerprint, idempotencyKey);
    setActionCode(event.code);
    setError("");
    setStatus("");
    try {
      const token = await getToken();
      const data = await duplicateEvent(
        event.code,
        {
          expectedVersion: event.version,
          idempotencyKey,
        },
        token,
      );
      duplicateRequestKeys.current.delete(fingerprint);
      setOrganized((current) => [
        data.event,
        ...current.filter((candidate) => candidate.code !== data.event.code),
      ]);
      setStatus(`${event.name} was duplicated as a new active event.`);
    } catch (err) {
      if (err.event) replaceOrganizedEvent(err.event);
      setError(err.message || "Unable to duplicate this event.");
    } finally {
      setActionCode("");
    }
  };

  const openDeletePanel = (event) => {
    setDeleteTarget(event);
    setDeleteConfirmation("");
    setDeleteRequestKey(newRequestKey());
    setError("");
    setStatus("");
  };

  const closeDeletePanel = () => {
    setDeleteTarget(null);
    setDeleteConfirmation("");
    setDeleteRequestKey("");
  };

  const handleDelete = async (submitEvent) => {
    submitEvent.preventDefault();
    if (!deleteTarget || deleteConfirmation !== deleteTarget.code) return;
    setActionCode(deleteTarget.code);
    setError("");
    setStatus("");
    try {
      const token = await getToken();
      await deleteEvent(
        deleteTarget.code,
        {
          expectedVersion: deleteTarget.version,
          idempotencyKey: deleteRequestKey,
          confirmation: deleteConfirmation,
        },
        token,
      );
      setOrganized((current) =>
        current.filter((candidate) => candidate.code !== deleteTarget.code),
      );
      setStatus(`${deleteTarget.name} was permanently deleted.`);
      closeDeletePanel();
    } catch (err) {
      if (err.event) {
        replaceOrganizedEvent(err.event);
        setDeleteTarget(err.event);
      }
      setError(err.message || "Unable to delete this event.");
    } finally {
      setActionCode("");
    }
  };

  const handleGoToEvent = () => {
    const code = eventCode.trim();
    if (code) navigateTo(`/event?code=${encodeURIComponent(code)}`);
  };

  if (authLoading || loading) {
    return (
      <>
        <AppHeader pageTitle="My Dashboard" />
        <main id="main" className="rv-page">
          <LoadingState message="Loading..." />
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader pageTitle="My Dashboard" />
      <main id="main" className="rv-page">
        <div className="rv-stack rv-stack--xl">
          <PageHeader
            eyebrow="Your workspace"
            eyebrowIcon="calendar"
            title="My Dashboard"
            description="Everything you organize and every poll you were invited to, in one place."
            actions={
              <ButtonLink href="/create" variant="primary" icon="plus">
                Create New Event
              </ButtonLink>
            }
            meta={
              <form
                className="rv-input-group rv-code-form"
                onSubmit={(submitEvent) => {
                  submitEvent.preventDefault();
                  handleGoToEvent();
                }}
              >
                <Field label="Enter Event Code" className="rv-fill">
                  <TextInput
                    value={eventCode}
                    onChange={(event) => setEventCode(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      handleGoToEvent();
                    }}
                    placeholder="e.g. ABC123"
                    autoComplete="off"
                  />
                </Field>
                <Button type="submit">Go</Button>
              </form>
            }
          />

          {error && (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          )}
          {status && (
            <Callout tone="success" role="status">
              {status}
            </Callout>
          )}

          <section
            aria-labelledby="dashboard-organized-heading"
            className="rv-stack rv-stack--md"
          >
            <SectionHeader
              titleId="dashboard-organized-heading"
              title={`My Events (${organized.length})`}
              description="Events you organize. Duplicate, archive, or delete them here."
            />
            {organized.length > 0 ? (
              <div className="rv-card-grid">
                {organized.map((event) => (
                  <EventCard
                    key={event.code}
                    event={event}
                    organizerActions
                    busy={actionCode === event.code}
                    onArchive={handleArchive}
                    onDuplicate={handleDuplicate}
                    onDeleteRequested={openDeletePanel}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                icon="calendar"
                title="No events organized yet."
                description="Create a scheduling poll and share one link with your group."
                action={
                  <ButtonLink href="/create" variant="primary" icon="plus">
                    Create your first event
                  </ButtonLink>
                }
              />
            )}
          </section>

          <section
            aria-labelledby="dashboard-participating-heading"
            className="rv-stack rv-stack--md"
          >
            <SectionHeader
              titleId="dashboard-participating-heading"
              title={`Events I Participate In (${participating.length})`}
              description="Polls where someone else is collecting availability."
            />
            {participating.length > 0 ? (
              <div className="rv-card-grid">
                {participating.map((event) => (
                  <EventCard key={event.code} event={event} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon="inbox"
                title="Not participating in any events yet."
                description="Open an invitation link or enter an event code above."
              />
            )}
          </section>
        </div>

        <Dialog
          open={Boolean(deleteTarget)}
          title={deleteTarget ? `Delete ${deleteTarget.name}?` : ""}
          eyebrow="Permanent action"
          onClose={closeDeletePanel}
          closeDisabled={Boolean(
            deleteTarget && actionCode === deleteTarget.code,
          )}
          closeLabel="Cancel deleting this event"
        >
          {deleteTarget && (
            <form onSubmit={handleDelete} className="rv-stack rv-stack--md">
              <Callout tone="danger">
                This permanently removes the event, participant responses,
                invitations, final meeting, and queued event emails. This action
                cannot be undone.
              </Callout>
              <Field
                label="Event code confirmation"
                hint={`Type ${deleteTarget.code} to confirm.`}
              >
                <TextInput
                  value={deleteConfirmation}
                  onChange={(event) =>
                    setDeleteConfirmation(event.target.value)
                  }
                  autoComplete="off"
                  spellCheck="false"
                />
              </Field>
              <div className="rv-btn-row rv-btn-row--stack rv-btn-row--end">
                <Button onClick={closeDeletePanel}>Cancel</Button>
                <Button
                  type="submit"
                  variant="danger"
                  busy={actionCode === deleteTarget.code}
                  disabled={
                    actionCode === deleteTarget.code ||
                    deleteConfirmation !== deleteTarget.code
                  }
                >
                  {actionCode === deleteTarget.code
                    ? "Deleting..."
                    : "Delete event permanently"}
                </Button>
              </div>
            </form>
          )}
        </Dialog>
      </main>
    </>
  );
}

export default DashboardPage;
