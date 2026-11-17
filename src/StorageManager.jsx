import React, { useEffect, useState } from "react";
import { HardDrive, Trash2, RefreshCw } from "lucide-react";
import { api, json, Badge, Modal, ErrorBox, date } from "./lib.jsx";

export function storageSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
export default function StorageManager({ user, onOpen, onChange }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [days, setDays] = useState("30"),
    [status, setStatus] = useState("ALL"),
    [category, setCategory] = useState("ALL"),
    [sort, setSort] = useState("oldest"),
    [selected, setSelected] = useState(new Set()),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [result, setResult] = useState("");
  async function load() {
    try {
      setData(await api("/storage"));
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, []);
  const rows = data?.submissions || [];
  const filtered = rows
    .filter(
      (s) =>
        (s.cleanupRequestedAt ||
          !Number(days) ||
          new Date(s.updatedAt).getTime() <=
            Date.now() - Number(days) * 86400000) &&
        (status === "ALL" || s.status === status) &&
        (category === "ALL" || s.category === category),
    )
    .sort((a, b) =>
      sort === "largest"
        ? b.bytes - a.bytes
        : new Date(a.updatedAt) - new Date(b.updatedAt),
    );
  const chosen = filtered.filter((s) => selected.has(s.id));
  const chosenBytes = chosen.reduce((n, s) => n + Number(s.bytes), 0);
  const chosenFiles = chosen.reduce((n, s) => n + Number(s.fileCount), 0);
  function filter(setter, value) {
    setter(value);
    setSelected(new Set());
  }
  function toggle(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 20) next.add(id);
      return next;
    });
  }
  async function remove() {
    setBusy(true);
    setError("");
    setResult("");
    let bytes = 0,
      files = 0,
      completed = 0;
    const failures = [];
    for (const [index, s] of chosen.entries()) {
      setProgress(`Deleting ${index + 1} of ${chosen.length}…`);
      try {
        const saved = await api(
          `/submissions/${s.id}/creatives`,
          json("DELETE", { version: s.version }),
        );
        bytes += Number(saved.bytesFreed);
        files += Number(saved.filesDeleted);
        completed++;
      } catch (e) {
        failures.push(`${s.title}: ${e.message}`);
      }
    }
    setConfirm(false);
    setSelected(new Set());
    setBusy(false);
    setProgress("");
    setResult(`${files} files deleted · ${storageSize(bytes)} freed`);
    if (failures.length)
      setError(
        `${failures.length} submission(s) need another attempt. ${failures[0]}`,
      );
    await load();
    if (completed)
      onChange(
        `Cleanup finished for ${completed} submission${completed === 1 ? "" : "s"}.`,
      );
  }
  return (
    <>
      <div className="storage-summary">
        <section className="panel">
          <HardDrive size={23} />
          <div>
            <span className="muted">Club creative storage</span>
            <strong>
              {data ? storageSize(Number(data.usedBytes)) : "Loading…"}
            </strong>
          </div>
        </section>
        <section className="panel">
          <Trash2 size={23} />
          <div>
            <span className="muted">Completed files you can delete</span>
            <strong>
              {storageSize(rows.reduce((n, s) => n + Number(s.bytes), 0))}
            </strong>
          </div>
        </section>
      </div>
      <section className="panel storage-panel">
        <div className="panel-heading">
          <h2>Clean up creatives</h2>
          <button
            className="icon-button"
            aria-label="Refresh storage"
            disabled={busy}
            onClick={() => {
              setError("");
              load();
            }}
          >
            <RefreshCw size={18} />
          </button>
        </div>
        <p className="muted">
          Delete files from completed submissions. Captions, decisions and
          history stay.
        </p>
        <div className="storage-filters">
          <label>
            Age
            <select
              disabled={busy}
              value={days}
              onChange={(e) => filter(setDays, e.target.value)}
            >
              <option value="30">30+ days old</option>
              <option value="60">60+ days old</option>
              <option value="90">90+ days old</option>
              <option value="0">All completed</option>
            </select>
          </label>
          <label>
            Status
            <select
              disabled={busy}
              value={status}
              onChange={(e) => filter(setStatus, e.target.value)}
            >
              <option value="ALL">Approved & rejected</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </label>
          {user.role === "ADMIN" && (
            <label>
              Category
              <select
                disabled={busy}
                value={category}
                onChange={(e) => filter(setCategory, e.target.value)}
              >
                <option value="ALL">All categories</option>
                <option value="MARKETING">Marketing</option>
                <option value="B2C">B2C</option>
              </select>
            </label>
          )}
          <label>
            Sort
            <select
              disabled={busy}
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="oldest">Oldest first</option>
              <option value="largest">Largest first</option>
            </select>
          </label>
        </div>
        <ErrorBox message={error} />
        {result && (
          <p className="storage-result" role="status">
            {result}
          </p>
        )}
        {filtered.length > 0 && (
          <div className="cleanup-toolbar">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                setSelected(
                  selected.size
                    ? new Set()
                    : new Set(filtered.slice(0, 20).map((s) => s.id)),
                )
              }
            >
              {selected.size ? "Clear selection" : "Select up to 20"}
            </button>
            <button
              className="button danger-quiet"
              disabled={busy || !chosen.length}
              onClick={() => setConfirm(true)}
            >
              <Trash2 size={17} />
              Delete selected{chosen.length ? ` (${chosen.length})` : ""}
            </button>
          </div>
        )}
        <div className="cleanup-list">
          {filtered.map((s) => (
            <div className="cleanup-row" key={s.id}>
              <label className="cleanup-select">
                <input
                  type="checkbox"
                  aria-label={`Select ${s.title}`}
                  disabled={
                    busy || (!selected.has(s.id) && selected.size >= 20)
                  }
                  checked={selected.has(s.id)}
                  onChange={() => toggle(s.id)}
                />
              </label>
              <div className="cleanup-info">
                <button
                  className="text-button cleanup-title"
                  disabled={busy}
                  onClick={() => onOpen(s.id)}
                >
                  {s.title}
                </button>
                <p>
                  {s.event} · {s.category === "MARKETING" ? "Marketing" : "B2C"}
                </p>
                <small>
                  Decided {date(s.updatedAt)}
                  {s.cleanupRequestedAt ? " · Cleanup needs retry" : ""}
                </small>
              </div>
              <div className="cleanup-meta">
                <Badge status={s.status} />
                <strong>{storageSize(Number(s.bytes))}</strong>
                <small>{s.fileCount} files · all versions</small>
              </div>
            </div>
          ))}
        </div>
        {data && !filtered.length && (
          <p className="notification-empty">
            No completed submissions match these filters.
          </p>
        )}
      </section>
      {confirm && (
        <Modal
          title="Delete creative files?"
          onClose={() => !busy && setConfirm(false)}
        >
          <div className="modal-body">
            <p>
              Permanently delete{" "}
              <strong>
                {chosenFiles} files ({storageSize(chosenBytes)})
              </strong>{" "}
              from {chosen.length} submission{chosen.length === 1 ? "" : "s"},
              including every older version?
            </p>
            <p>
              Captions, decisions and history will remain. Deleted files cannot
              be recovered, and these submissions cannot be reopened.
            </p>
            <ul className="cleanup-confirm-list">
              {chosen.map((s) => (
                <li key={s.id}>{s.title}</li>
              ))}
            </ul>
            {busy && <p role="status">{progress}</p>}
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
            <button
              className="button cleanup-delete"
              disabled={busy}
              onClick={remove}
            >
              <Trash2 size={17} />
              {busy ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
