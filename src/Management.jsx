import React, { useEffect, useState } from "react";
import { managementRoles } from "./workflow.js";
import PushSettings from "./PushSettings.jsx";
import { AccountScopeFields } from "./Events.jsx";
import {
  Plus,
  Pencil,
  ArrowRight,
  ArrowLeftRight,
  Check,
  Bell,
  LockKeyhole,
  ShieldCheck,
  Search,
} from "lucide-react";
import {
  api,
  json,
  ROLES,
  Avatar,
  Modal,
  ErrorBox,
  Empty,
  date,
} from "./lib.jsx";

export function UserManagement({ user, onChange }) {
  const [users, setUsers] = useState([]),
    [edit, setEdit] = useState(null),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  const load = () =>
    api("/users")
      .then((d) => setUsers(d.users))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const filtered = users.filter((u) =>
    (u.name + " " + u.email + " " + ROLES[u.role])
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <ErrorBox message={error} />
      <section className="panel">
        <div className="panel-heading">
          <h2>
            Profiles <span className="count">{users.length}</span>
          </h2>
          <button className="button primary" onClick={() => setEdit({})}>
            <Plus size={17} />
            Add profile
          </button>
        </div>
        <div className="search-field people-search">
          <Search size={17} />
          <input
            aria-label="Search people"
            placeholder="Search by name, email, or role…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="table-scroll">
          <table
            className="people-table"
            role="table"
            aria-label="Team members"
          >
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Status</th>
                <th>Access</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="person">
                      <Avatar name={u.name} />
                      <div>
                        <strong>
                          {u.name}
                          {u.id === user.id ? " (you)" : ""}
                        </strong>
                        <small>{u.email}</small>
                      </div>
                    </div>
                  </td>
                  <td data-label="Role">
                    <div>
                      {ROLES[u.role]}
                      <small>
                        {u.eventName || u.organizationName || "AIESEC in Your Entity"}
                      </small>
                      {u.role === "CREATOR" && !u.eventId && (
                        <small className="assignment-warning">
                          Assign an event
                        </small>
                      )}
                    </div>
                  </td>
                  <td data-label="Status">
                    <span
                      className={
                        "badge " + (u.active ? "approved" : "rejected")
                      }
                    >
                      {u.active ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td data-label="Access">
                    {u.manageable !== false && (
                      <button
                        className="button small-button secondary"
                        onClick={() => setEdit(u)}
                      >
                        <Pencil size={13} />
                        Manage
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <Empty
            title="No people found"
            text="Try another search, or add your first team member."
          />
        )}
      </section>
      {edit && (
        <UserForm
          target={edit}
          user={user}
          onClose={() => setEdit(null)}
          onSave={() => {
            setEdit(null);
            load();
            onChange("Account saved successfully");
          }}
        />
      )}
    </>
  );
}
function UserForm({ target, user, onClose, onSave }) {
  const [form, setForm] = useState({
      name: target.name || "",
      email: target.email || "",
      role: target.role || Object.keys(managementRoles(user))[0],
      active: target.id ? !!target.active : true,
      password: "",
      organization:
        target.organization ||
        (user.role === "IGP"
          ? user.organization
          : user.role === "EM_VP"
            ? ""
            : "ENTITY"),
      eventId: target.eventId || "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false);
  const roles = {
    ...managementRoles(user),
    ...(target.role === "ADMIN" ? { ADMIN: ROLES.ADMIN } : {}),
  };
  async function deleteAccount() {
    setBusy(true);
    setError("");
    try {
      await api("/users/" + target.id, { method: "DELETE" });
      onSave();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...form };
      if (!body.password) delete body.password;
      await api(
        "/users" + (target.id ? "/" + target.id : ""),
        json(target.id ? "PATCH" : "POST", body),
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
      title={target.id ? "Manage profile" : "Add a profile"}
      onClose={() => !busy && onClose()}
    >
      {confirmDelete ? (
        <>
          <div className="modal-body">
            <p>
              Delete <strong>{target.name}</strong>?
            </p>
            <p className="muted">
              This profile and its uploaded creatives will be removed. Other
              profiles on the same login stay available. The login is deleted
              only when its last profile is removed. Captions and approval
              history remain.
            </p>
            <ErrorBox message={error} />
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
            <button
              className="button cleanup-delete"
              disabled={busy}
              onClick={deleteAccount}
            >
              {busy ? "Deleting…" : "Delete profile"}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={save}>
          <div className="modal-body">
            <label>
              Full name
              <input
                required
                value={form.name}
                maxLength={100}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              Login email
              <input
                required
                type="email"
                disabled={target.id && target.canManageLogin === false}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              {!target.id && (
                <small className="field-hint">
                  Use their existing login email to add another profile.
                </small>
              )}
              {target.id && target.canManageLogin === false && (
                <small className="field-hint">
                  The super admin manages login details shared with their other
                  profiles.
                </small>
              )}
            </label>
            <label>
              Role
              <select
                aria-label="Role"
                value={form.role}
                onChange={(e) =>
                  setForm({ ...form, role: e.target.value, eventId: "" })
                }
              >
                {Object.entries(roles).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <AccountScopeFields
              {...form}
              manager={user}
              assignedEventId={
                ["OCP", "EVENT_MANAGER"].includes(target.role)
                  ? target.eventId
                  : null
              }
              eventName={target.eventName}
              onChange={(change) => setForm({ ...form, ...change })}
            />
            <label>
              {target.id
                ? "New password (leave blank to keep)"
                : "Password for a new login (if needed)"}
              <input
                type="password"
                disabled={target.id && target.canManageLogin === false}
                autoComplete="new-password"
                minLength={12}
                required={false}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
              <small className="field-hint">
                Use 12+ characters for a new login. For an existing email, leave
                this blank; their current password stays the same.
              </small>
            </label>
            {target.id && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) =>
                    setForm({ ...form, active: e.target.checked })
                  }
                />
                Profile active
              </label>
            )}
            <ErrorBox message={error} />
            {target.id && (
              <button
                type="button"
                className="text-button danger-text"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setConfirmDelete(true);
                }}
              >
                Delete profile
              </button>
            )}
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? "Saving…" : "Save account"}
              <Check size={16} />
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
export function SettingsPage({ user, onChange }) {
  const [current, setCurrent] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(
        "/auth/password",
        json("POST", { currentPassword: current, newPassword: password }),
      );
      setCurrent("");
      setPassword("");
      setConfirm("");
      onChange("Password updated successfully");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="management-grid">
      <section className="panel">
        <div className="feature-icon">
          <LockKeyhole size={23} />
        </div>
        <h2>Change your password</h2>
        <p className="muted">
          Use a unique password with at least 12 characters.
        </p>
        <form onSubmit={save}>
          <label>
            Current password
            <input
              autoComplete="current-password"
              required
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label>
            New password
            <input
              autoComplete="new-password"
              required
              minLength={12}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            Confirm new password
            <input
              autoComplete="new-password"
              required
              minLength={12}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <ErrorBox message={error} />
          <button disabled={busy} className="button primary">
            {busy ? "Saving…" : "Update password"}
            <Check size={16} />
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>Your profile</h2>
        <div className="profile-card">
          <Avatar name={user.name} />
          <strong>{user.name}</strong>
          <span>{user.email}</span>
          <span className="badge pending">{ROLES[user.role]}</span>
        </div>
        <div className="info-banner">
          Contact the admin to update your account details or access.
        </div>
      </section>
    </div>
  );
}
export function Notifications({ items, onRead, onOpen }) {
  const [error, setError] = useState("");
  const unread = items.filter((n) => !n.readAt && !n.read).length;
  async function markRead() {
    try {
      await api("/notifications/read", json("POST", {}));
      onRead();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <>
      <PushSettings />
      <section className="panel">
        {items.length > 0 && (
          <div className="panel-heading">
            <span className="muted">{unread} unread</span>
            {unread > 0 && (
              <button className="button secondary" onClick={markRead}>
                <Check size={15} />
                Mark all as read
              </button>
            )}
          </div>
        )}
        <ErrorBox message={error} />
        {items.length ? (
          <div className="notification-list">
            {items.map((n) => (
              <button
                key={n.id}
                className={
                  "notification-row " + (!n.readAt && !n.read ? "unread" : "")
                }
                onClick={() => {
                  if (n.submissionId) onOpen(n.submissionId, n.profileId);
                }}
              >
                <span className="feature-icon">
                  <Bell size={18} />
                </span>
                <div>
                  <strong>{n.title || n.message}</strong>
                  {n.title && n.message && <p>{n.message}</p>}
                  {n.profileLabel && <small>{n.profileLabel}</small>}
                  <small>{date(n.createdAt, true)}</small>
                </div>
                {n.submissionId && <ArrowRight size={16} />}
              </button>
            ))}
          </div>
        ) : (
          <p className="notification-empty">No notifications yet.</p>
        )}
      </section>
    </>
  );
}
