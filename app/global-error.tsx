"use client";

import { useEffect } from "react";

// Root error boundary — required in addition to app/error.tsx because Shell
// mounts in the root layout, and layout errors are only caught here. Replaces
// the whole document, so it renders its own <html>/<body> and inlines its
// styles (globals.css may be gone with the crashed tree). Auto-retries once
// after 8s so the always-on display self-heals from transient faults.
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error("shell crashed", error);
    const id = setTimeout(reset, 8000);
    return () => clearTimeout(id);
  }, [error, reset]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          background: "#0a0b0f",
          color: "#f2f4f8",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <p style={{ margin: 0, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9aa0ae" }}>
          core fault
        </p>
        <p style={{ margin: 0, fontSize: 14, color: "#5c6170", maxWidth: 480, textAlign: "center" }}>
          {error.message || "the shell threw during render"}
        </p>
        <button
          onClick={reset}
          style={{
            font: "inherit",
            fontSize: 13,
            padding: "8px 16px",
            borderRadius: 10,
            border: "1px solid #3a3d4a",
            background: "#14151c",
            color: "#f2f4f8",
            cursor: "pointer",
          }}
        >
          reset
        </button>
      </body>
    </html>
  );
}
