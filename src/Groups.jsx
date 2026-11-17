import React, { useEffect, useState } from "react";
import { Plus, Pencil } from "lucide-react";
import { api, Modal, ErrorBox, Empty } from "./lib.jsx";
export default function Groups({ onChange }) {
  const [groups, setGroups] = useState([]),
    [edit, setEdit] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const load = () =>
    api("/admin/groups")
      .then((d) => setGroups(d.groups))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <div className="panel-heading">
        <span className="muted">{groups.length} initiative groups</span>
        <button
          className="button primary"
          onClick={() => setEdit({ name: "", active: true })}
        >
          <Plus size={18} />
          Add initiative group
        </button>
      </div>
      <ErrorBox message={error} />
      {loading ? (
        <p className="muted">Loading groups…</p>
      ) : !groups.length ? (
        <Empty
          title="No initiative groups yet"
          text="Add a group and its logo, then appoint its IGP and IGVPs in Accounts."
        />
      ) : (
        <div className="event-grid">
          {groups.map((g) => (
            <section className="panel group-card" key={g.id}>
              <img src={g.logoUrl} alt={g.name + " logo"} loading="lazy" />
              <h2>{g.name}</h2>
              <span className={"badge " + (g.active ? "approved" : "draft")}>
                {g.active ? "Active" : "Inactive"}
              </span>
              <button className="button secondary" onClick={() => setEdit(g)}>
                <Pencil size={16} />
                Manage
              </button>
            </section>
          ))}
        </div>
      )}
      {edit && (
        <GroupForm
          group={edit}
          onClose={() => setEdit(null)}
          onSave={() => {
            setEdit(null);
            load();
            onChange("Initiative groups updated");
          }}
        />
      )}
    </>
  );
}
function GroupForm({ group, onClose, onSave }) {
  const [name, setName] = useState(group.name),
    [file, setFile] = useState(null),
    [active, setActive] = useState(group.active),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState(false);
  async function save(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const form = new FormData();
      form.set("name", name);
      form.set("active", String(active));
      form.set("logoPath", group.logoPath || "");
      if (file) form.set("logo", file);
      await api("/admin/groups" + (group.id ? "/" + group.id : ""), {
        method: deleting ? "DELETE" : group.id ? "PATCH" : "POST",
        body: form,
      });
      onSave();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        deleting
          ? "Delete initiative group"
          : group.id
            ? "Manage initiative group"
            : "Add initiative group"
      }
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={save}>
        <div className="modal-body">
          {deleting ? (
            <p>
              Delete <strong>{group.name}</strong>? Its accounts will be
              disabled and its events archived. Existing submissions and
              approval history will be retained.
            </p>
          ) : (
            <>
              <label>
                Initiative group name
                <input
                  required
                  maxLength={120}
                  value={name}
                  placeholder="AIESEC in EXAMPLE_IG"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {group.logoUrl && (
                <img
                  className="group-logo-preview"
                  src={group.logoUrl}
                  alt={group.name + " logo"}
                />
              )}
              <label>
                Group logo
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  required={!group.id}
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
                <small className="field-hint">
                  PNG, JPG or WebP · up to 2 MB
                </small>
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                Active group
              </label>
              <p className="field-hint">
                Inactive groups close new registrations and submissions.
              </p>
              {group.id && (
                <button
                  className="text-button danger-text"
                  type="button"
                  onClick={() => setDeleting(true)}
                >
                  Delete initiative group
                </button>
              )}
            </>
          )}
          <ErrorBox message={error} />
        </div>
        <div className="modal-footer">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => (deleting ? setDeleting(false) : onClose())}
          >
            Cancel
          </button>
          <button
            className={"button " + (deleting ? "cleanup-delete" : "primary")}
            disabled={busy}
          >
            {busy ? "Saving…" : deleting ? "Delete group" : "Save group"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
