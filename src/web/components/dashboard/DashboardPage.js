"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  MdAdd,
  MdArchive,
  MdContentCopy,
  MdDeleteOutline,
  MdEdit,
  MdOpenInNew,
  MdSearch,
} from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import { useAuth } from "@/components/auth/AuthContext";
import { fetchDashboardEvents } from "@/lib/api/dashboard";
import {
  deleteEvent,
  duplicateEvent,
  updateEventLifecycle,
} from "@/lib/api/events";
import { formatMode } from "@/lib/format";
import { navigateTo } from "@/lib/navigation";
import "@material/web/textfield/outlined-text-field.js";

function newRequestKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random()}`;
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
  return (
    <article className="dashboard-event-card">
      <div className="dashboard-event-summary">
        <Link href={eventUrl} className="dashboard-event-title">
          {event.name}
        </Link>
        <div className="dashboard-event-meta">
          <span>{formatMode(event.mode)}</span>
          <span>Status: {event.status || "unknown"}</span>
          <span>Code: {event.code}</span>
          {event.responseDeadline && (
            <span>
              Deadline: {new Date(event.responseDeadline).toLocaleString()}
            </span>
          )}
          {event.location && event.location !== "TBD" && (
            <span>{event.location}</span>
          )}
        </div>
      </div>

      {organizerActions && (
        <div
          className="dashboard-event-actions"
          aria-label={`Actions for ${event.name}`}
        >
          <Link href={eventUrl} className="dashboard-action-link">
            <MdOpenInNew aria-hidden="true" /> View
          </Link>
          <Link
            href={`/edit?code=${encodeURIComponent(event.code)}`}
            className="dashboard-action-link"
            aria-disabled={
              event.status === "finalized" || event.status === "archived"
            }
            onClick={(clickEvent) => {
              if (event.status === "finalized" || event.status === "archived") {
                clickEvent.preventDefault();
              }
            }}
          >
            <MdEdit aria-hidden="true" /> Edit
          </Link>
          <AppButton
            variant="outlined"
            icon={<MdContentCopy />}
            disabled={busy}
            onClick={() => onDuplicate(event)}
          >
            Duplicate
          </AppButton>
          {event.status !== "archived" && (
            <AppButton
              variant="outlined"
              icon={<MdArchive />}
              disabled={busy}
              onClick={() => onArchive(event)}
            >
              Archive
            </AppButton>
          )}
          <AppButton
            variant="outlined"
            className="app-btn-danger"
            icon={<MdDeleteOutline />}
            disabled={busy}
            onClick={() => onDeleteRequested(event)}
          >
            Delete
          </AppButton>
        </div>
      )}
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
    return (
      <div className="center-page">
        <p style={{ color: "var(--md-sys-color-on-surface-variant)" }}>
          Loading...
        </p>
      </div>
    );
  }

  const handleGoToEvent = () => {
    const code = eventCode.trim();
    if (code) navigateTo(`/event?code=${encodeURIComponent(code)}`);
  };

  return (
    <>
      <AppHeader pageTitle="My Dashboard" />
      <main className="page-pad dashboard-shell">
        {error && (
          <div className="dashboard-message dashboard-error" role="alert">
            {error}
          </div>
        )}
        {status && (
          <div className="dashboard-message dashboard-status" role="status">
            {status}
          </div>
        )}

        <div className="dashboard-heading">
          <h1>My Dashboard</h1>
          <Link href="/create" className="dashboard-create-link">
            <MdAdd aria-hidden="true" /> Create New Event
          </Link>
        </div>

        <div className="md-card dashboard-code-search">
          <md-outlined-text-field
            label="Enter Event Code"
            value={eventCode}
            onInput={(event) => setEventCode(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && handleGoToEvent()}
            style={{ flex: 1 }}
          ></md-outlined-text-field>
          <AppButton
            onClick={handleGoToEvent}
            variant="outlined"
            icon={<MdSearch />}
          >
            Go
          </AppButton>
        </div>

        {deleteTarget && (
          <form
            className="dashboard-delete-panel"
            onSubmit={handleDelete}
            aria-labelledby="delete-event-heading"
          >
            <h2 id="delete-event-heading">Delete {deleteTarget.name}?</h2>
            <p>
              This permanently removes the event, participant responses,
              invitations, final meeting, and queued event emails. This action
              cannot be undone.
            </p>
            <label className="field-label">
              Type <strong>{deleteTarget.code}</strong> to confirm
              <input
                aria-label="Event code confirmation"
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                autoComplete="off"
              />
            </label>
            <div className="dashboard-delete-actions">
              <AppButton variant="text" onClick={closeDeletePanel}>
                Cancel
              </AppButton>
              <AppButton
                type="submit"
                variant="outlined"
                className="app-btn-danger"
                icon={<MdDeleteOutline />}
                disabled={
                  actionCode === deleteTarget.code ||
                  deleteConfirmation !== deleteTarget.code
                }
              >
                {actionCode === deleteTarget.code
                  ? "Deleting..."
                  : "Delete event permanently"}
              </AppButton>
            </div>
          </form>
        )}

        <section className="md-card dashboard-section">
          <h2>My Events ({organized.length})</h2>
          {organized.length > 0 ? (
            <div className="dashboard-event-list">
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
            <p className="dashboard-empty">No events organized yet.</p>
          )}
        </section>

        <section className="md-card dashboard-section">
          <h2>Events I Participate In ({participating.length})</h2>
          {participating.length > 0 ? (
            <div className="dashboard-event-list">
              {participating.map((event) => (
                <EventCard key={event.code} event={event} />
              ))}
            </div>
          ) : (
            <p className="dashboard-empty">
              Not participating in any events yet.
            </p>
          )}
        </section>
      </main>
    </>
  );
}

export default DashboardPage;
