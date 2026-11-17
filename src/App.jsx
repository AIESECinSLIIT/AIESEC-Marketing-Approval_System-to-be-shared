import React, { useEffect, useState, useRef } from "react";
import {
  LayoutDashboard,
  Inbox,
  Files,
  Users,
  Settings,
  Bell,
  Search,
  Plus,
  ArrowLeft,
  LogOut,
  Check,
  Clock3,
  RotateCcw,
  Menu,
  X,
  Grid2X2,
  List,
  SlidersHorizontal,
  HardDrive,
  CalendarDays,
  ArrowLeftRight,
} from "lucide-react";
import {
  api,
  json,
  ROLES,
  STATUSES,
  isAdmin,
  Avatar,
  Badge,
  Creative,
  Empty,
  ErrorBox,
  date,
} from "./lib.jsx";
import { SubmissionForm, SubmissionDetail } from "./Submissions.jsx";
import Login from "./Login.jsx";
import { UserManagement, SettingsPage, Notifications } from "./Management.jsx";
import StorageManager from "./StorageManager.jsx";
import Events from "./Events.jsx";
import Groups from "./Groups.jsx";
import Profiles from "./Profiles.jsx";
import {
  REVIEWER_ROLES,
  MANAGEMENT_ROLES,
  canSubmit,
  canReview,
  reviewerLabel,
} from "./workflow.js";

export default function App() {
  const sessionGeneration = useRef(0),
    refreshGeneration = useRef(0),
    refreshing = useRef(false);
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState("dashboard"),
    [submissions, setSubmissions] = useState([]),
    [notifications, setNotifications] = useState([]),
    [error, setError] = useState(""),
    [modal, setModal] = useState(null),
    [selected, setSelected] = useState(null),
    [detailVersion, setDetailVersion] = useState(0),
    [toast, setToast] = useState(""),
    [mobile, setMobile] = useState(false),
    [smallScreen, setSmallScreen] = useState(window.innerWidth <= 760),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("ALL"),
    [category, setCategory] = useState("ALL"),
    [view, setView] = useState("grid"),
    [sort, setSort] = useState("newest");
  useEffect(() => {
    api("/auth/me")
      .then((x) => signIn(x.user))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  function signIn(account) {
    sessionGeneration.current++;
    setUser(account);
    const params = new URLSearchParams(window.location.search);
    const submissionId = params.get("submission");
    if (submissionId && /^[a-f0-9-]{36}$/i.test(submissionId))
      setSelected(submissionId);
    if (params.get("notifications")) setPage("notifications");
    if (submissionId || params.get("notifications"))
      window.history.replaceState(null, "", "/");
    if (
      !params.get("notifications") &&
      window.matchMedia("(max-width: 760px)").matches &&
      REVIEWER_ROLES.includes(account.role)
    )
      setPage("queue");
  }
  async function refresh() {
    const session = sessionGeneration.current,
      request = ++refreshGeneration.current;
    refreshing.current = true;
    const current = () =>
      session === sessionGeneration.current &&
      request === refreshGeneration.current;
    try {
      const [a, b, account] = await Promise.all([
        api("/submissions"),
        api("/notifications"),
        api("/auth/me"),
      ]);
      if (!current()) return;
      setSubmissions(a.submissions);
      setNotifications(b.notifications);
      setUser(account.user);
      setError("");
    } catch (e) {
      if (!current()) return;
      if (e.status === 401) {
        setUser(null);
        setSelected(null);
        setModal(null);
        setPage("dashboard");
      }
      setError(e.message);
    } finally {
      if (current()) refreshing.current = false;
    }
  }
  useEffect(() => {
    if (user) {
      refresh();
      const wake = () => {
        if (document.visibilityState === "visible" && !refreshing.current)
          refresh();
      };
      const id = setInterval(wake, 30000);
      window.addEventListener("focus", wake);
      window.addEventListener("online", wake);
      document.addEventListener("visibilitychange", wake);
      return () => {
        clearInterval(id);
        window.removeEventListener("focus", wake);
        window.removeEventListener("online", wake);
        document.removeEventListener("visibilitychange", wake);
        sessionGeneration.current++;
        refreshing.current = false;
      };
    }
  }, [user?.id]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setSmallScreen(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(id);
    }
  }, [toast]);
  function navigate(p) {
    setPage(p);
    setSelected(null);
    setFilter("ALL");
    setQuery("");
    setMobile(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function changeProfile(account, submissionId = null) {
    sessionGeneration.current++;
    refreshGeneration.current++;
    refreshing.current = false;
    setSubmissions([]);
    setNotifications([]);
    setSelected(submissionId);
    setModal(null);
    setMobile(false);
    setError("");
    setQuery("");
    setFilter("ALL");
    setCategory("ALL");
    setUser(account);
    setPage(
      smallScreen && REVIEWER_ROLES.includes(account.role)
        ? "queue"
        : "dashboard",
    );
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  async function openSubmission(id, profileId) {
    if (profileId && profileId !== user.id) {
      try {
        const result = await api(
          "/profiles/switch",
          json("POST", { id: profileId }),
        );
        changeProfile(result.user, id);
      } catch (e) {
        setError(e.message);
      }
    } else {
      setSelected(id);
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }
  function closeSubmission() {
    setSelected(null);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function done(message) {
    setToast(message);
    refresh();
  }
  async function logout() {
    sessionGeneration.current++;
    refreshing.current = false;
    try {
      await api("/auth/logout", json("POST", {}));
      setUser(null);
      setSubmissions([]);
      setSelected(null);
      setModal(null);
      setPage("dashboard");
    } catch (e) {
      setToast(e.message);
    }
  }
  if (loading)
    return (
      <div className="loading-screen">
        <span className="spinner" />
        Opening Approval Hub…
      </div>
    );
  if (!user) return <Login onLogin={signIn} />;
  const reviewer = REVIEWER_ROLES.includes(user.role);
  const eventMonitor = ["OCP", "EVENT_MANAGER"].includes(user.role);
  const manager = MANAGEMENT_ROLES.includes(user.role);
  const canClean = ["ADMIN", "MARKETING_VP", "B2C_VP"].includes(user.role);
  const submitter = canSubmit(user);
  const missingEvent =
    user.role === "CREATOR" && (!user.eventId || !user.eventActive);
  const pending = submissions.filter(
    (s) => s.status === "PENDING" && canReview(user, s),
  );
  const unread = notifications.filter((n) => !n.readAt && !n.read).length;
  const nav = [
    [
      "dashboard",
      eventMonitor ? "Event overview" : "Overview",
      LayoutDashboard,
    ],
    ...(reviewer ? [["queue", "Approval queue", Inbox]] : []),
    [
      "submissions",
      eventMonitor
        ? "Event submissions"
        : reviewer
          ? "All submissions"
          : "My submissions",
      Files,
    ],
    ["notifications", "Notifications", Bell],
    ...(canClean ? [["storage", "Storage cleanup", HardDrive]] : []),
    ...(manager ? [["events", "Events", CalendarDays]] : []),
    ...(manager ? [["users", "Accounts", Users]] : []),
    ...(["ADMIN", "EM_VP"].includes(user.role)
      ? [["groups", "Initiative groups", Users]]
      : []),
  ];
  const pageTitle = {
    dashboard: eventMonitor ? user.eventName || "Event overview" : "Overview",
    queue: "Approval queue",
    submissions: eventMonitor
      ? "Event submissions"
      : reviewer
        ? "All submissions"
        : "My submissions",
    notifications: "Notifications",
    users: "Accounts",
    settings: "Settings",
    storage: "Storage cleanup",
    events: "Events",
    groups: "Initiative groups",
  }[page];
  const subset = page === "queue" ? pending : submissions;
  const counts = Object.fromEntries(
    Object.keys(STATUSES).map((k) => [
      k,
      subset.filter((s) => s.status === k).length,
    ]),
  );
  const filtered = subset
    .filter(
      (s) =>
        (filter === "ALL" || s.status === filter) &&
        (category === "ALL" || s.category === category) &&
        [s.title, s.event, s.creatorName, s.caption]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "schedule"
        ? new Date(a.scheduledAt || "2100-01-01") -
          new Date(b.scheduledAt || "2100-01-01")
        : sort === "oldest"
          ? new Date(a.createdAt) - new Date(b.createdAt)
          : new Date(b.updatedAt) - new Date(a.updatedAt),
    );
  const listPage = ["dashboard", "queue", "submissions"].includes(page);
  const nextReview =
    page === "queue" ? filtered.find((s) => s.id !== selected) : null;
  const mobileNav = [
    [
      reviewer ? "queue" : "dashboard",
      reviewer ? "Review" : "Home",
      reviewer ? Inbox : LayoutDashboard,
    ],
    ["submissions", "Posts", Files],
    ["notifications", "Updates", Bell],
  ];
  return (
    <div
      className={`app-shell ${page === "queue" ? "queue-page" : ""} ${selected ? "showing-detail" : ""}`}
    >
      {mobile && (
        <div className="sidebar-overlay" onClick={() => setMobile(false)} />
      )}
      <aside
        className={"sidebar " + (mobile ? "open" : "")}
        inert={smallScreen && !mobile}
      >
        <button
          className="icon-button mobile-menu close-navigation"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        >
          <X size={22} />
        </button>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("dashboard");
          }}
        >
          {(user.organization || "ENTITY") === "ENTITY" ? (
            <img
              className="brand-logo"
              src="/entity-logo.svg"
              alt="AIESEC in Your Entity"
              width="514"
              height="220"
            />
          ) : user.logoUrl ? (
            <img
              className="brand-logo"
              src={user.logoUrl}
              alt={user.organizationName + " logo"}
            />
          ) : (
            <strong className="brand-group-name">
              {user.organizationName}
            </strong>
          )}
          <span className="hub-name">Approval Hub</span>
          {user.organization !== "ENTITY" && (
            <span className="scope-name">{user.organizationName}</span>
          )}
        </a>
        <nav>
          {nav.map(([id, label, Icon]) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => navigate(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "queue" && pending.length > 0 && <b>{pending.length}</b>}
              {id === "notifications" && unread > 0 && (
                <i className="nav-dot" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="settings-nav"
            onClick={() => setModal({ type: "profiles" })}
          >
            <ArrowLeftRight size={18} />
            Switch profile
          </button>
          <button
            className={"settings-nav " + (page === "settings" ? "active" : "")}
            onClick={() => navigate("settings")}
          >
            <Settings size={18} />
            Settings
          </button>
          <div className="user-panel">
            <Avatar name={user.name} />
            <div>
              <strong>{user.name}</strong>
              <small>{ROLES[user.role]}</small>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              title="Sign out"
              onClick={logout}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell" inert={smallScreen && mobile}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => (selected ? closeSubmission() : setMobile(true))}
              aria-label={selected ? "Back to submissions" : "Open navigation"}
            >
              {selected ? <ArrowLeft size={22} /> : <Menu size={22} />}
            </button>
            <strong>{selected ? "Submission details" : pageTitle}</strong>
          </div>
          <div className="topbar-right">
            <button
              className="icon-button notification-button"
              aria-label="View notifications"
              onClick={() => navigate("notifications")}
            >
              <Bell size={19} />
              {unread > 0 && <i />}
            </button>
            <button
              className="icon-button profile-switch-button"
              aria-label="Switch profile"
              title="Switch profile"
              onClick={() => setModal({ type: "profiles" })}
            >
              <Avatar name={user.name} small />
            </button>
          </div>
        </header>
        <main>
          <ErrorBox message={error} />
          {selected ? (
            <SubmissionDetail
              key={`${selected}-${detailVersion}`}
              id={selected}
              user={user}
              compact={smallScreen}
              onBack={closeSubmission}
              onNext={
                nextReview ? () => openSubmission(nextReview.id) : undefined
              }
              onEdit={(s) => setModal({ type: "submission", submission: s })}
              onChange={done}
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <h1>{pageTitle}</h1>
                  {page === "queue" && (
                    <p>
                      {pending.length} {pending.length === 1 ? "post" : "posts"}{" "}
                      awaiting review
                    </p>
                  )}
                </div>
                {listPage && submitter && (
                  <button
                    className="button primary"
                    disabled={missingEvent}
                    onClick={() => setModal({ type: "submission" })}
                  >
                    <Plus size={18} />
                    New submission
                  </button>
                )}
              </div>
              {missingEvent && (
                <p className="info-banner">
                  Ask the admin to assign an ongoing event to your account
                  before submitting. Your existing posts are still available
                  below.
                </p>
              )}
              {eventMonitor && listPage && (
                <p className="eventMonitor-context">
                  Read-only view · OCVP Marketing submissions for{" "}
                  {user.eventName || "your assigned event"}
                </p>
              )}
              {page === "dashboard" && (
                <>
                  <div className="stats-grid">
                    {[
                      ["PENDING", "Awaiting review", Clock3, "amber"],
                      ["APPROVED", "Approved", Check, "green"],
                      [
                        "CHANGES_REQUESTED",
                        "Changes requested",
                        RotateCcw,
                        "orange",
                      ],
                      ["ALL", "Total submissions", Files, "blue"],
                    ].map(([key, label, Icon, color]) => (
                      <button
                        key={key}
                        className={
                          "stat-card " +
                          (filter === key && key !== "ALL" ? "chosen" : "")
                        }
                        onClick={() => setFilter(key)}
                      >
                        <div>
                          <span>{label}</span>
                          <strong>
                            {key === "ALL"
                              ? submissions.length
                              : submissions.filter((s) => s.status === key)
                                  .length}
                          </strong>
                        </div>
                        <span className={"stat-icon " + color}>
                          <Icon size={20} />
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {listPage && (
                <section className="submissions-section">
                  <div className="section-title">
                    <h2>
                      {page === "dashboard"
                        ? eventMonitor
                          ? "Event submissions"
                          : reviewer
                            ? "Recent submissions"
                            : "Your submissions"
                        : page === "queue"
                          ? "Ready for review"
                          : "Submission library"}
                      <span>{subset.length}</span>
                    </h2>
                    <div className="view-toggle">
                      <button
                        aria-label="Grid view"
                        className={view === "grid" ? "active" : ""}
                        onClick={() => setView("grid")}
                      >
                        <Grid2X2 size={17} />
                      </button>
                      <button
                        aria-label="List view"
                        className={view === "list" ? "active" : ""}
                        onClick={() => setView("list")}
                      >
                        <List size={18} />
                      </button>
                    </div>
                  </div>
                  {page !== "queue" && (
                    <div className="status-tabs">
                      {[
                        ["ALL", "All submissions"],
                        ["PENDING", "Pending"],
                        ["APPROVED", "Approved"],
                        ["CHANGES_REQUESTED", "Changes requested"],
                        ["DRAFT", "Drafts"],
                        ["REJECTED", "Rejected"],
                      ].map(([value, label]) => (
                        <button
                          className={filter === value ? "active" : ""}
                          key={value}
                          onClick={() => setFilter(value)}
                        >
                          {label}
                          <span>
                            {value === "ALL" ? subset.length : counts[value]}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="filterbar">
                    <div className="search-field">
                      <Search size={17} />
                      <input
                        aria-label="Search submissions"
                        placeholder="Search by title, event, or creator…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      {query && (
                        <button
                          className="icon-button"
                          onClick={() => setQuery("")}
                          aria-label="Clear search"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                    <div className="filter-actions">
                      <label className="select-wrap">
                        <SlidersHorizontal size={15} />
                        <select
                          aria-label="Filter category"
                          value={category}
                          onChange={(e) => setCategory(e.target.value)}
                        >
                          <option value="ALL">All categories</option>
                          <option value="MARKETING">Marketing</option>
                          <option value="B2C">B2C</option>
                        </select>
                      </label>
                      <select
                        aria-label="Sort submissions"
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="newest">Latest activity</option>
                        <option value="oldest">Oldest first</option>
                        <option value="schedule">Posting date</option>
                      </select>
                    </div>
                  </div>
                  {filtered.length ? (
                    <div
                      className={
                        view === "grid" ? "submission-grid" : "submission-list"
                      }
                    >
                      {filtered.map((s) => (
                        <button
                          className="submission-card"
                          key={s.id}
                          onClick={() => openSubmission(s.id)}
                        >
                          <Creative submission={s} />
                          <div className="card-body">
                            <div className="card-meta">
                              <span
                                className={
                                  "category " + s.category.toLowerCase()
                                }
                              >
                                {s.category === "MARKETING"
                                  ? "Marketing"
                                  : "B2C"}
                              </span>
                              <span>{s.contentType || "Social post"}</span>
                            </div>
                            <h3>{s.title}</h3>
                            <p className="event-name">
                              {s.event ||
                                s.organizationName ||
                                "AIESEC in Your Entity"}
                            </p>
                            {s.status === "PENDING" && (
                              <p className="routing-label">
                                Awaiting {reviewerLabel(s)}
                              </p>
                            )}
                            <div className="card-status">
                              <Badge status={s.status} />
                              <span className="revision">
                                v{s.revision || 1}
                              </span>
                            </div>
                            <div className="card-footer">
                              <div>
                                <Avatar name={s.creatorName} small />
                                <span>
                                  {s.creatorName
                                    ?.split(" ")
                                    .slice(0, 2)
                                    .join(" ") || "Team member"}
                                </span>
                              </div>
                              <span>
                                <Clock3 size={12} />
                                {s.scheduledAt
                                  ? date(s.scheduledAt).replace(/ \d{4}$/, "")
                                  : "No date"}
                              </span>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      title={
                        query || filter !== "ALL" || category !== "ALL"
                          ? "No matching submissions"
                          : page === "queue"
                            ? "You’re all caught up"
                            : "No submissions yet"
                      }
                      text={
                        query
                          ? "Try a different search or filter."
                          : page === "queue"
                            ? "New submissions will appear here when they’re ready for you."
                            : ""
                      }
                    >
                      {page !== "queue" && submitter && !missingEvent && (
                        <button
                          className="button secondary"
                          onClick={() => setModal({ type: "submission" })}
                        >
                          <Plus size={16} />
                          Create submission
                        </button>
                      )}
                    </Empty>
                  )}
                  <div className="list-footer">
                    Showing {filtered.length} of {subset.length} submissions
                    <span></span>
                  </div>
                </section>
              )}
              {page === "users" && manager && (
                <UserManagement user={user} onChange={done} />
              )}
              {page === "events" && manager && (
                <Events user={user} onChange={done} />
              )}
              {page === "groups" && ["ADMIN", "EM_VP"].includes(user.role) && (
                <Groups onChange={done} />
              )}
              {page === "storage" && canClean && (
                <StorageManager
                  user={user}
                  onOpen={openSubmission}
                  onChange={done}
                />
              )}
              {page === "settings" && (
                <SettingsPage user={user} onChange={done} />
              )}
              {page === "notifications" && (
                <Notifications
                  items={notifications}
                  onRead={refresh}
                  onOpen={openSubmission}
                />
              )}
            </>
          )}
        </main>
      </div>
      {!selected && (
        <nav
          className="mobile-bottom-nav"
          aria-label="Mobile navigation"
          inert={mobile}
        >
          {mobileNav.map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => navigate(key)}
              aria-current={page === key ? "page" : undefined}
              className={page === key ? "active" : ""}
            >
              <span className="mobile-nav-icon">
                <Icon size={22} />
                {key === "queue" && pending.length > 0 && (
                  <b>{pending.length}</b>
                )}
                {key === "notifications" && unread > 0 && <i />}
              </span>
              <span>{label}</span>
            </button>
          ))}
          <button onClick={() => setMobile(true)} aria-label="Open menu">
            <Menu size={22} />
            <span>Menu</span>
          </button>
        </nav>
      )}
      {modal?.type === "profiles" && (
        <Profiles
          user={user}
          onClose={() => setModal(null)}
          onChange={changeProfile}
        />
      )}
      {modal?.type === "submission" && submitter && (
        <SubmissionForm
          user={user}
          submission={modal.submission}
          onClose={() => setModal(null)}
          onSave={(id) => {
            setModal(null);
            setDetailVersion((v) => v + 1);
            done("Submission saved successfully");
            openSubmission(id);
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
