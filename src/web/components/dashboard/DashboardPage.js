"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import EmptyState from "@/components/ui/EmptyState";
import FormField from "@/components/ui/FormField";
import LoadingState from "@/components/ui/LoadingState";
import Modal from "@/components/ui/Modal";
import PageHeader from "@/components/ui/PageHeader";
import Panel from "@/components/ui/Panel";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  AddIcon,
  ArchiveIcon,
  CalendarIcon,
  ClockIcon,
  CopyIcon,
  DeleteIcon,
  EditIcon,
  GroupIcon,
  LocationIcon,
  OpenIcon,
  SearchIcon,
  VirtualIcon,
} from "@/components/ui/icons";
import { useAuth } from "@/components/auth/AuthContext";
import { fetchDashboardEvents } from "@/lib/api/dashboard";
import {
  deleteEvent,
  duplicateEvent,
  updateEventLifecycle,
} from "@/lib/api/events";
import { formatDateTimeInTimezone, formatMode } from "@/lib/format";
import { navigateTo } from "@/lib/navigation";

function newRequestKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random()}`;
}

function ModeIcon({ mode }) {
  const Icon = mode === "virtual" ? VirtualIcon : GroupIcon;
  return (
    <span className="icon-inline" aria-hidden="true">
      <Icon />
    </span>
  );
}

function EventCard({
  event,
  organizerActions = false,
  busy = false,
  onArchive,
  onDuplicate,
  onDeleteRequested,
}) {
  const eventUrl = `/event?code=${encodeURIComponent(event.code)}`;
  const editLocked =
    event.status === "finalized" || event.status === "archived";
  return (
    <article className="card dashboard-event-card">
      <div className="card-body">
        <h3 className="h5 mb-2">
          <Link href={eventUrl} className="title-link">
            {event.name}
          </Link>
        </h3>
        <div className="meta-row">
          <span>
            <ModeIcon mode={event.mode} />
            {formatMode(event.mode)}
          </span>
          <span>
            Status:{" "}
            <StatusBadge status={event.status}>
              {event.status || "unknown"}
            </StatusBadge>
          </span>
          <span>
            Code: <code>{event.code}</code>
          </span>
          {event.responseDeadline && (
            <span>
              <span className="icon-inline" aria-hidden="true">
                <ClockIcon />
              </span>
              Deadline:{" "}
              {formatDateTimeInTimezone(
                event.responseDeadline,
                event.timezone,
                { timeZoneName: "short" },
              )}
            </span>
          )}
          {event.location && event.location !== "TBD" && (
            <span>
              <span className="icon-inline" aria-hidden="true">
                <LocationIcon />
              </span>
              {event.location}
            </span>
          )}
        </div>

        {organizerActions && (
          <div
            className="d-flex flex-wrap gap-2 mt-3"
            role="group"
            aria-label={`Actions for ${event.name}`}
          >
            <Link href={eventUrl} className="btn btn-outline-secondary app-btn">
              <span className="app-btn-icon" aria-hidden="true">
                <OpenIcon />
              </span>
              <span className="app-btn-label">View</span>
            </Link>
            <Link
              href={`/edit?code=${encodeURIComponent(event.code)}`}
              className={`btn btn-outline-secondary app-btn${editLocked ? " disabled" : ""}`}
              aria-disabled={editLocked}
              onClick={(clickEvent) => {
                if (editLocked) clickEvent.preventDefault();
              }}
            >
              <span className="app-btn-icon" aria-hidden="true">
                <EditIcon />
              </span>
              <span className="app-btn-label">Edit</span>
            </Link>
            <AppButton
              variant="outlined"
              icon={<CopyIcon />}
              disabled={busy}
              onClick={() => onDuplicate(event)}
            >
              Duplicate
            </AppButton>
            {event.status !== "archived" && (
              <AppButton
                variant="outlined"
                icon={<ArchiveIcon />}
                disabled={busy}
                onClick={() => onArchive(event)}
              >
                Archive
              </AppButton>
            )}
            <AppButton
              variant="danger"
              icon={<DeleteIcon />}
              disabled={busy}
              onClick={() => onDeleteRequested(event)}
            >
              Delete
            </AppButton>
          </div>
        )}
      </div>
    </article>
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

  if (authLoading || loading) {
    return <LoadingState page label="Loading..." />;
  }

  const handleGoToEvent = () => {
    const code = eventCode.trim();
    if (code) navigateTo(`/event?code=${encodeURIComponent(code)}`);
  };

  const deleting = Boolean(deleteTarget) && actionCode === deleteTarget.code;
  const currentEvents = organized.filter(
    (event) => event.status !== "archived",
  );
  const archivedEvents = organized.filter(
    (event) => event.status === "archived",
  );
  const confirmationMismatch =
    Boolean(deleteTarget) &&
    deleteConfirmation.length > 0 &&
    deleteConfirmation !== deleteTarget.code;

  return (
    <>
      <AppHeader pageTitle="My Dashboard" />
      <main className="page-shell dashboard-shell">
        <PageHeader
          title="My Dashboard"
          lede="Events you organize and events you have been invited to, all in one place."
          actions={
            <Link href="/create" className="btn btn-primary app-btn">
              <span className="app-btn-icon" aria-hidden="true">
                <AddIcon />
              </span>
              <span className="app-btn-label">Create New Event</span>
            </Link>
          }
        />

        <div className="d-flex flex-column gap-4">
          {/* Opening the delete dialog clears feedback, so any error while it
              is open belongs to the delete attempt and is shown inside the
              dialog instead of behind its backdrop. */}
          {error && !deleteTarget && (
            <Alert variant="danger" role="alert">
              {error}
            </Alert>
          )}
          {status && (
            <Alert variant="success" role="status">
              {status}
            </Alert>
          )}

          <Panel
            title="Open an event"
            headingLevel={2}
            description="Jump straight to any event when you have its code."
          >
            <div className="d-flex flex-wrap align-items-end gap-2">
              <FormField
                label="Enter Event Code"
                id="dashboard-event-code"
                className="flex-grow-1 min-w-0"
              >
                <input
                  type="text"
                  className="form-control"
                  autoComplete="off"
                  value={eventCode}
                  onChange={(event) => setEventCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleGoToEvent();
                    }
                  }}
                />
              </FormField>
              <AppButton
                onClick={handleGoToEvent}
                variant="outlined"
                icon={<SearchIcon />}
              >
                Go
              </AppButton>
            </div>
          </Panel>

          <Panel
            title={`My Events (${currentEvents.length})`}
            titleId="dashboard-my-events-heading"
            headingLevel={2}
            aria-labelledby="dashboard-my-events-heading"
          >
            {currentEvents.length > 0 ? (
              <div className="d-flex flex-column gap-3">
                {currentEvents.map((event) => (
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
            ) : archivedEvents.length > 0 ? (
              <EmptyState icon={<CalendarIcon />} title="No active events.">
                Your archived events are listed below.
              </EmptyState>
            ) : (
              <EmptyState
                icon={<CalendarIcon />}
                title="No events organized yet."
                actions={
                  <Link
                    href="/create"
                    className="btn btn-outline-secondary app-btn"
                  >
                    <span className="app-btn-icon" aria-hidden="true">
                      <AddIcon />
                    </span>
                    <span className="app-btn-label">
                      Create your first event
                    </span>
                  </Link>
                }
              >
                Create an event to start collecting availability.
              </EmptyState>
            )}
          </Panel>

          {archivedEvents.length > 0 && (
            <Panel
              title={`Archived (${archivedEvents.length})`}
              titleId="dashboard-archived-heading"
              headingLevel={2}
              description="Archived events are read-only. Duplicate one to start again, or delete it permanently."
              aria-labelledby="dashboard-archived-heading"
            >
              <div className="d-flex flex-column gap-3">
                {archivedEvents.map((event) => (
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
            </Panel>
          )}

          <Panel
            title={`Events I Participate In (${participating.length})`}
            headingLevel={2}
          >
            {participating.length > 0 ? (
              <div className="d-flex flex-column gap-3">
                {participating.map((event) => (
                  <EventCard key={event.code} event={event} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<GroupIcon />}
                title="Not participating in any events yet."
              >
                Events you join with an invitation or event code appear here.
              </EmptyState>
            )}
          </Panel>
        </div>

        {deleteTarget && (
          <Modal
            as="form"
            onSubmit={handleDelete}
            title={`Delete ${deleteTarget.name}?`}
            labelledBy="delete-event-heading"
            size="md"
            onClose={closeDeletePanel}
            busy={deleting}
            footer={
              <>
                <AppButton
                  variant="text"
                  onClick={closeDeletePanel}
                  disabled={deleting}
                >
                  Cancel
                </AppButton>
                <AppButton
                  type="submit"
                  variant="danger-filled"
                  icon={<DeleteIcon />}
                  busy={deleting}
                  disabled={
                    deleting || deleteConfirmation !== deleteTarget.code
                  }
                >
                  {deleting ? "Deleting..." : "Delete event permanently"}
                </AppButton>
              </>
            }
          >
            {error && (
              <Alert variant="danger" role="alert" className="mb-3">
                {error}
              </Alert>
            )}
            <p>
              This permanently removes the event, participant responses,
              invitations, final meeting, and queued event emails. This action
              cannot be undone.
            </p>
            <FormField
              id="delete-event-confirmation"
              label={
                <>
                  Type <strong>{deleteTarget.code}</strong> to confirm
                </>
              }
              // Mirrors the backend rejection in
              // src/api/apps/scheduling/services/events/mutations.py.
              error={
                confirmationMismatch
                  ? "Type the event code exactly to confirm deletion"
                  : null
              }
            >
              <input
                type="text"
                className="form-control"
                aria-label="Event code confirmation"
                data-autofocus
                autoComplete="off"
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
              />
            </FormField>
          </Modal>
        )}
      </main>
    </>
  );
}

export default DashboardPage;
