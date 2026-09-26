/** Server-wide preferences, held once per page load. Patches are optimistic:
    the screen shows the new value immediately and rolls back if the server refuses. */

import type { HelmSettings, SettingsPatch } from "../shared/protocol";
import type { HelmClient } from "./api";

class Settings {
  value = $state.raw<HelmSettings | null>(null);

  async load(api: HelmClient): Promise<void> {
    if (this.value) return;
    this.value = await api.getSettings();
  }

  async patch(api: HelmClient, p: SettingsPatch): Promise<void> {
    const previous = this.value;
    if (previous) this.value = { ...previous, ...p };
    try {
      this.value = await api.patchSettings(p);
    } catch (err) {
      this.value = previous;
      throw err;
    }
  }
}

export const settings = new Settings();
