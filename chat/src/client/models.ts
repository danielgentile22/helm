/** The model catalog is asked for once per page load and shared by both sheets. */

import type { ModelChoice } from "../shared/protocol";
import type { HelmClient } from "./api";

let cache: readonly ModelChoice[] | null = null;

export async function models(api: HelmClient): Promise<readonly ModelChoice[]> {
  if (!cache) cache = await api.listModels();
  return cache;
}
