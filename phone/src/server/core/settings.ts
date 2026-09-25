/**
 * Server-wide preferences in <HELM_HOME>/settings.json.
 *
 * The file is a partial overlay, not the whole record: anything missing falls
 * back to a default, so a hand-edited or half-written file still boots. Keys
 * the file carries that this version does not know are dropped on read rather
 * than rejected, so a downgrade after a newer version wrote the file does not
 * wedge the server. The HTTP parser is the strict one: a client sending an
 * unknown field has a bug, and a silent no-op would hide it.
 */

import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_EFFORT, EFFORTS, PERMISSION_MODES, THEMES } from "../../shared/protocol";
import type { Effort, HelmSettings, ModelId, PermissionMode, SettingsPatch } from "../../shared/protocol";
import { atomicWrite } from "../util/atomicWrite";

/** Pure: the settings a file's contents describe, with every unknown or ill-typed field ignored. */
export function settingsFrom(raw: unknown, defaults: HelmSettings): HelmSettings {
  if (typeof raw !== "object" || raw === null) return defaults;
  const r = raw as Record<string, unknown>;
  return {
    theme: THEMES.includes(r.theme as HelmSettings["theme"]) ? (r.theme as HelmSettings["theme"]) : defaults.theme,
    defaultModel: typeof r.defaultModel === "string" ? (r.defaultModel as ModelId) : r.defaultModel === null ? null : defaults.defaultModel,
    defaultEffort: EFFORTS.includes(r.defaultEffort as Effort) ? (r.defaultEffort as Effort) : defaults.defaultEffort,
    defaultCwd: typeof r.defaultCwd === "string" && r.defaultCwd.startsWith("/") ? r.defaultCwd : defaults.defaultCwd,
    defaultPermissionMode: PERMISSION_MODES.includes(r.defaultPermissionMode as PermissionMode) ? (r.defaultPermissionMode as PermissionMode) : defaults.defaultPermissionMode,
  };
}

export class SettingsStore {
  private readonly defaults: HelmSettings;
  /** Read-modify-write is serialized per store so two concurrent patches cannot lose an update. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string, defaults: { defaultCwd: string }) {
    // New threads outside the vault get the gate; the vault root itself is always bypass at creation (http/app.ts).
    this.defaults = { theme: "system", defaultModel: null, defaultEffort: DEFAULT_EFFORT, defaultCwd: defaults.defaultCwd, defaultPermissionMode: "ask" };
  }

  async get(): Promise<HelmSettings> {
    let raw: unknown = null;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8"));
    } catch (err) {
      // No file yet is the normal state until the first patch.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[settings] cannot read ${this.file}`, err);
    }
    const settings = settingsFrom(raw, this.defaults);
    // A saved cwd can outlive the directory (the vault moved once already). New threads
    // would then fail to create, so a dead path yields to the default instead of being trusted.
    const alive = await stat(settings.defaultCwd).then((s) => s.isDirectory(), () => false);
    return alive ? settings : { ...settings, defaultCwd: this.defaults.defaultCwd };
  }

  async patch(p: SettingsPatch): Promise<HelmSettings> {
    const run = this.writes.then(async () => {
      const next: HelmSettings = { ...(await this.get()), ...p };
      await mkdir(dirname(this.file), { recursive: true });
      await atomicWrite(this.file, JSON.stringify(next, null, 2) + "\n");
      return next;
    });
    this.writes = run.catch(() => undefined);
    return run;
  }
}
