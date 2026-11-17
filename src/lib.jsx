import React, { useEffect, useRef, useId } from "react";
import { X, Check, Clock3, RotateCcw, Ban, FileText } from "lucide-react";
export { ROLES, canReview, approvalCategoryForRole } from "./workflow.js";
const cloudEnabled = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
);
export const STATUSES = {
  DRAFT: "Draft",
  PENDING: "Pending review",
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REJECTED: "Rejected",
};
export const isAdmin = (u) => u?.role === "ADMIN";
export async function api(path, options = {}) {
  if (cloudEnabled) return (await import("./cloud.js")).cloudApi(path, options);
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.error || data.message || "Something went wrong. Please try again.",
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
export const json = (method, body) => ({ method, body: JSON.stringify(body) });
export const initials = (name) =>
  (name || "User")
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
export function date(value, withTime = false) {
  if (!value) return "Not scheduled";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(withTime
      ? { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Colombo" }
      : { year: "numeric", timeZone: "Asia/Colombo" }),
  });
}
export function Badge({ status }) {
  const Icon =
    {
      DRAFT: FileText,
      PENDING: Clock3,
      APPROVED: Check,
      CHANGES_REQUESTED: RotateCcw,
      REJECTED: Ban,
    }[status] || Clock3;
  return (
    <span className={"badge " + status?.toLowerCase()}>
      <Icon size={12} />
      {STATUSES[status] || status}
    </span>
  );
}
export function Avatar({ name, small = false }) {
  return (
    <span className={"avatar " + (small ? "small" : "")}>{initials(name)}</span>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
}) {
  const ref = useRef(null);
  const headingRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const last = document.activeElement;
    const body = document.body;
    const savedStyle = Object.fromEntries(
      ["overflow", "position", "top", "left", "width"].map((key) => [
        key,
        body.style[key],
      ]),
    );
    const scroll = { top: window.scrollY, left: window.scrollX };
    const lockPosition = window.matchMedia(
      "(max-width: 760px), (pointer: coarse)",
    ).matches;
    body.style.overflow = "hidden";
    // overflow:hidden alone still lets the background move on iOS.
    if (lockPosition) {
      Object.assign(body.style, {
        position: "fixed",
        top: `${-scroll.top}px`,
        left: `${-scroll.left}px`,
        width: "100%",
      });
    }
    const viewport = window.visualViewport;
    let frame;
    const revealField = () => {
      const field = document.activeElement;
      const scroller = dialog.querySelector(".modal-body");
      if (
        !scroller?.contains(field) ||
        !field.matches("input, textarea, select")
      )
        return;
      const bounds = scroller.getBoundingClientRect();
      const rect = field.getBoundingClientRect();
      // Scroll only the form, keeping its title and actions in place.
      if (rect.height > bounds.height - 24 || rect.top < bounds.top + 12) {
        scroller.scrollTop += rect.top - bounds.top - 12;
      } else if (rect.bottom > bounds.bottom - 12) {
        scroller.scrollTop += rect.bottom - bounds.bottom + 12;
      }
    };
    const fitKeyboard = () => {
      // Preserve user-controlled pinch zoom instead of chasing its viewport.
      if (viewport && Math.abs(viewport.scale - 1) > 0.02) return;
      const height = viewport?.height ?? window.innerHeight;
      const bottom = Math.max(
        0,
        window.innerHeight - height - (viewport?.offsetTop ?? 0),
      );
      dialog.style.setProperty(
        "--dialog-max-height",
        `${Math.max(0, height - 16)}px`,
      );
      dialog.style.setProperty("--dialog-bottom", `${bottom}px`);
      dialog.dataset.keyboardOpen = String(window.innerHeight - height > 100);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(revealField);
    };
    fitKeyboard();
    viewport?.addEventListener("resize", fitKeyboard);
    viewport?.addEventListener("scroll", fitKeyboard);
    window.addEventListener("resize", fitKeyboard);
    dialog.addEventListener("focusin", fitKeyboard);
    dialog.showModal();
    headingRef.current?.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", fitKeyboard);
      viewport?.removeEventListener("scroll", fitKeyboard);
      window.removeEventListener("resize", fitKeyboard);
      dialog.removeEventListener("focusin", fitKeyboard);
      dialog.close();
      Object.assign(body.style, savedStyle);
      if (lockPosition) window.scrollTo({ ...scroll, behavior: "instant" });
      if (last?.isConnected) last.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={"modal " + (wide ? "wide " : "") + className}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2 ref={headingRef} id={titleId} tabIndex={-1}>
          {title}
        </h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  title = "Nothing here yet",
  text = "Your submissions will appear here.",
  children,
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <FileText size={28} />
      </div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}
export function ErrorBox({ message }) {
  return message ? (
    <div className="error" role="alert">
      {message}
    </div>
  ) : null;
}
export function Creative({ submission, large = false }) {
  if (submission.thumbnailId || submission.thumbnailUrl)
    return (
      <div className={"creative image " + (large ? "large" : "")}>
        <img
          src={
            submission.thumbnailUrl || "/api/files/" + submission.thumbnailId
          }
          alt={submission.title}
          loading={large ? "eager" : "lazy"}
          decoding="async"
        />
      </div>
    );
  const themes = ["ocean", "sunshine", "forest", "lilac"];
  const theme =
    themes[
      Array.from(String(submission.id || submission.title)).reduce(
        (a, c) => a + c.charCodeAt(0),
        0,
      ) % themes.length
    ];
  return (
    <div className={"creative " + theme + " " + (large ? "large" : "")}>
      <span className="creative-brand">
        {submission.organization && submission.organization !== "ENTITY" ? (
          submission.organizationLogoUrl ? (
            <img
              className="creative-org-logo"
              src={submission.organizationLogoUrl}
              alt={submission.organizationName + " logo"}
            />
          ) : (
            submission.organizationName
          )
        ) : (
          <>{submission.organizationName || "AIESEC in Your Entity"}</>
        )}
      </span>
      <div className="creative-ring" />
      <div className="creative-type">
        <span>{submission.event || "CREATE AN IMPACT"}</span>
        <strong>{submission.title}</strong>
        <span className="creative-bottom">
          Ideas that move us forward. <span>↗</span>
        </span>
      </div>
      <span className="placeholder-label">
        {submission.fileCount
          ? "Open to view files"
          : "Creative preview placeholder"}
      </span>
    </div>
  );
}
