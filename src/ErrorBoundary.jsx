import React from "react";

export default class ErrorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="empty" role="alert">
          <h2>This page couldn’t open</h2>
          <p>Reload the app to try again.</p>
          <button className="button primary" onClick={() => window.location.reload()}>
            Reload app
          </button>
        </main>
      );
    return this.props.children;
  }
}
