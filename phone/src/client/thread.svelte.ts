/** The only file that may hold the session's `$state.raw`: it hands ThreadSession a reactive cell and nothing else. */

import type { ThreadSummary } from "../shared/protocol";
import type { HelmClient } from "./api";
import { LABEL } from "./label";
import { initialState, ThreadSession, type ThreadState } from "./thread";

export function openThread(api: HelmClient, summary: ThreadSummary): ThreadSession {
  let state = $state.raw<ThreadState>(initialState(summary));
  return new ThreadSession(api, summary.config.threadId, LABEL, { get: () => state, set: (next) => (state = next) });
}
