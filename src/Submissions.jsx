import React, { useEffect, useState } from "react";
import { FILE_ACCEPT, validateUploads } from "./uploads.js";
import {
  reviewerLabel,
  normalizeDriveLink,
  igReviewable,
  canSubmit,
} from "./workflow.js";
import {
  Upload,
  X,
  ArrowRight,
  ArrowLeft,
  Check,
  RotateCcw,
  Ban,
  Pencil,
  Download,
  FileText,
  Clock3,
  MessageSquare,
  ShieldCheck,
  ExternalLink,
  ChevronDown,
} from "lucide-react";
import {
  api,
  json,
  Modal,
  ErrorBox,
  Badge,
  Creative,
  Avatar,
  canReview,
  date,
  STATUSES,
} from "./lib.jsx";

function VideoPreview({ file }) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      <video
        controls
        playsInline
        preload="metadata"
        src={file.url || "/api/files/" + file.id}
        onError={() => setFailed(true)}
      />
      {failed && (
        <p className="video-error" role="status">
          This browser cannot preview this video's format. Open the file below
          to watch it, or upload an MP4 exported with H.264.
        </p>
      )}
    </>
  );
}
function sriLankaInput(value) {
  if (!value) return "";
  return new Date(new Date(value).getTime() + 330 * 60000)
    .toISOString()
    .slice(0, 16);
}
export function SubmissionForm({ submission, user, onClose, onSave }) {
  const [form, setForm] = useState({
    title: submission?.title || "",
    event: submission?.event || "",
    contentType: submission?.contentType || "Social post",
    platform: submission?.platform || "Instagram",
    caption: submission?.caption || "",
    scheduledAt: sriLankaInput(submission?.scheduledAt),
    notes: submission?.notes || "",
    externalUrl: submission?.externalUrl || "",
  });
  const [files, setFiles] = useState([]),
    [progress, setProgress] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [drag, setDrag] = useState(false);
  const update = (e) => setForm({ ...form, [e.target.name]: e.target.value });
  function addFiles(incoming) {
    const all = [...files, ...Array.from(incoming)];
    try {
      validateUploads(all);
    } catch (e) {
      setError(e.message);
      return;
    }
    setFiles(all);
    setError("");
  }
  async function save(e) {
    e.preventDefault();
    const status = e.nativeEvent.submitter?.value || "PENDING";
    setError("");
    setBusy(true);
    setProgress(null);
    try {
      const externalUrl = normalizeDriveLink(form.externalUrl);
      const body = new FormData();
      Object.entries({ ...form, externalUrl }).forEach(([k, v]) =>
        body.append(
          k,
          k === "scheduledAt" && v
            ? new Date(v + ":00+05:30").toISOString()
            : v,
        ),
      );
      body.append("status", status);
      if (submission) body.append("version", submission.version);
      files.forEach((file) => body.append("files", file));
      const data = await api(
        "/submissions" + (submission ? "/" + submission.id : ""),
        {
          method: submission ? "PUT" : "POST",
          body,
          onUploadProgress: setProgress,
        },
      );
      onSave(data.submission?.id || data.id || submission?.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={submission ? "Edit submission" : "Create a submission"}
      onClose={() => !busy && onClose()}
      wide
    >
      <form onSubmit={save}>
        <div className="modal-body">
          <div className="form-section-title">
            <span>01</span>The essentials
          </div>
          <label>
            Submission title <em>*</em>
            <input
              name="title"
              required
              maxLength={160}
              value={form.title}
              onChange={update}
              placeholder="e.g. Global Village — registrations open"
            />
          </label>
          <div className="form-grid">
            <label>
              {user.role === "CREATOR"
                ? "Event"
                : "Campaign / project (optional)"}
              <input
                name="event"
                readOnly={user.role === "CREATOR"}
                maxLength={120}
                value={
                  user.role === "CREATOR"
                    ? user.eventName || "Ask the admin to assign your event"
                    : form.event
                }
                onChange={update}
                placeholder="e.g. Global Village 2026"
              />
            </label>
            <label>
              Posting date & time
              <input
                type="datetime-local"
                name="scheduledAt"
                value={form.scheduledAt}
                onChange={update}
              />
            </label>
          </div>
          <div className="form-grid">
            <label>
              Content type
              <select
                name="contentType"
                value={form.contentType}
                onChange={update}
              >
                {[
                  "Social post",
                  "Story",
                  "Reel",
                  "Video",
                  "Carousel",
                  "Poster",
                  "Announcement",
                ].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              Platform
              <select name="platform" value={form.platform} onChange={update}>
                {[
                  "Instagram",
                  "Facebook",
                  "LinkedIn",
                  "TikTok",
                  "WhatsApp",
                  "YouTube",
                  "Other",
                ].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-section-title">
            <span>02</span>The creative
          </div>
          <label
            className={"upload-zone " + (drag ? "drag" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            <Upload size={26} />
            <strong>
              <span>Choose images, videos or a PDF</span>
            </strong>
            <small>
              Up to 8 files · 50 MB each · MP4, MOV and WebM supported
            </small>
            <input
              aria-label="Upload creative files"
              type="file"
              multiple
              accept={FILE_ACCEPT}
              disabled={busy}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <label>
            Google Drive video link (optional)
            <input
              type="url"
              name="externalUrl"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              value={form.externalUrl}
              onChange={update}
              placeholder="https://drive.google.com/file/d/…/view"
              maxLength={2000}
            />
            <small className="field-hint">
              For videos over 50 MB, including 150–200 MB files. Give your
              reviewers and OCP viewing access in Drive before submitting.
            </small>
          </label>
          {submission && (
            <p className="field-hint">
              Uploading files replaces the current creative set. Leave empty to
              keep existing files. Earlier versions stay in history.
            </p>
          )}
          {files.map((f, i) => (
            <div className="file-row" key={i}>
              <FileText size={17} />
              <span>
                {f.name}
                <small>{(f.size / 1024 / 1024).toFixed(2)} MB</small>
              </span>
              <button
                type="button"
                disabled={busy}
                className="icon-button"
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
                aria-label={"Remove " + f.name}
              >
                <X size={16} />
              </button>
            </div>
          ))}
          <label>
            Caption <em>*</em>
            <textarea
              name="caption"
              rows={5}
              value={form.caption}
              onChange={update}
              required
              maxLength={10000}
              placeholder="Write the caption exactly as it should be published, including links and hashtags…"
            />
            <small className="field-hint">
              {form.caption.length.toLocaleString()} / 10,000 characters
            </small>
          </label>
          <label>
            Notes for your reviewer
            <textarea
              name="notes"
              rows={2}
              value={form.notes}
              onChange={update}
              maxLength={3000}
              placeholder="Anything else they should know?"
            />
          </label>
          <ErrorBox message={error} />
          {busy && progress !== null && (
            <div className="upload-progress" role="status">
              <progress
                value={progress}
                max={100}
                aria-label="Upload progress"
              />
              <span>
                {progress < 100
                  ? `Uploading… ${progress}%`
                  : "Saving submission…"}
              </span>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button
            type="submit"
            value="DRAFT"
            disabled={busy}
            className="button secondary"
          >
            Save draft
          </button>
          <button
            type="submit"
            value="PENDING"
            disabled={busy}
            className="button primary"
          >
            {busy
              ? "Saving…"
              : submission?.status === "CHANGES_REQUESTED"
                ? "Resubmit for review"
                : "Submit for review"}
            <ArrowRight size={17} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function SubmissionDetail({
  id,
  user,
  onBack,
  onEdit,
  onChange,
  onNext,
  compact = false,
}) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [decision, setDecision] = useState(""),
    [comment, setComment] = useState(""),
    [overridePassword, setOverridePassword] = useState(""),
    [busy, setBusy] = useState(false),
    [reviewComplete, setReviewComplete] = useState(false),
    [revision, setRevision] = useState(null);
  async function load() {
    try {
      const d = await api("/submissions/" + id);
      setData(d);
      setRevision(d.submission.revision);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    setData(null);
    load();
  }, [id]);
  async function review(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        "/submissions/" + id + "/review",
        json("POST", {
          decision,
          comment,
          password: overridePassword || undefined,
          version: data.submission.version,
        }),
      );
      setDecision("");
      setOverridePassword("");
      setComment("");
      await load();
      setReviewComplete(true);
      onChange("Decision recorded. The creator has been notified.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <>
        <button className="text-button" onClick={onBack}>
          <ArrowLeft size={16} />
          Back to submissions
        </button>
        <ErrorBox message={error} />
        <div className="empty">
          {error ? "Unable to open this submission." : "Loading submission…"}
        </div>
      </>
    );
  const s = data.submission,
    files = data.files || [],
    history = data.history || [];
  const editable =
    canSubmit(user) &&
    s.creatorId === user.id &&
    ["DRAFT", "CHANGES_REQUESTED"].includes(s.status);
  const reviewable =
    !s.cleanupRequestedAt &&
    canReview(user, s) &&
    s.status !== "DRAFT" &&
    (s.status === "PENDING" || user.role === "ADMIN" || igReviewable(user, s));
  const visibleFiles = files.filter(
    (f) => (f.revision || s.revision) === revision,
  );
  const oldRevision = revision !== s.revision;
  const viewed =
    data.revisions?.find((r) => r.revision === revision)?.snapshot || s;
  const showReviewControls = reviewable && !reviewComplete;
  function chooseDecision(value) {
    setDecision(value);
    setComment("");
    setError("");
  }
  return (
    <div
      className={
        showReviewControls || reviewComplete
          ? "submission-detail has-review-dock"
          : "submission-detail"
      }
    >
      <button className="text-button back" onClick={onBack}>
        <ArrowLeft size={16} />
        Back to submissions
      </button>
      <div className="detail-heading">
        <div>
          <div className="detail-labels">
            <span className={"category " + s.category.toLowerCase()}>
              {s.category === "MARKETING" ? "Marketing" : "B2C"}
            </span>
            <Badge status={s.status} />
            <span className="revision">Version {s.revision}</span>
          </div>
          <h1>{s.title}</h1>
          <p>
            {s.event && (
              <>
                {s.event} <span>·</span>{" "}
              </>
            )}
            Submitted by {s.creatorName}
          </p>
        </div>
        {editable && (
          <button className="button primary" onClick={() => onEdit(s)}>
            <Pencil size={16} />
            Edit {s.status === "CHANGES_REQUESTED" ? "& resubmit" : "draft"}
          </button>
        )}
      </div>
      <ErrorBox message={error} />
      {s.organization !== "ENTITY" &&
        ["CREATOR", "MARKETING_MEMBER", "B2C_MEMBER"].includes(
          s.submitterRole,
        ) && (
          <div className="approval-progress" aria-label="Approval progress">
            <span className={s.reviewStage === "IG" ? "current" : "complete"}>
              1 · Initiative group review
            </span>
            <ArrowRight size={16} />
            <span className={s.reviewStage === "LC" ? "current" : ""}>
              2 · ENTITY final approval
            </span>
            {s.status === "PENDING" && (
              <strong>Awaiting {reviewerLabel(s)}</strong>
            )}
          </div>
        )}
      {reviewComplete && (
        <section className="review-receipt" role="status">
          <div>
            <Check size={20} />
            <strong>Decision saved</strong>
            <Badge status={s.status} />
          </div>
          <p>
            {s.status === "PENDING" && s.reviewStage === "LC"
              ? "Sent to ENTITY for final approval. The creator has been notified."
              : "The submitter and relevant team members have been notified."}
          </p>
          {onNext && (
            <button className="button primary" onClick={onNext}>
              Review next
              <ArrowRight size={18} />
            </button>
          )}
        </section>
      )}
      <div className="mobile-review-context">
        <span>
          {s.platform} · {s.contentType}
        </span>
        <span>
          <Clock3 size={14} />
          {s.scheduledAt ? date(s.scheduledAt, true) : "No posting date"}
        </span>
      </div>
      <div className="detail-grid">
        <div>
          <section className="panel preview-panel">
            <div className="panel-heading">
              <h2>Creative preview</h2>
              <select
                aria-label="Creative version"
                value={revision}
                onChange={(e) => setRevision(Number(e.target.value))}
              >
                {Array.from(
                  { length: s.revision },
                  (_, i) => s.revision - i,
                ).map((r) => (
                  <option value={r} key={r}>
                    Version {r}
                    {r === s.revision ? " · Current" : ""}
                  </option>
                ))}
              </select>
            </div>
            {oldRevision && (
              <div className="info-banner">
                You’re viewing an earlier creative version. Decisions apply to
                the current version.
              </div>
            )}
            {s.cleanupRequestedAt ? (
              <p className="notification-empty">
                {s.creativesDeletedAt
                  ? `Creative files deleted on ${date(s.creativesDeletedAt)}.`
                  : "Creative cleanup is pending. A reviewer can retry it from Storage cleanup."}{" "}
                Captions and approval history are retained.
              </p>
            ) : visibleFiles.length ? (
              visibleFiles.map((f) => (
                <div className="file-preview" key={f.id}>
                  {f.mime?.startsWith("image/") ? (
                    <a
                      className="creative-expand"
                      href={f.url || "/api/files/" + f.id}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${f.name} at full size`}
                    >
                      <img src={f.url || "/api/files/" + f.id} alt={f.name} />
                      <span>
                        <ExternalLink size={14} />
                        Open full size
                      </span>
                    </a>
                  ) : f.mime?.startsWith("video/") ? (
                    <VideoPreview file={f} />
                  ) : (
                    <div className="pdf-preview">
                      <FileText size={40} />
                      <strong>{f.name}</strong>
                      <a
                        href={f.url || "/api/files/" + f.id}
                        target="_blank"
                        rel="noreferrer"
                        className="button secondary"
                      >
                        Open PDF
                        <ExternalLink size={14} />
                      </a>
                    </div>
                  )}
                  <a
                    className="attachment-link"
                    href={f.url || "/api/files/" + f.id}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <FileText size={14} />
                    {f.name}
                    <Download size={15} />
                  </a>
                </div>
              ))
            ) : viewed.externalUrl ? (
              <div className="drive-preview">
                <FileText size={36} />
                <p>This creative is shared through Google Drive.</p>
                <a
                  className="button secondary"
                  href={viewed.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open video
                  <ExternalLink size={16} />
                </a>
              </div>
            ) : (
              <Creative submission={{ ...s, thumbnailId: null }} large />
            )}
          </section>
          {viewed.externalUrl &&
            visibleFiles.length > 0 &&
            !s.cleanupRequestedAt && (
              <section className="panel drive-panel">
                <h2>Video on Google Drive</h2>
                <p className="muted">
                  Opens the creator’s shared video. If access is restricted, ask
                  the creator to share it with you.
                </p>
                <a
                  className="button secondary"
                  href={viewed.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={17} />
                  Open video
                </a>
              </section>
            )}
          <section className="panel caption-panel">
            <h2>
              Caption{" "}
              <span className="muted">
                · {oldRevision ? `Version ${revision}` : "Current version"}
              </span>
            </h2>
            <p className="caption-text">
              {viewed.caption || "No caption yet."}
            </p>
            {viewed.notes && (
              <div className="reviewer-note">
                <span className="eyebrow">NOTES FOR THE REVIEWER</span>
                <p>{viewed.notes}</p>
              </div>
            )}
          </section>
          <details
            className="panel history-panel"
            open={compact ? undefined : true}
          >
            <summary>
              <MessageSquare size={17} />
              <strong>Submission history</strong>
              <span>{history.length}</span>
              <ChevronDown size={16} />
            </summary>
            <div className="timeline">
              {history.length ? (
                history.map((h, i) => (
                  <div className="timeline-item" key={h.id || i}>
                    <span className="timeline-dot">
                      <MessageSquare size={13} />
                    </span>
                    <div>
                      <strong>
                        {h.actorName || "System"}{" "}
                        <span>
                          {String(h.action).replaceAll("_", " ").toLowerCase()}
                        </span>
                      </strong>
                      <small>
                        {date(h.createdAt, true)} · v{h.revision || 1}
                      </small>
                      {h.comment && <p>{h.comment}</p>}
                    </div>
                  </div>
                ))
              ) : (
                <p className="muted">No actions recorded yet.</p>
              )}
            </div>
          </details>
        </div>
        <aside className="detail-aside">
          <details
            className="panel meta-panel"
            open={compact ? undefined : true}
          >
            <summary>
              <FileText size={17} />
              <strong>Submission details</strong>
              <ChevronDown size={16} />
            </summary>
            <dl className="details-list">
              <dt>Created by</dt>
              <dd className="person">
                <Avatar name={s.creatorName} small />
                {s.creatorName}
              </dd>
              <dt>Reviewer</dt>
              <dd>
                {reviewerLabel(s)}
                {s.organization !== "ENTITY" &&
                  ["CREATOR", "MARKETING_MEMBER", "B2C_MEMBER"].includes(
                    s.submitterRole,
                  ) && (
                    <small>
                      {s.reviewStage === "IG"
                        ? "Stage 1 of 2 · then ENTITY final approval"
                        : "Stage 2 of 2 · ENTITY final approval"}
                    </small>
                  )}
              </dd>
              <dt>{s.eventId ? "Event" : "Campaign / project"}</dt>
              <dd>{s.event || "—"}</dd>
              <dt>Committee / group</dt>
              <dd>{s.organizationName || "AIESEC in Your Entity"}</dd>
              <dt>Platform</dt>
              <dd>{s.platform}</dd>
              <dt>Content type</dt>
              <dd>{s.contentType}</dd>
              <dt>Planned publication</dt>
              <dd>{date(s.scheduledAt, true)}</dd>
              <dt>Submitted</dt>
              <dd>{date(s.createdAt, true)}</dd>
            </dl>
          </details>
          {showReviewControls && (
            <section className="panel review-panel">
              <div className="review-icon">
                <ShieldCheck size={23} />
              </div>
              <h2>
                {s.status === "PENDING"
                  ? "Ready for your review"
                  : user.role === "ADMIN"
                    ? "Admin decision override"
                    : "IG decision override"}
              </h2>
              <p className="muted">
                Check the creative and caption, then leave your decision.
              </p>
              {s.status !== "PENDING" && (
                <div className="info-banner">
                  Changing a previous decision requires a reason and is saved in
                  the history.
                </div>
              )}
              <button
                className="button approve full"
                disabled={oldRevision}
                onClick={() => {
                  setDecision("APPROVED");
                  setComment("");
                }}
              >
                <Check size={17} />
                Approve submission
              </button>
              <button
                className="button secondary full"
                disabled={oldRevision}
                onClick={() => {
                  setDecision("CHANGES_REQUESTED");
                  setComment("");
                }}
              >
                <RotateCcw size={16} />
                Request changes
              </button>
              <button
                className="button danger-quiet full"
                disabled={oldRevision}
                onClick={() => {
                  setDecision("REJECTED");
                  setComment("");
                }}
              >
                <Ban size={16} />
                Reject submission
              </button>
              {user.role === "ADMIN" && s.status !== "PENDING" && (
                <button
                  className="text-button"
                  onClick={() => {
                    setDecision("PENDING");
                    setComment("");
                  }}
                >
                  Reopen for review
                  <ArrowRight size={14} />
                </button>
              )}
            </section>
          )}
          {s.status === "APPROVED" && (
            <div className="approved-note">
              <Check size={20} />
              <div>
                <strong>Good to go!</strong>
                <p>This version is approved for publication.</p>
              </div>
            </div>
          )}
          {s.status === "CHANGES_REQUESTED" && (
            <div className="changes-note">
              <RotateCcw size={20} />
              <div>
                <strong>A few tweaks to make</strong>
                <p>
                  Check the feedback in the history, update your content, and
                  resubmit.
                </p>
              </div>
            </div>
          )}
        </aside>
      </div>
      {compact && (showReviewControls || reviewComplete) && (
        <div className="mobile-review-dock" aria-label="Review actions">
          {reviewComplete ? (
            <>
              <span className="dock-label">
                <Check size={14} />
                Decision saved · {STATUSES[s.status]}
              </span>
              <div className="dock-complete-actions">
                <button className="button secondary" onClick={onBack}>
                  Back to posts
                </button>
                {onNext && (
                  <button className="button primary" onClick={onNext}>
                    Review next
                    <ArrowRight size={17} />
                  </button>
                )}
              </div>
            </>
          ) : oldRevision ? (
            <>
              <span className="dock-label">
                Viewing version {revision} · Review the latest creative
              </span>
              <button
                className="button primary full"
                onClick={() => setRevision(s.revision)}
              >
                Return to current version
                <ArrowRight size={17} />
              </button>
            </>
          ) : (
            <>
              <span className="dock-label">
                {s.status === "PENDING"
                  ? `Reviewing version ${s.revision}`
                  : "Decision override · A reason is required"}
              </span>
              <div className="dock-actions">
                <button
                  className="button danger-quiet"
                  onClick={() => chooseDecision("REJECTED")}
                >
                  <Ban size={17} />
                  Reject
                </button>
                <button
                  className="button secondary"
                  onClick={() => chooseDecision("CHANGES_REQUESTED")}
                >
                  <RotateCcw size={17} />
                  Changes
                </button>
                <button
                  className="button approve"
                  onClick={() => chooseDecision("APPROVED")}
                >
                  <Check size={18} />
                  Approve
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {decision && (
        <Modal
          className="decision-modal"
          title={
            decision === "PENDING" ? "Reopen submission" : STATUSES[decision]
          }
          onClose={() => !busy && setDecision("")}
        >
          <form onSubmit={review}>
            <div className="modal-body">
              <p className="muted">
                {decision === "APPROVED"
                  ? s.reviewStage === "IG" || igReviewable(user, s)
                    ? "Approve this version and send it to ENTITY for final approval. It is not ready to publish yet."
                    : "Confirm that the current creative and caption are ready to publish."
                  : decision === "REJECTED"
                    ? "This closes the submission. Explain why it should not be published."
                    : decision === "PENDING"
                      ? "Explain why this submission needs another review."
                      : "Give the creator clear, actionable feedback for the next version."}
              </p>
              <label>
                {decision === "APPROVED" &&
                s.status === "PENDING" &&
                !(igReviewable(user, s) && s.reviewStage === "LC")
                  ? "Comment (optional)"
                  : "Reason / feedback *"}
                <textarea
                  rows={4}
                  value={comment}
                  required={
                    decision !== "APPROVED" ||
                    s.status !== "PENDING" ||
                    (igReviewable(user, s) && s.reviewStage === "LC")
                  }
                  maxLength={5000}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Add your feedback…"
                />
              </label>
              {user.role === "ADMIN" && s.status !== "PENDING" && (
                <label>
                  Administrator password
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={overridePassword}
                    onChange={(e) => setOverridePassword(e.target.value)}
                  />
                </label>
              )}
              <ErrorBox message={error} />
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDecision("")}
              >
                Cancel
              </button>
              <button
                className={
                  "button " + (decision === "APPROVED" ? "approve" : "primary")
                }
                disabled={busy}
              >
                {busy ? "Saving…" : "Confirm decision"}
                <Check size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
