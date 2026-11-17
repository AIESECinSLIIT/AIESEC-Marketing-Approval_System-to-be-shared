import React, { useEffect, useState } from "react";
import { Plus, Pencil, CalendarDays } from "lucide-react";
import { api, json, Modal, ErrorBox, Empty } from "./lib.jsx";
import { EVENT_ROLES } from "./workflow.js";

export function CommitteeSelect({
  value,
  onChange,
  groups,
  allowEntity = true,
  disabled = false,
}) {
  return (
    <label>
      Committee / initiative group
      <select
        aria-label="Committee / initiative group"
        required
        value={value || ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          Select a committee
        </option>
        {allowEntity && <option value="ENTITY">AIESEC in Your Entity</option>}
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
            {g.active === false ? " (inactive)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
export function AccountScopeFields({
  role,
  organization,
  eventId,
  eventName,
  onChange,
  active = true,
  assignedEventId,
  manager,
}) {
  const [events, setEvents] = useState([]),
    [groups, setGroups] = useState([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    Promise.all([
      api(manager ? "/admin/events" : "/events"),
      api(manager ? "/admin/groups" : "/groups"),
    ])
      .then(([e, g]) => {
        if (alive) {
          setEvents(e.events);
          setGroups(g.groups);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [manager?.id]);
  if (["ADMIN", "EM_VP", "MARKETING_VP", "B2C_VP"].includes(role)) return null;
  const igOnly =
    ["IGP", "IGVP_MARKETING", "IGVP_OGV"].includes(role) ||
    ["EM_VP", "IGP"].includes(manager?.role);
  const scopedGroups =
    manager?.role === "IGP"
      ? groups.filter((g) => g.id === manager.organization)
      : groups;
  const selectedOrg =
    manager?.role === "IGP" ? manager.organization : organization;
  const available = events.filter(
    (e) => e.organization === selectedOrg && (e.active || e.id === eventId),
  );
  return (
    <>
      <CommitteeSelect
        value={selectedOrg}
        allowEntity={!igOnly}
        groups={scopedGroups}
        disabled={loading || manager?.role === "IGP"}
        onChange={(org) => onChange({ organization: org, eventId: "" })}
      />
      {EVENT_ROLES.includes(role) && (
        <label>
          Event
          <select
            aria-label="Event"
            required={active}
            value={eventId || ""}
            disabled={loading}
            onChange={(e) => onChange({ eventId: e.target.value })}
          >
            <option value="">
              {loading ? "Loading events…" : "Select your event"}
            </option>
            {eventId && !available.some((e) => e.id === eventId) && (
              <option value={eventId}>
                {eventName || "Assigned event"} (archived)
              </option>
            )}
            {available.map((e) => (
              <option
                key={e.id}
                value={e.id}
                disabled={
                  (role === "OCP" &&
                    e.ocpAssigned &&
                    e.id !== assignedEventId) ||
                  (role === "EVENT_MANAGER" &&
                    e.managerCount >= 3 &&
                    e.id !== assignedEventId)
                }
              >
                {e.name}
                {role === "OCP" && e.ocpAssigned && e.id !== assignedEventId
                  ? " · OCP already registered"
                  : ""}
                {role === "EVENT_MANAGER"
                  ? " · " + e.managerCount + "/3 managers"
                  : ""}
                {!e.active ? " (archived)" : ""}
              </option>
            ))}
          </select>
          {!loading && !available.length && (
            <small className="field-hint">
              No ongoing events in this committee. Contact your administrator.
            </small>
          )}
        </label>
      )}
      <ErrorBox message={error} />
    </>
  );
}
export default function Events({ user, onChange }) {
  const [events, setEvents] = useState([]),
    [groups, setGroups] = useState([]),
    [edit, setEdit] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const load = () =>
    Promise.all([api("/admin/events"), api("/admin/groups")])
      .then(([e, g]) => {
        setEvents(e.events);
        setGroups(g.groups);
        setError("");
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);
  const defaultOrg =
    user.role === "ADMIN"
      ? "ENTITY"
      : user.role === "IGP"
        ? user.organization
        : groups.find((g) => g.active)?.id || "";
  return (
    <>
      <div className="panel-heading">
        <span className="muted">
          {events.filter((e) => e.active).length} ongoing events
        </span>
        <button
          className="button primary"
          onClick={() =>
            setEdit({ name: "", active: true, organization: defaultOrg })
          }
        >
          <Plus size={18} />
          Add event
        </button>
      </div>
      <ErrorBox message={error} />
      {loading ? (
        <p className="muted">Loading events…</p>
      ) : !events.length ? (
        <Empty
          title="No events yet"
          text="Add an ongoing event to open registration."
        />
      ) : (
        <div className="event-grid">
          {events.map((e) => (
            <section className="panel event-card" key={e.id}>
              <CalendarDays size={24} />
              <div>
                <h2>{e.name}</h2>
                <small>{e.organizationName}</small>
                <span className={"badge " + (e.active ? "approved" : "draft")}>
                  {e.active ? "Ongoing" : "Archived"}
                </span>
                <small>
                  {e.ocpAssigned ? "OCP appointed" : "OCP not registered"} ·{" "}
                  {e.managerCount}/3 Event Managers
                </small>
              </div>
              <button className="button secondary" onClick={() => setEdit(e)}>
                <Pencil size={16} />
                Manage
              </button>
            </section>
          ))}
        </div>
      )}
      {edit && (
        <EventForm
          event={edit}
          user={user}
          groups={groups}
          onClose={() => setEdit(null)}
          onSave={() => {
            setEdit(null);
            load();
            onChange("Events updated");
          }}
        />
      )}
    </>
  );
}
function EventForm({ event, user, groups, onClose, onSave }) {
  const [name, setName] = useState(event.name),
    [active, setActive] = useState(event.active),
    [organization, setOrganization] = useState(event.organization),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        "/admin/events" + (event.id ? "/" + event.id : ""),
        json(deleting ? "DELETE" : event.id ? "PATCH" : "POST", {
          name,
          active,
          organization,
        }),
      );
      onSave();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={event.id ? "Manage event" : "Add event"}
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={save}>
        <div className="modal-body">
          {deleting ? (
            <p>
              Delete <strong>{event.name}</strong>? Events with accounts or
              submissions must be archived to preserve their history.
            </p>
          ) : (
            <>
              <label>
                Event name
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Catalyst 7.0"
                />
              </label>
              <CommitteeSelect
                value={organization}
                onChange={setOrganization}
                allowEntity={user.role === "ADMIN"}
                groups={groups}
                disabled={Boolean(event.id) || user.role === "IGP"}
              />
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                Ongoing event
              </label>
              <p className="field-hint">
                Archiving closes new registrations and submissions. History
                stays available.
              </p>
              {event.id && (
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={() => setDeleting(true)}
                >
                  Delete event
                </button>
              )}
            </>
          )}
          <ErrorBox message={error} />
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => (deleting ? setDeleting(false) : onClose())}
          >
            Cancel
          </button>
          <button
            disabled={busy}
            className={"button " + (deleting ? "cleanup-delete" : "primary")}
          >
            {busy ? "Saving…" : deleting ? "Delete event" : "Save event"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
