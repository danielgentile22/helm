"use client";

import { CheckCircle2, AlertTriangle, Loader2, FileText, X, type LucideIcon } from "lucide-react";
import type { Toast, ToastKind } from "@/lib/callouts";

// a toast plus its expiry timestamp (the shell prunes on exp)
export type LiveToast = Toast & { exp: number };

const ICON: Record<ToastKind, LucideIcon> = {
  started: Loader2,
  done: CheckCircle2,
  failed: AlertTriangle,
  report: FileText,
};

const TONE: Record<ToastKind, string> = {
  started: "info",
  done: "success",
  failed: "danger",
  report: "primary",
};

const VERB: Record<ToastKind, string> = {
  started: "running",
  done: "done",
  failed: "failed",
  report: "ready",
};

// Cross-tab notification stack — bottom-right (above the phone tab bar). A run
// fired on any tab surfaces here everywhere. Targeted toasts (a deliverable, a
// report) open on click.
export default function Toasts({
  toasts,
  onOpen,
  onDismiss,
}: {
  toasts: LiveToast[];
  onOpen: (t: LiveToast) => void;
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICON[t.kind];
        const clickable = !!t.target;
        return (
          <div
            key={t.id}
            className={`toast tone-${TONE[t.kind]} ${clickable ? "is-clickable" : ""}`}
            {...(clickable && { role: "button", tabIndex: 0, onClick: () => onOpen(t) })}
          >
            <Icon className={`toast-icon ${t.kind === "started" ? "spin" : ""}`} strokeWidth={1.75} aria-hidden="true" />
            <span className="toast-text">
              <span className="toast-label">{t.label}</span>
              <span className="toast-verb">{VERB[t.kind]}</span>
            </span>
            <button
              className="toast-x"
              aria-label="dismiss"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(t.id);
              }}
            >
              <X className="toast-x-icon" strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
