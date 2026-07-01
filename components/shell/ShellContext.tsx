"use client";

import { createContext, useContext } from "react";
import type { VaultState } from "@/lib/vault";
import type { Status } from "@/lib/status";
import type { CoreMode } from "@/lib/core";
import type { BgMode, CoreFlare } from "@/components/GraphCore";

// One line in the desktop voice + run activity feed (Today only).
export interface FeedLine {
  ts: string;
  cls: string;
  text: string;
}

// Everything the shell hoists and shares with the tabs. The 5s vault poll and
// voice live here exactly once; tabs read this context instead of re-fetching.
export interface ShellValue {
  state: VaultState | null;
  error: boolean;
  refresh: () => void;
  status: Status;
  isPhone: boolean;

  // core / voice — drives the Today orb, the audio meter, and the shell chip
  mode: CoreMode;
  flare: CoreFlare | null;
  bgMode: BgMode;
  voiceSpeaking: boolean;
  getLevel: () => number | null;

  // desktop voice + run activity feed (rendered on Today)
  feed: FeedLine[];

  // actions
  openReport: (path: string) => void;
  openTranscript: () => void;
  /** drop a real intent into system/queue; resolves true on a successful write */
  queueSkill: (skill: string, args?: Record<string, unknown>) => Promise<boolean>;
}

export const ShellContext = createContext<ShellValue | null>(null);

export function useShell(): ShellValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside <Shell>");
  return ctx;
}
