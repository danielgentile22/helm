"use client";

import { Component, type ReactNode } from "react";

// Crash containment for the WebGL cores — a renderer throw (GPU reset, context
// cap, blocklist) degrades to the fallback (default: nothing, matching the
// phone layout's orbless render) instead of unmounting the whole shell.
export default class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("core crashed — rendering without it", error);
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
