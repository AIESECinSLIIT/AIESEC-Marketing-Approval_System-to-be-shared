import React, { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { ErrorBox } from "./lib.jsx";
import {
  pushAvailable,
  pushSupport,
  pushStatus,
  enablePush,
  disablePush,
  testPush,
} from "./push.js";

export default function PushSettings() {
  const [state, setState] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const support = pushAvailable ? pushSupport() : "";
  useEffect(() => {
    if (!pushAvailable || support) return;
    let active = true;
    pushStatus()
      .then((value) => active && setState(value))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [support]);
  if (!pushAvailable) return null;
  async function run(action) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (action === "test") {
        await testPush();
        setMessage("Test queued. A notification should appear shortly.");
      } else {
        if (state?.enabled) await disablePush();
        else await enablePush(state.publicKey);
        setState(await pushStatus());
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel push-panel">
      <div className="push-heading">
        <Bell size={21} />
        <div>
          <h2>Device notifications</h2>
          <p className="muted">
            {support ||
              (state?.enabled
                ? "On for this device."
                : "Get alerts when the app is closed.")}
          </p>
        </div>
      </div>
      {!support && (
        <div className="push-actions">
          <button
            className={`button ${state?.enabled ? "secondary" : "primary"}`}
            disabled={busy || !state?.publicKey}
            onClick={() => run("toggle")}
          >
            {busy
              ? "Please wait…"
              : state?.enabled
                ? "Turn off"
                : "Enable notifications"}
          </button>
          {state?.enabled && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => run("test")}
            >
              Send test
            </button>
          )}
        </div>
      )}
      {!support && state && !state.publicKey && (
        <p className="muted">Notifications are being set up.</p>
      )}
      <ErrorBox message={error} />
      {message && (
        <p className="field-hint" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
