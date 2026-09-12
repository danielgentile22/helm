/** One-tap thread creation. The settings defaults answer every question the
    NewThread sheet would otherwise ask, so the list can create without a sheet. */

import { DEFAULT_EFFORT, type Effort, type HelmSettings, type ModelChoice, type ThreadConfig } from "../shared/protocol";
import type { HelmClient } from "./api";
import { uuid } from "./format";

function pickEffort(model: ModelChoice, preferred: Effort | undefined): Effort {
  const first = model.efforts[0] ?? DEFAULT_EFFORT;
  if (!model.supportsEffort) return first;
  return preferred && model.efforts.includes(preferred) ? preferred : first;
}

export async function createWithDefaults(api: HelmClient, settings: HelmSettings | null, catalog: readonly ModelChoice[], cwdOverride?: string): Promise<ThreadConfig> {
  const cwd = cwdOverride ?? settings?.defaultCwd;
  if (!cwd) throw new Error("No working directory yet. Set a default in Settings, or use the new thread sheet to pick one.");

  /* A default model the live catalog no longer offers would be rejected at the
     HTTP boundary, so it falls through to the same fallback as no default. */
  const model = (settings?.defaultModel ? catalog.find((m) => m.id === settings.defaultModel) : undefined) ?? catalog.find((m) => /opus/i.test(m.id)) ?? catalog[0];
  if (!model) throw new Error("Model catalog unavailable. Reconnect and try again.");

  return api.createThread({ threadId: uuid(), cwd, model: model.id, effort: pickEffort(model, settings?.defaultEffort) });
}
