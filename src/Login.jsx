import React, { useState, useEffect } from "react";
import { Check, ArrowUpRight, Files, Inbox, ChevronRight } from "lucide-react";
import { api, json, ErrorBox } from "./lib.jsx";
import { AccountScopeFields } from "./Events.jsx";

export default function Login({ onLogin }) {
  const [register, setRegister] = useState(false),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("CREATOR"),
    [scope, setScope] = useState({ organization: "ENTITY", eventId: "" }),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [setup, setSetup] = useState(false);
  useEffect(() => {
    api("/config")
      .then((config) => {
        if (config.setupRequired) {
          setSetup(true);
          setEmail(config.adminEmail || "admin@your-entity.example");
          setName("Admin");
        }
      })
      .catch(() => {});
  }, []);
  async function submit(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    if ((register || setup) && password !== confirm) {
      setError("Your passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      if (setup) {
        const result = await api(
          "/auth/setup",
          json("POST", { name, password }),
        );
        setSetup(false);
        onLogin(result.user);
      } else if (register) {
        const data = await api(
          "/auth/register",
          json("POST", { name, email, password, role, ...scope }),
        );
        setRegister(false);
        setPassword("");
        setConfirm("");
        setMessage(
          data.message || "Your account is ready. You can now sign in.",
        );
      } else {
        const data = await api(
          "/auth/login",
          json("POST", { email, password }),
        );
        onLogin(data.user);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <section className="login-story">
        <div className="login-brand">
          <img
            className="brand-logo"
            src="/entity-logo.svg"
            alt="AIESEC in Your Entity"
            width="514"
            height="220"
          />
        </div>
        <div>
          <span className="eyebrow light">LESS CHASING. MORE CREATING.</span>
          <h1>
            Good ideas.
            <br />
            Great content.
            <br />
            <span>One clear go-ahead.</span>
          </h1>
          <p>
            Submit your posts, get feedback, and know when you’re ready to
            publish.
          </p>
          <div className="login-flow">
            <span>
              <Files size={18} />
              Submit
            </span>
            <ChevronRight size={18} />
            <span>
              <Inbox size={18} />
              Review
            </span>
            <ChevronRight size={18} />
            <span>
              <Check size={18} />
              Publish
            </span>
          </div>
        </div>
        <div className="login-foot">
          AIESEC in Your Entity<span>↗</span>
        </div>
      </section>
      <section className="login-form">
        <div className="login-inner">
          <img
            className="brand-logo login-logo"
            src="/entity-logo.svg"
            alt="AIESEC in Your Entity"
            width="514"
            height="220"
          />
          <h2>
            {setup
              ? "Set up your admin account"
              : register
                ? "Create your account"
                : "Welcome to Approval Hub"}
          </h2>
          <p className="muted">
            {setup
              ? "Choose a password to get your club started."
              : register
                ? "Choose your role and get started."
                : "Sign in to submit or review posts."}
          </p>
          <form onSubmit={submit}>
            {register && (
              <label>
                Your name
                <input
                  autoComplete="name"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Full name"
                />
              </label>
            )}
            {register && (
              <label>
                Team role
                <select
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value);
                    setScope({ ...scope, eventId: "" });
                  }}
                >
                  <option value="CREATOR">OCVP Marketing</option>
                  <option value="OCP">OCP</option>
                  <option value="MARKETING_MEMBER">
                    Marketing Member / Team Leader
                  </option>
                  <option value="B2C_MEMBER">B2C Member / Team Leader</option>
                </select>
                <small className="field-hint">
                  Your role and committee determine the approval process.
                </small>
              </label>
            )}
            {register && (
              <AccountScopeFields
                role={role}
                {...scope}
                onChange={(change) => setScope({ ...scope, ...change })}
              />
            )}
            <label>
              Email address
              <input
                type="email"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="email"
                autoComplete="username"
                readOnly={setup}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={
                  register || setup ? "new-password" : "current-password"
                }
                required
                minLength={register || setup ? 12 : undefined}
                maxLength={200}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  register || setup
                    ? "At least 12 characters"
                    : "Enter your password"
                }
              />
            </label>
            {(register || setup) && (
              <label>
                Confirm password
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Enter your password again"
                />
              </label>
            )}
            <ErrorBox message={error} />
            {message && (
              <p className="info-banner" role="status">
                {message}
              </p>
            )}
            <button disabled={busy} className="button primary full">
              {busy
                ? "Please wait…"
                : setup
                  ? "Create admin account"
                  : register
                    ? "Create account"
                    : "Sign in"}
              <ArrowUpRight size={17} />
            </button>
          </form>
          {!setup && (
            <div className="login-help">
              <p>
                {register ? "Already have an account?" : "New team member?"}{" "}
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setRegister(!register);
                    setError("");
                    setMessage("");
                    setPassword("");
                    setConfirm("");
                  }}
                >
                  {register ? "Sign in" : "Create an account"}
                </button>
              </p>
              <p>VP accounts and password resets are managed by the admin.</p>
            </div>
          )}
        </div>
        <small>AIESEC in Your Entity · Approval Hub</small>
      </section>
    </div>
  );
}
