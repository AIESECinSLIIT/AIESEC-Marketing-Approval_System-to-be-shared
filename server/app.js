import express from "express";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  mkdirSync,
  existsSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import {
  ROLES as ROLE_NAMES,
  EVENT_ROLES,
  SELF_SIGNUP_ROLES,
  approvalCategoryForRole,
  initialStage,
  canView,
  canReview as workflowCanReview,
  reviewerRole,
  normalizeDriveLink,
} from "../src/workflow.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROLES = Object.keys(ROLE_NAMES);
const ADMIN_EMAIL = "admin@your-entity.example";
const now = () => new Date().toISOString();
const id = () => randomUUID();
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
const isAdmin = (user) => user.role === "ADMIN";
function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(":");
    return timingSafeEqual(
      scryptSync(password, salt, 64),
      Buffer.from(hash, "hex"),
    );
  } catch {
    return false;
  }
}
function validPassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 200)
    fail(400, "Passwords must contain 12 to 200 characters.");
  return value;
}
function clean(value, label, max, required = false) {
  if (typeof value !== "string") {
    if (!required && value == null) return "";
    fail(400, `${label} is required.`);
  }
  const text = value.trim();
  if ((required && !text) || text.length > max)
    fail(400, `${label} must be ${required ? "1" : "0"}–${max} characters.`);
  return text;
}
function emailAddress(value) {
  const email = clean(value, "Email", 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    fail(400, "Enter a valid email address.");
  return email;
}

export function createApp(options = {}) {
  const databasePath =
    options.databasePath ||
    process.env.DATABASE_PATH ||
    path.join(ROOT, "data/approvals.sqlite");
  const uploadDir = path.resolve(
    options.uploadDir ||
      process.env.UPLOAD_DIR ||
      path.join(ROOT, "data/uploads"),
  );
  const production = process.env.NODE_ENV === "production";
  if (databasePath !== ":memory:")
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  mkdirSync(uploadDir, { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES users(id), creator_name TEXT NOT NULL, title TEXT NOT NULL, event TEXT NOT NULL, category TEXT NOT NULL, content_type TEXT NOT NULL, platform TEXT NOT NULL, caption TEXT NOT NULL, scheduled_at TEXT, notes TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), revision INTEGER NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, disk_name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS revisions (submission_id TEXT NOT NULL REFERENCES submissions(id), revision INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(submission_id,revision));
    CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, comment TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), submission_id TEXT REFERENCES submissions(id), title TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
    CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, entity_id TEXT, details TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS creative_cleanup (submission_id TEXT PRIMARY KEY REFERENCES submissions(id), files TEXT NOT NULL, bytes INTEGER NOT NULL, file_count INTEGER NOT NULL, completed_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_submission_creator ON submissions(creator_id);
    CREATE INDEX IF NOT EXISTS idx_submission_category_status ON submissions(category,status);
    CREATE INDEX IF NOT EXISTS idx_files_submission ON files(submission_id,revision);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_history_submission ON history(submission_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
  for (const column of ["cleanup_requested_at", "creatives_deleted_at"]) {
    if (
      !db
        .prepare("PRAGMA table_info(submissions)")
        .all()
        .some((c) => c.name === column)
    )
      db.exec(`ALTER TABLE submissions ADD COLUMN ${column} TEXT`);
  }
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  db.exec(
    "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL)",
  );
  for (const [table, columns] of Object.entries({
    events: { organization: "TEXT NOT NULL DEFAULT 'ENTITY'" },
    users: {
      organization: "TEXT NOT NULL DEFAULT 'ENTITY'",
      event_id: "TEXT REFERENCES events(id)",
      deleted_at: "TEXT",
    },
    submissions: {
      organization: "TEXT NOT NULL DEFAULT 'ENTITY'",
      event_id: "TEXT REFERENCES events(id)",
      submitter_role: "TEXT NOT NULL DEFAULT 'CREATOR'",
      review_stage: "TEXT NOT NULL DEFAULT 'LC'",
      external_url: "TEXT NOT NULL DEFAULT ''",
    },
  })) {
    const existing = new Set(
      all(`PRAGMA table_info(${table})`).map((c) => c.name),
    );
    for (const [key, type] of Object.entries(columns))
      if (!existing.has(key))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${key} ${type}`);
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS one_committee_vp ON users(role) WHERE deleted_at IS NULL AND role IN ('MARKETING_VP','B2C_VP','IGVP_MARKETING','IGVP_OGV')",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS one_ocp_per_event ON users(event_id) WHERE deleted_at IS NULL AND role='OCP'",
  );
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  function publicUser(row) {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      active: !!row.active,
      createdAt: row.created_at,
      organization: row.organization,
      eventId: row.event_id,
      eventName: row.event_id
        ? get("SELECT name FROM events WHERE id=?", row.event_id)?.name
        : null,
      eventActive: row.event_id
        ? !!get("SELECT active FROM events WHERE id=?", row.event_id)?.active
        : null,
    };
  }
  function createUser({
    name,
    email,
    password,
    role,
    organization = "ENTITY",
    eventId = null,
  }) {
    const userId = id();
    run(
      "INSERT INTO users (id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)",
      userId,
      name,
      email,
      passwordHash(password),
      role,
      now(),
    );
    run(
      "UPDATE users SET organization=?,event_id=? WHERE id=?",
      organization,
      eventId,
      userId,
    );
    return get("SELECT * FROM users WHERE id=?", userId);
  }
  function accountScope(body, target = {}) {
    const role = body.role;
    if (!ROLES.includes(role)) fail(400, "Choose a valid role.");
    let organization = body.organization || target.organization || "ENTITY";
    const eventId = EVENT_ROLES.includes(role) ? body.eventId || null : null;
    if (EVENT_ROLES.includes(role)) {
      const event = get("SELECT * FROM events WHERE id=?", eventId);
      if (
        !(body.active === false && !eventId) &&
        (!event || (!event.active && target.event_id !== eventId))
      )
        fail(400, "Choose an ongoing event.");
      organization = event?.organization || organization;
      if (role === "OCP" && !event)
        fail(400, "Choose an event for the OCP account.");
    }
    if (["IGVP_MARKETING", "IGVP_OGV"].includes(role)) organization = "EXAMPLE_IG";
    if (["ADMIN", "MARKETING_VP", "B2C_VP"].includes(role))
      organization = "ENTITY";
    if (!["ENTITY", "EXAMPLE_IG"].includes(organization))
      fail(400, "Choose ENTITY or EXAMPLE_IG.");
    if (
      ["MARKETING_VP", "B2C_VP", "IGVP_MARKETING", "IGVP_OGV", "OCP"].includes(
        role,
      ) &&
      get(
        "SELECT id FROM users WHERE role=? AND deleted_at IS NULL AND id<>? AND (?<>'OCP' OR event_id=?)",
        role,
        target.id || "",
        role,
        eventId,
      )
    )
      fail(
        409,
        "An account already holds this role. Edit or delete the existing account first.",
      );
    return { organization, eventId };
  }
  function audit(user, action, entityId, details = "") {
    run(
      "INSERT INTO activity VALUES (?,?,?,?,?,?,?,?)",
      id(),
      user.id,
      user.name,
      user.role,
      action,
      entityId,
      details,
      now(),
    );
  }
  function record(user, submission, action, comment = "") {
    run(
      "INSERT INTO history VALUES (?,?,?,?,?,?,?,?,?)",
      id(),
      submission.id,
      user.id,
      user.name,
      user.role,
      action,
      comment,
      submission.revision,
      now(),
    );
    audit(
      user,
      action,
      submission.id,
      `${submission.title}${comment ? ": " + comment : ""}`,
    );
  }
  function snapshot(submission) {
    run(
      "INSERT INTO revisions VALUES (?,?,?,?)",
      submission.id,
      submission.revision,
      JSON.stringify(serialize(submission)),
      now(),
    );
  }
  function notify(userId, submissionId, title, message) {
    run(
      "INSERT INTO notifications VALUES (?,?,?,?,?,?,NULL)",
      id(),
      userId,
      submissionId,
      title,
      message,
      now(),
    );
  }
  function notifyReviewers(s, includeObservers = true) {
    for (const u of all(
      "SELECT * FROM users WHERE active=1 AND deleted_at IS NULL AND id<>?",
      s.creator_id,
    ))
      if (
        canReview(u, s) ||
        (includeObservers && u.role === "OCP" && canSee(u, s))
      )
        notify(
          u.id,
          s.id,
          u.role === "OCP" ? "Event submission update" : "Ready for review",
          `${s.title} — ${s.creator_name}`,
        );
  }
  function serialize(s) {
    const files = all(
      "SELECT id,mime FROM files WHERE submission_id=? AND revision=?",
      s.id,
      s.revision,
    );
    return {
      id: s.id,
      creatorId: s.creator_id,
      creatorName: s.creator_name,
      title: s.title,
      event: s.event,
      eventId: s.event_id,
      organization: s.organization,
      submitterRole: s.submitter_role,
      reviewStage: s.review_stage,
      externalUrl: s.external_url,
      category: s.category,
      contentType: s.content_type,
      platform: s.platform,
      caption: s.caption,
      scheduledAt: s.scheduled_at,
      notes: s.notes,
      status: s.status,
      revision: s.revision,
      version: s.version,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      cleanupRequestedAt: s.cleanup_requested_at,
      creativesDeletedAt: s.creatives_deleted_at,
      fileCount: s.cleanup_requested_at ? 0 : files.length,
      thumbnailId: s.cleanup_requested_at
        ? null
        : files.find((f) => f.mime.startsWith("image/"))?.id || null,
    };
  }
  function canSee(user, s) {
    return canView(
      { ...user, active: !!user.active, eventId: user.event_id },
      workflowRow(s),
    );
  }
  function workflowRow(s) {
    return {
      ...s,
      creatorId: s.creator_id,
      eventId: s.event_id,
      submitterRole: s.submitter_role,
      reviewStage: s.review_stage,
    };
  }
  function canReview(user, s) {
    return workflowCanReview(user, workflowRow(s));
  }
  function findSubmission(user, submissionId) {
    const s = get("SELECT * FROM submissions WHERE id=?", submissionId);
    if (!s || !canSee(user, s))
      fail(404, "Submission not found or access is unavailable.");
    return s;
  }
  function protectLastAdmin(target, role, active) {
    if (
      isAdmin(target) &&
      target.active &&
      (role !== "ADMIN" || !active) &&
      get("SELECT count(*) AS n FROM users WHERE role='ADMIN' AND active=1")
        .n <= 1
    )
      fail(409, "Keep at least one active administrator.");
  }

  const hasAdmin = () =>
    !!get("SELECT id FROM users WHERE role='ADMIN' LIMIT 1");
  function initializeAdmin({ password, name = "Administrator" }) {
    return transaction(() => {
      if (hasAdmin()) fail(409, "An administrator account already exists.");
      const u = createUser({
        name: clean(name, "Name", 100, true),
        email: ADMIN_EMAIL,
        password: validPassword(password),
        role: "ADMIN",
      });
      audit(
        u,
        "WORKSPACE_CREATED",
        u.id,
        "Initial administrator account created",
      );
      return u;
    });
  }
  // Creators may register before the administrator is initialized.
  if (process.env.ADMIN_PASSWORD && !hasAdmin())
    initializeAdmin({
      password: process.env.ADMIN_PASSWORD,
      name: process.env.ADMIN_NAME || "Administrator",
    });
  function localSetupAllowed(req) {
    const address = req.socket.remoteAddress?.replace(/^::ffff:/, "") || "";
    return (
      !production &&
      (address === "::1" || (isIP(address) === 4 && address.startsWith("127.")))
    );
  }

  const app = express();
  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "same-origin");
    if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
    if (production)
      res.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      const allowed = [
        process.env.APP_ORIGIN || `${req.protocol}://${req.get("host")}`,
      ];
      if (!production)
        allowed.push("http://127.0.0.1:5173", "http://localhost:5173");
      if (
        req.get("sec-fetch-site") === "cross-site" ||
        (origin && !allowed.includes(origin))
      )
        return res
          .status(403)
          .json({ error: "Requests must come from this application." });
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict",
    secure: production,
    path: "/",
    maxAge: 7 * 86400000,
  };
  const sessionsCookie = "approval_session";
  const cookieToken = (req) =>
    (req.get("cookie") || "")
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(sessionsCookie + "="))
      ?.slice(sessionsCookie.length + 1);
  function auth(req, res, next) {
    const token = cookieToken(req);
    if (!token)
      return res.status(401).json({ error: "Please sign in to continue." });
    const user = get(
      "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1",
      hashToken(token),
      now(),
    );
    if (!user)
      return res
        .status(401)
        .json({ error: "Your session has ended. Please sign in again." });
    req.user = user;
    req.tokenHash = hashToken(token);
    next();
  }
  const admin = (req, res, next) => {
    if (!isAdmin(req.user))
      return res
        .status(403)
        .json({ error: "Administrator access is required." });
    next();
  };
  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.get("/api/config", (req, res) =>
    res.json({
      demoMode: false,
      registrationEnabled: true,
      adminEmail: ADMIN_EMAIL,
      setupRequired: localSetupAllowed(req) && !hasAdmin(),
    }),
  );
  const attempts = new Map();
  const registrations = new Map();
  const dummyHash = passwordHash(randomBytes(32).toString("hex"));
  function startSession(req, res, user, status = 200) {
    run("DELETE FROM sessions WHERE expires_at<?", now());
    const previous = cookieToken(req);
    if (previous)
      run("DELETE FROM sessions WHERE token_hash=?", hashToken(previous));
    const token = randomBytes(32).toString("hex");
    run(
      "INSERT INTO sessions VALUES (?,?,?)",
      hashToken(token),
      user.id,
      new Date(Date.now() + 7 * 86400000).toISOString(),
    );
    res
      .status(status)
      .cookie(sessionsCookie, token, cookieOptions)
      .json({ user: publicUser(user) });
  }
  if (!production)
    app.post("/api/auth/setup", (req, res) => {
      if (!localSetupAllowed(req))
        fail(403, "Administrator setup is available only on this computer.");
      const user = initializeAdmin({
        password: req.body?.password,
        name: req.body?.name,
      });
      startSession(req, res, user, 201);
    });
  app.post("/api/auth/register", (req, res) => {
    const time = Date.now();
    const windowMs = 15 * 60000;
    for (const [key, value] of registrations)
      if (time - value.started >= windowMs) registrations.delete(key);
    const attempt = registrations.get(req.ip) || { count: 0, started: time };
    if (attempt.count >= 10) {
      res.set(
        "Retry-After",
        String(Math.ceil((attempt.started + windowMs - time) / 1000)),
      );
      fail(
        429,
        "Too many registration attempts. Please try again in 15 minutes.",
      );
    }
    attempt.count++;
    registrations.set(req.ip, attempt);
    const name = clean(req.body?.name, "Name", 100, true),
      email = emailAddress(req.body?.email),
      password = validPassword(req.body?.password);
    if (email === ADMIN_EMAIL)
      fail(403, "This email is reserved for the administrator.");
    if (get("SELECT id FROM users WHERE email=?", email))
      fail(409, "An account already uses this email.");
    const user = transaction(() => {
      const role = SELF_SIGNUP_ROLES.includes(req.body?.role)
        ? req.body.role
        : "MARKETING_MEMBER";
      const scope = accountScope({ ...req.body, role, active: true });
      const created = createUser({ name, email, password, role, ...scope });
      audit(
        created,
        "ACCOUNT_REGISTERED",
        created.id,
        "Member account registered",
      );
      return created;
    });
    startSession(req, res, user, 201);
  });
  app.post("/api/auth/login", (req, res) => {
    const email =
      typeof req.body.email === "string"
        ? req.body.email.toLowerCase().trim()
        : "";
    const password =
      typeof req.body.password === "string" ? req.body.password : "";
    const key = req.ip;
    const time = Date.now();
    for (const [k, v] of attempts)
      if (time - v.started > 15 * 60000) attempts.delete(k);
    const count = attempts.get(key) || { count: 0, started: time };
    if (count.count >= 30)
      fail(429, "Too many sign-in attempts. Please try again in 15 minutes.");
    const user = get("SELECT * FROM users WHERE email=?", email);
    if (
      password.length > 200 ||
      !verifyPassword(password, user?.password_hash || dummyHash) ||
      !user?.active
    ) {
      count.count++;
      attempts.set(key, count);
      fail(401, "Email or password is incorrect.");
    }
    attempts.delete(key);
    startSession(req, res, user);
  });
  app.post("/api/auth/logout", (req, res) => {
    const token = cookieToken(req);
    if (token) run("DELETE FROM sessions WHERE token_hash=?", hashToken(token));
    res
      .clearCookie(sessionsCookie, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: production,
      })
      .json({ ok: true });
  });
  app.get("/api/auth/me", auth, (req, res) =>
    res.json({ user: publicUser(req.user) }),
  );
  app.post("/api/auth/password", auth, (req, res) => {
    const current =
      typeof req.body.currentPassword === "string"
        ? req.body.currentPassword
        : "";
    if (
      current.length > 200 ||
      !verifyPassword(current, req.user.password_hash)
    )
      fail(400, "Current password is incorrect.");
    validPassword(req.body.newPassword);
    transaction(() => {
      run(
        "UPDATE users SET password_hash=? WHERE id=?",
        passwordHash(req.body.newPassword),
        req.user.id,
      );
      run(
        "DELETE FROM sessions WHERE user_id=? AND token_hash<>?",
        req.user.id,
        req.tokenHash,
      );
      audit(req.user, "PASSWORD_CHANGED", req.user.id);
    });
    res.json({ ok: true });
  });

  const uploader = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => cb(null, id()),
    }),
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 8,
      fields: 16,
      fieldSize: 20000,
    },
    fileFilter: (req, file, cb) => {
      if (
        ![
          "image/jpeg",
          "image/png",
          "image/gif",
          "image/webp",
          "video/mp4",
          "video/quicktime",
          "video/webm",
          "application/pdf",
        ].includes(file.mimetype)
      )
        return cb(
          Object.assign(
            new Error(
              "Supported files: JPG, PNG, GIF, WebP, MP4, MOV, WebM and PDF.",
            ),
            { status: 400 },
          ),
        );
      cb(null, true);
    },
  }).array("files", 8);
  const removeIncoming = (req) => {
    for (const f of req.files || [])
      try {
        unlinkSync(f.path);
      } catch {}
  };
  function fileType(file) {
    const header = Buffer.alloc(4096);
    const fd = openSync(file.path, "r");
    let n;
    try {
      n = readSync(fd, header, 0, header.length, 0);
    } finally {
      closeSync(fd);
    }
    if (
      n >= 8 &&
      header
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return "image/png";
    if (n >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255)
      return "image/jpeg";
    if (["GIF87a", "GIF89a"].includes(header.toString("ascii", 0, 6)))
      return "image/gif";
    if (
      header.toString("ascii", 0, 4) === "RIFF" &&
      header.toString("ascii", 8, 12) === "WEBP"
    )
      return "image/webp";
    if (header.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
    if (n >= 12 && header.toString("ascii", 4, 8) === "ftyp")
      return header.toString("ascii", 8, 12) === "qt  "
        ? "video/quicktime"
        : "video/mp4";
    if (
      n >= 8 &&
      header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      header.subarray(0, n).includes(Buffer.from("webm"))
    )
      return "video/webm";
    fail(400, `“${file.originalname}” does not contain a supported file type.`);
  }
  function validateSubmission(body, user) {
    if (user.role === "OCP")
      fail(403, "OCP accounts can only observe their event.");
    const category = approvalCategoryForRole(user.role);
    const event =
      user.role === "CREATOR"
        ? get("SELECT * FROM events WHERE id=? AND active=1", user.event_id)
        : null;
    if (user.role === "CREATOR" && !event)
      fail(400, "Ask the admin to assign an ongoing event to your account.");
    let externalUrl;
    try {
      externalUrl = normalizeDriveLink(body.externalUrl || "");
    } catch (e) {
      fail(400, e.message);
    }
    const status = body.status || "PENDING";
    if (!["DRAFT", "PENDING"].includes(status))
      fail(400, "Save a draft or submit for review.");
    let scheduledAt = null;
    if (body.scheduledAt) {
      const date = new Date(body.scheduledAt);
      if (Number.isNaN(date.getTime()))
        fail(400, "Enter a valid posting date.");
      scheduledAt = date.toISOString();
    }
    return {
      title: clean(body.title, "Title", 160, true),
      event: event?.name || clean(body.event, "Campaign / project", 120),
      eventId: event?.id || null,
      externalUrl,
      organization: user.organization,
      reviewStage: initialStage(user),
      category,
      contentType: clean(body.contentType, "Content type", 50, true),
      platform: clean(body.platform, "Platform", 50, true),
      caption: clean(body.caption, "Caption", 10000, true),
      scheduledAt,
      notes: clean(body.notes, "Notes", 3000),
      status,
    };
  }
  function writeSubmission(req, res, next) {
    if (req.user.role === "OCP")
      return next(
        Object.assign(new Error("OCP accounts can only observe their event."), {
          status: 403,
        }),
      );
    uploader(req, res, (uploadError) => {
      if (uploadError) {
        removeIncoming(req);
        return next(uploadError);
      }
      try {
        const old = req.params.id
          ? findSubmission(req.user, req.params.id)
          : null;
        if (old) {
          if (old.creator_id !== req.user.id)
            fail(403, "Only the creator can edit this submission.");
          if (!["DRAFT", "CHANGES_REQUESTED"].includes(old.status))
            fail(
              409,
              "Only drafts and submissions needing changes can be edited.",
            );
          if (Number(req.body.version) !== old.version)
            fail(409, "This submission changed. Reload it before saving.");
        }
        const values = validateSubmission(req.body, req.user);
        if (
          old &&
          (old.cleanup_requested_at ||
            old.organization !== values.organization ||
            old.submitter_role !== req.user.role ||
            (old.event_id && old.event_id !== values.eventId))
        )
          fail(
            409,
            "Your account assignment or this submission changed. Create a new submission.",
          );
        const incoming = (req.files || []).map((f) => ({
          ...f,
          mime: fileType(f),
        }));
        const oldFiles = old
          ? all(
              "SELECT * FROM files WHERE submission_id=? AND revision=?",
              old.id,
              old.revision,
            )
          : [];
        if (
          values.status === "PENDING" &&
          !incoming.length &&
          !oldFiles.length &&
          !values.externalUrl
        )
          fail(
            400,
            "Attach a creative or add a Google Drive video link before submitting.",
          );
        const sid = old?.id || id(),
          revision = old ? old.revision + 1 : 1,
          time = now();
        transaction(() => {
          if (old)
            run(
              "UPDATE submissions SET title=?,event=?,category=?,content_type=?,platform=?,caption=?,scheduled_at=?,notes=?,status=?,revision=?,version=version+1,updated_at=? WHERE id=?",
              values.title,
              values.event,
              values.category,
              values.contentType,
              values.platform,
              values.caption,
              values.scheduledAt,
              values.notes,
              values.status,
              revision,
              time,
              sid,
            );
          else
            run(
              "INSERT INTO submissions (id,creator_id,creator_name,title,event,category,content_type,platform,caption,scheduled_at,notes,status,revision,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              sid,
              req.user.id,
              req.user.name,
              values.title,
              values.event,
              values.category,
              values.contentType,
              values.platform,
              values.caption,
              values.scheduledAt,
              values.notes,
              values.status,
              revision,
              1,
              time,
              time,
            );
          if (incoming.length)
            for (const f of incoming)
              run(
                "INSERT INTO files VALUES (?,?,?,?,?,?,?)",
                id(),
                sid,
                revision,
                path.basename(f.originalname).slice(0, 240),
                f.mime,
                f.size,
                f.filename,
              );
          else
            for (const f of oldFiles)
              run(
                "INSERT INTO files VALUES (?,?,?,?,?,?,?)",
                id(),
                sid,
                revision,
                f.name,
                f.mime,
                f.size,
                f.disk_name,
              );
          run(
            "UPDATE submissions SET event_id=?,organization=?,submitter_role=?,review_stage=?,external_url=? WHERE id=?",
            values.eventId,
            values.organization,
            req.user.role,
            values.reviewStage,
            values.externalUrl,
            sid,
          );
          const s = get("SELECT * FROM submissions WHERE id=?", sid);
          snapshot(s);
          record(
            req.user,
            s,
            values.status === "DRAFT"
              ? "DRAFT_SAVED"
              : old
                ? "RESUBMITTED"
                : "SUBMITTED",
          );
          if (values.status === "PENDING") notifyReviewers(s);
        });
        res.status(old ? 200 : 201).json({
          submission: serialize(
            get("SELECT * FROM submissions WHERE id=?", sid),
          ),
        });
      } catch (e) {
        removeIncoming(req);
        next(e);
      }
    });
  }
  app.get("/api/submissions", auth, (req, res) => {
    const rows = all(
      "SELECT * FROM submissions ORDER BY updated_at DESC",
    ).filter((s) => canSee(req.user, s));
    res.json({ submissions: rows.map(serialize) });
  });
  app.post("/api/submissions", auth, writeSubmission);
  app.put("/api/submissions/:id", auth, writeSubmission);
  app.get("/api/submissions/:id", auth, (req, res) => {
    const s = findSubmission(req.user, req.params.id);
    res.json({
      submission: serialize(s),
      files: s.cleanup_requested_at
        ? []
        : all(
            "SELECT id,revision,name,mime,size FROM files WHERE submission_id=? ORDER BY revision DESC,rowid",
            s.id,
          ),
      history: all(
        "SELECT id,actor_name AS actorName,actor_role AS actorRole,action,comment,revision,created_at AS createdAt FROM history WHERE submission_id=? ORDER BY rowid DESC",
        s.id,
      ),
      revisions: all(
        "SELECT revision,snapshot,created_at AS createdAt FROM revisions WHERE submission_id=? ORDER BY revision DESC",
        s.id,
      ).map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot) })),
    });
  });
  app.post("/api/submissions/:id/review", auth, (req, res) => {
    const s = findSubmission(req.user, req.params.id);
    if (!canReview(req.user, s))
      fail(
        403,
        "You cannot review this submission. Self-approval is not allowed.",
      );
    if (s.cleanup_requested_at)
      fail(
        409,
        "Creative files are being deleted or have been removed. Create a new submission.",
      );
    if (s.status === "DRAFT" || (!isAdmin(req.user) && s.status !== "PENDING"))
      fail(409, "This submission is not awaiting your review.");
    if (Number(req.body.version) !== s.version)
      fail(
        409,
        "Another reviewer changed this submission. Reload before deciding.",
      );
    const decision = req.body.decision;
    if (
      !["APPROVED", "CHANGES_REQUESTED", "REJECTED", "PENDING"].includes(
        decision,
      )
    )
      fail(400, "Choose a valid review decision.");
    if (
      decision === "PENDING" &&
      (!isAdmin(req.user) || s.status === "PENDING")
    )
      fail(403, "Only the administrator can reopen a decided submission.");
    if (decision === s.status)
      fail(409, "This submission already has that decision.");
    const comment = clean(
      req.body.comment,
      "Feedback",
      5000,
      decision !== "APPROVED" || s.status !== "PENDING",
    );
    transaction(() => {
      const advance = decision === "APPROVED" && s.review_stage === "IG";
      const stage = advance
        ? "LC"
        : decision === "PENDING"
          ? initialStage({
              organization: s.organization,
              role: s.submitter_role,
            })
          : s.review_stage;
      run(
        "UPDATE submissions SET status=?,review_stage=?,version=version+1,updated_at=? WHERE id=?",
        advance ? "PENDING" : decision,
        stage,
        now(),
        s.id,
      );
      record(
        req.user,
        s,
        advance
          ? "IG_APPROVED"
          : s.status === "PENDING"
            ? decision
            : `OVERRIDE_${decision}`,
        comment,
      );
      notify(
        s.creator_id,
        s.id,
        advance
          ? "IG approved · awaiting ENTITY review"
          : decision === "CHANGES_REQUESTED"
            ? "Changes requested"
            : decision === "APPROVED"
              ? "Submission approved"
              : decision === "PENDING"
                ? "Submission reopened"
                : "Submission rejected",
        `${s.title}${comment ? ": " + comment : ""}`,
      );
      const updated=get("SELECT * FROM submissions WHERE id=?",s.id);
      for (const u of all("SELECT * FROM users WHERE active=1 AND deleted_at IS NULL")) {
        const followup=s.organization==='EXAMPLE_IG' && u.role===(s.category==='B2C'?'IGVP_OGV':'IGVP_MARKETING') && u.id!==req.user.id && u.id!==s.creator_id && !((decision==='PENDING'||advance)&&canReview(u,updated));
        if ((u.role==='OCP'||followup)&&canSee(u,s)) notify(u.id,s.id,'Submission decision',`${s.title}: ${decision}${comment?': '+comment:''}`);
      }
      if (decision === "PENDING" || advance)
        notifyReviewers(
          get("SELECT * FROM submissions WHERE id=?", s.id),
          false,
        );
    });
    res.json({
      submission: serialize(get("SELECT * FROM submissions WHERE id=?", s.id)),
    });
  });
  const canCleanup = (user, s) =>
    isAdmin(user) ||
    (user.role === "MARKETING_VP" && s.category === "MARKETING") ||
    (user.role === "B2C_VP" && s.category === "B2C");
  const physicalFiles = (sid) =>
    all(
      "SELECT disk_name,MAX(size) AS size FROM files WHERE submission_id=? GROUP BY disk_name",
      sid,
    );
  app.get("/api/storage", auth, (req, res) => {
    if (!["ADMIN", "MARKETING_VP", "B2C_VP"].includes(req.user.role))
      fail(403, "Reviewer access required.");
    const submissions = all(
      "SELECT * FROM submissions WHERE status IN ('APPROVED','REJECTED') AND creatives_deleted_at IS NULL ORDER BY updated_at",
    )
      .filter((s) => canCleanup(req.user, s))
      .map((s) => {
        const files = physicalFiles(s.id);
        return {
          ...serialize(s),
          fileCount: files.length,
          bytes: files.reduce((n, f) => n + f.size, 0),
        };
      })
      .filter((s) => s.fileCount);
    const usedBytes = get(
      "SELECT COALESCE(SUM(size),0) AS bytes FROM (SELECT disk_name,MAX(size) AS size FROM files GROUP BY disk_name)",
    ).bytes;
    res.json({ submissions, usedBytes });
  });
  app.delete("/api/submissions/:id/creatives", auth, (req, res) => {
    const s = findSubmission(req.user, req.params.id);
    if (!canCleanup(req.user, s))
      fail(403, "You cannot delete files for this submission.");
    if (!["APPROVED", "REJECTED"].includes(s.status))
      fail(409, "Only approved or rejected submissions can be cleaned up.");
    let job = get("SELECT * FROM creative_cleanup WHERE submission_id=?", s.id);
    if (job?.completed_at)
      return res.json({
        ok: true,
        alreadyDeleted: true,
        bytesFreed: 0,
        filesDeleted: 0,
      });
    if (!job) {
      if (Number(req.body.version) !== s.version)
        fail(409, "This submission changed. Refresh before deleting files.");
      const files = physicalFiles(s.id);
      if (!files.length) fail(409, "There are no creative files to delete.");
      transaction(() => {
        run(
          "INSERT INTO creative_cleanup VALUES(?,?,?,?,NULL)",
          s.id,
          JSON.stringify(files.map((f) => f.disk_name)),
          files.reduce((n, f) => n + f.size, 0),
          files.length,
        );
        run(
          "UPDATE submissions SET cleanup_requested_at=?,version=version+1 WHERE id=?",
          now(),
          s.id,
        );
        record(
          req.user,
          s,
          "FILES_DELETION_REQUESTED",
          "Delete all creative versions; retain captions, decisions and history.",
        );
      });
      job = get("SELECT * FROM creative_cleanup WHERE submission_id=?", s.id);
    }
    for (const filename of JSON.parse(job.files)) {
      try {
        unlinkSync(path.join(uploadDir, filename));
      } catch (error) {
        if (error.code !== "ENOENT")
          fail(503, "Some files could not be deleted. Retry cleanup.");
      }
    }
    transaction(() => {
      run("DELETE FROM files WHERE submission_id=?", s.id);
      run(
        "UPDATE creative_cleanup SET completed_at=? WHERE submission_id=?",
        now(),
        s.id,
      );
      run(
        "UPDATE submissions SET creatives_deleted_at=?,version=version+1 WHERE id=?",
        now(),
        s.id,
      );
      record(
        req.user,
        s,
        "CREATIVES_DELETED",
        `${job.file_count} files deleted across all versions. Captions, decisions and history retained.`,
      );
    });
    res.json({ ok: true, bytesFreed: job.bytes, filesDeleted: job.file_count });
  });
  app.get("/api/files/:id", auth, (req, res) => {
    const f = get("SELECT * FROM files WHERE id=?", req.params.id);
    if (!f) fail(404, "File not found.");
    findSubmission(req.user, f.submission_id);
    const filename = path.join(uploadDir, f.disk_name);
    if (!existsSync(filename)) fail(404, "The stored file is unavailable.");
    res.type(f.mime);
    res.set(
      "Content-Disposition",
      `${f.mime === "application/pdf" ? "attachment" : "inline"}; filename="creative${path.extname(f.name).replace(/[^.a-zA-Z0-9]/g, "")}"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/'/g, "%27")}`,
    );
    res.sendFile(filename);
  });

  app.get("/api/events", (req, res) =>
    res.json({
      events: all(
        "SELECT id,name,active,organization,EXISTS(SELECT 1 FROM users u WHERE u.event_id=events.id AND u.role='OCP' AND u.deleted_at IS NULL) AS ocpAssigned FROM events WHERE active=1 ORDER BY name",
      ).map((e) => ({ ...e, active: !!e.active })),
    }),
  );
  app.get("/api/admin/events", auth, admin, (req, res) =>
    res.json({
      events: all(
        "SELECT id,name,active,organization,EXISTS(SELECT 1 FROM users u WHERE u.event_id=events.id AND u.role='OCP' AND u.deleted_at IS NULL) AS ocpAssigned FROM events ORDER BY name",
      ).map((e) => ({ ...e, active: !!e.active })),
    }),
  );
  app.post("/api/admin/events", auth, admin, (req, res) => {
    if (!["ENTITY", "EXAMPLE_IG"].includes(req.body.organization || "ENTITY"))
      fail(400, "Choose ENTITY or EXAMPLE_IG.");
    const name = clean(req.body.name, "Event name", 120, true),
      eid = id();
    run(
      "INSERT INTO events (id,name,active,created_at,organization) VALUES (?,?,?,?,?)",
      eid,
      name,
      req.body.active === false ? 0 : 1,
      now(),
      req.body.organization || "ENTITY",
    );
    res
      .status(201)
      .json({ ok: true, event: get("SELECT * FROM events WHERE id=?", eid) });
  });
  app.patch("/api/admin/events/:id", auth, admin, (req, res) => {
    const event = get("SELECT * FROM events WHERE id=?", req.params.id);
    if (!event) fail(404, "Event not found.");
    if (req.body.organization && req.body.organization !== event.organization)
      fail(
        400,
        "An event committee cannot be changed. Create a separate event instead.",
      );
    run(
      "UPDATE events SET name=?,active=? WHERE id=?",
      clean(req.body.name, "Event name", 120, true),
      req.body.active === false ? 0 : 1,
      req.params.id,
    );
    res.json({ ok: true });
  });
  app.delete("/api/admin/events/:id", auth, admin, (req, res) => {
    if (
      get("SELECT id FROM users WHERE event_id=?", req.params.id) ||
      get("SELECT id FROM submissions WHERE event_id=?", req.params.id)
    )
      fail(
        409,
        "This event has members or submissions. Archive it to keep their history.",
      );
    run("DELETE FROM events WHERE id=?", req.params.id);
    res.json({ ok: true });
  });
  app.get("/api/users", auth, admin, (req, res) =>
    res.json({
      users: all(
        "SELECT * FROM users WHERE deleted_at IS NULL ORDER BY active DESC,name",
      ).map(publicUser),
    }),
  );
  app.post("/api/users", auth, admin, (req, res) => {
    const scope = accountScope(req.body),
      role = req.body.role;
    const name = clean(req.body.name, "Name", 100, true),
      email = emailAddress(req.body.email),
      password = validPassword(req.body.password);
    if (get("SELECT id FROM users WHERE email=?", email))
      fail(409, "An account already uses this email.");
    let created;
    transaction(() => {
      created = createUser({ name, email, password, role, ...scope });
      if (req.body.active === false) {
        run("UPDATE users SET active=0 WHERE id=?", created.id);
        created.active = 0;
      }
      audit(req.user, "ACCOUNT_CREATED", created.id, `${name} — ${role}`);
    });
    res.status(201).json({ user: publicUser(created) });
  });
  app.patch("/api/users/:id", auth, admin, (req, res) => {
    const target = get(
      "SELECT * FROM users WHERE id=? AND deleted_at IS NULL",
      req.params.id,
    );
    if (!target) fail(404, "Account not found.");
    const role = req.body.role ?? target.role,
      active =
        req.body.active === undefined ? !!target.active : req.body.active;
    if (typeof active !== "boolean") fail(400, "Invalid account status.");
    const scope = accountScope(
      {
        ...req.body,
        role,
        eventId:
          req.body.eventId === undefined ? target.event_id : req.body.eventId,
      },
      target,
    );
    const name = clean(req.body.name ?? target.name, "Name", 100, true),
      email = emailAddress(req.body.email ?? target.email);
    const password = req.body.password
      ? passwordHash(validPassword(req.body.password))
      : target.password_hash;
    transaction(() => {
      protectLastAdmin(target, role, active);
      run(
        "UPDATE users SET name=?,email=?,role=?,active=?,password_hash=?,organization=?,event_id=? WHERE id=?",
        name,
        email,
        role,
        active ? 1 : 0,
        password,
        scope.organization,
        scope.eventId,
        target.id,
      );
      if (
        role !== target.role ||
        !active ||
        req.body.password ||
        target.event_id !== scope.eventId ||
        target.organization !== scope.organization ||
        email !== target.email
      )
        run("DELETE FROM sessions WHERE user_id=?", target.id);
      audit(
        req.user,
        "ACCOUNT_UPDATED",
        target.id,
        `${name} — ${role} — ${active ? "active" : "disabled"}`,
      );
    });
    res.json({
      user: publicUser(get("SELECT * FROM users WHERE id=?", target.id)),
    });
  });
  app.delete("/api/users/:id", auth, admin, (req, res) => {
    const target = get(
      "SELECT * FROM users WHERE id=? AND deleted_at IS NULL",
      req.params.id,
    );
    if (!target) fail(404, "Account not found.");
    transaction(() => {
      protectLastAdmin(target, target.role, false);
      run("UPDATE users SET active=0 WHERE id=?", target.id);
      run("DELETE FROM sessions WHERE user_id=?", target.id);
    });
    const files = all(
      "SELECT DISTINCT f.disk_name FROM files f JOIN submissions s ON s.id=f.submission_id WHERE s.creator_id=?",
      target.id,
    );
    for (const f of files) {
      const file = path.join(uploadDir, f.disk_name);
      if (existsSync(file)) unlinkSync(file);
    }
    transaction(() => {
      run(
        "DELETE FROM files WHERE submission_id IN (SELECT id FROM submissions WHERE creator_id=?)",
        target.id,
      );
      run(
        "UPDATE submissions SET cleanup_requested_at=?,creatives_deleted_at=?,version=version+1 WHERE creator_id=?",
        now(),
        now(),
        target.id,
      );
      run(
        "UPDATE users SET deleted_at=?,email=? WHERE id=?",
        now(),
        `${target.id}@deleted.invalid`,
        target.id,
      );
      audit(
        req.user,
        "ACCOUNT_DELETED",
        target.id,
        "Sign-in and uploaded files removed; submission history retained.",
      );
    });
    res.json({ ok: true });
  });
  app.get("/api/notifications", auth, (req, res) =>
    res.json({
      notifications: all(
        "SELECT id,submission_id AS submissionId,title,message,created_at AS createdAt,read_at AS readAt FROM notifications WHERE user_id=? ORDER BY rowid DESC LIMIT 200",
        req.user.id,
      ).filter(
        (n) =>
          !n.submissionId ||
          canSee(
            req.user,
            get("SELECT * FROM submissions WHERE id=?", n.submissionId),
          ),
      ),
    }),
  );
  app.post("/api/notifications/read", auth, (req, res) => {
    run(
      "UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL",
      now(),
      req.user.id,
    );
    res.json({ ok: true });
  });
  app.get("/api/activity", auth, admin, (req, res) =>
    res.json({
      activity: all(
        "SELECT id,actor_name AS actorName,actor_role AS actorRole,action,entity_id AS entityId,details,created_at AS createdAt FROM activity ORDER BY rowid DESC LIMIT 500",
      ),
    }),
  );
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "API endpoint not found." }),
  );
  const dist = path.join(ROOT, "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/{*splat}", (req, res) =>
      res.sendFile(path.join(dist, "index.html")),
    );
  }
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err instanceof multer.MulterError ? 400 : err.status || 500;
    res.status(status).json({
      error:
        err instanceof multer.MulterError
          ? "Upload limit exceeded. Use up to 8 files, each at most 50 MB."
          : status < 500
            ? err.message
            : "An unexpected server error occurred.",
    });
    if (status >= 500) console.error(err);
  });
  return { app, db, close: () => db.close() };
}
