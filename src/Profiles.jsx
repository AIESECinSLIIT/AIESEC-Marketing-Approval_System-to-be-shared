import React, { useState } from "react";
import { Check, Plus, ArrowLeft, ArrowLeftRight } from "lucide-react";
import { api, json, Modal, ErrorBox, ROLES } from "./lib.jsx";
import { SELF_SIGNUP_ROLES } from "./workflow.js";
import { AccountScopeFields } from "./Events.jsx";
export default function Profiles({ user, onClose, onChange }) {
  const [adding, setAdding] = useState(false),
    [role, setRole] = useState("CREATOR"),
    [scope, setScope] = useState({
      organization: user.organization || "ENTITY",
      eventId: "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const profiles = user.profiles || [user];
  async function select(id) {
    if (id === user.id) {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api("/profiles/switch", json("POST", { id }));
      onChange(result.user);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function add(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api("/profiles", json("POST", { role, ...scope }));
      onChange(result.user);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={adding ? "Add a profile" : "Your profiles"}
      onClose={() => !busy && onClose()}
    >
      {adding ? (
        <form onSubmit={add}>
          <div className="modal-body">
            <button
              className="text-button"
              type="button"
              onClick={() => setAdding(false)}
              disabled={busy}
            >
              <ArrowLeft size={16} />
              All profiles
            </button>
            <label>
              Role
              <select
                aria-label="Role"
                value={role}
                onChange={(e) => {
                  setRole(e.target.value);
                  setScope({ ...scope, eventId: "" });
                }}
              >
                {SELF_SIGNUP_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLES[r]}
                  </option>
                ))}
              </select>
            </label>
            <AccountScopeFields
              role={role}
              {...scope}
              onChange={(change) => setScope({ ...scope, ...change })}
            />
            <p className="field-hint">
              Leadership and Event Manager profiles are appointed by your
              administrator.
            </p>
            <ErrorBox message={error} />
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              type="button"
              onClick={() => setAdding(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? "Adding…" : "Add profile"}
            </button>
          </div>
        </form>
      ) : (
        <div className="modal-body">
          <p className="muted profile-intro">
            One login. Choose the role and event you’re working on.
          </p>
          <div className="profile-list">
            {profiles.map((p) => (
              <button
                key={p.id}
                className={
                  "profile-choice " + (p.id === user.id ? "selected" : "")
                }
                disabled={busy}
                onClick={() => select(p.id)}
              >
                <span>
                  <strong>{ROLES[p.role]}</strong>
                  <small>
                    {p.eventName || p.organizationName || "AIESEC in Your Entity"}
                  </small>
                  {p.eventName && p.organization !== "ENTITY" && (
                    <small>{p.organizationName}</small>
                  )}
                </span>
                {p.id === user.id ? (
                  <Check size={19} />
                ) : (
                  <ArrowLeftRight size={18} />
                )}
              </button>
            ))}
          </div>
          <ErrorBox message={error} />
          {user.email !== "admin@your-entity.example" && (
            <button
              className="button secondary full"
              disabled={busy}
              onClick={() => {
                setError("");
                setAdding(true);
              }}
            >
              <Plus size={18} />
              Add a profile
            </button>
          )}
          <p className="field-hint">
            Notifications cover all your profiles on this device.
          </p>
        </div>
      )}
    </Modal>
  );
}
