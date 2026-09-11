/**
 * The PWA. Vanilla DOM, no framework. State is: the route, the signed-in
 * label, the thread list, and for an open thread the pure fold of its
 * events plus the attach state. Everything on screen is a function of that.
 */

import type { Cursor, DirEntry, ModelChoice, ThreadId, ThreadSummary } from "../shared/protocol";
import { HelmClient, HttpError } from "./api";
import { addPendingPrompt, applySync, emptyView, fold, type Line, type ThreadView } from "./fold";
import { assertPasskey, createPasskey } from "./webauthn";

type Conn = "connecting" | "replaying" | "live" | "offline";
type Route = { name: "list" } | { name: "thread"; threadId: ThreadId } | { name: "enroll"; token: string } | { name: "login" };

const LABEL = /iPhone|iPad/.test(navigator.userAgent) ? "iphone" : "browser";
const api = new HelmClient({ baseUrl: "", label: LABEL });
const root = document.getElementById("app")!;

// ---------------------------------------------------------------------------
// Tiny DOM helper
// ---------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "disabled" || k === "open") (el as unknown as Record<string, unknown>)[k] = Boolean(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const uuid = (): string => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function parseRoute(): Route {
  const p = location.pathname;
  const t = p.match(/^\/t\/([a-f0-9-]{8,40})$/i);
  if (t) return { name: "thread", threadId: t[1] as ThreadId };
  if (p === "/enroll") return { name: "enroll", token: new URLSearchParams(location.search).get("token") ?? "" };
  if (p === "/login") return { name: "login" };
  return { name: "list" };
}

function navigate(path: string): void {
  history.pushState(null, "", path);
  void render();
}
window.addEventListener("popstate", () => void render());

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

let teardown: (() => void) | null = null;
let me: { label: string } | null = null;

async function render(): Promise<void> {
  teardown?.();
  teardown = null;
  const route = parseRoute();
  if (route.name === "enroll") return showEnroll(route.token);
  if (!me) {
    try {
      me = await api.me();
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return showLogin();
      return showError(err);
    }
  }
  if (route.name === "login") return navigate("/");
  if (route.name === "thread") return showThread(route.threadId);
  return showList();
}

function mount(el: HTMLElement): void {
  root.replaceChildren(el);
}

function showError(err: unknown): void {
  mount(h("main", { class: "screen" }, h("p", { class: "center error" }, `Helm could not load: ${err instanceof Error ? err.message : String(err)}`), h("p", { class: "center" }, h("button", { class: "btn", onclick: () => location.reload() }, "Retry"))));
}

function showLogin(): void {
  const msg = h("p", { class: "error" });
  const btn = h("button", { class: "btn primary", onclick: async () => {
    btn.disabled = true;
    msg.textContent = "";
    try {
      const { challengeId, options } = await api.loginOptions();
      const response = await assertPasskey(options as Record<string, unknown>);
      me = await api.loginVerify(challengeId, response);
      navigate("/");
    } catch (err) {
      msg.textContent = err instanceof Error ? err.message : String(err);
      btn.disabled = false;
    }
  } }, "Sign in with Face ID");
  mount(h("main", { class: "screen" }, h("div", { class: "login" }, h("h1", {}, "Helm"), h("p", { class: "muted" }, "Your Mac, from your phone."), btn, msg)));
}

function showEnroll(token: string): void {
  const msg = h("p", { class: "error" });
  const label = h("input", { value: LABEL, placeholder: "device name" }) as HTMLInputElement;
  const btn = h("button", { class: "btn primary", onclick: async () => {
    btn.disabled = true;
    try {
      const { challengeId, options } = await api.registerOptions(token, label.value.trim() || LABEL);
      const response = await createPasskey(options as Record<string, unknown>);
      await api.registerVerify(challengeId, response);
      msg.className = "muted";
      msg.textContent = "Passkey enrolled. Sign in next.";
      setTimeout(() => navigate("/login"), 800);
    } catch (err) {
      msg.textContent = err instanceof Error ? err.message : String(err);
      btn.disabled = false;
    }
  } }, "Create passkey");
  mount(h("main", { class: "screen" }, h("div", { class: "login" }, h("h1", {}, "Enroll this phone"), h("p", { class: "muted" }, "This link was printed by the server on your Mac and works once."), h("div", { class: "field" }, h("label", {}, "Device name"), label), btn, msg)));
}

// ---- thread list ------------------------------------------------------------

async function showList(): Promise<void> {
  const list = h("ul", { class: "list" });
  const notifyBtn = h("button", { class: "btn small", onclick: () => void enablePush(notifyBtn) }, "Notifications");
  const screen = h("main", { class: "screen" },
    h("header", { class: "topbar" }, h("h1", {}, "Helm"), notifyBtn, h("button", { class: "btn primary small", onclick: () => void openNewThread() }, "New")),
    list,
  );
  mount(screen);
  void refreshPushButton(notifyBtn);

  const load = async (): Promise<void> => {
    try {
      const threads = await api.listThreads();
      list.replaceChildren(...(threads.length ? threads.map(threadCard) : [h("li", { class: "center muted" }, "No threads yet. Tap New.")]));
    } catch (err) {
      list.replaceChildren(h("li", { class: "center error" }, `Could not load threads: ${err instanceof Error ? err.message : String(err)}`));
    }
  };
  await load();
  let pending: ReturnType<typeof setTimeout> | null = null;
  const stop = api.attachGlobal(() => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => void load(), 150);
  });
  const onVisible = (): void => {
    if (document.visibilityState === "visible") void load();
  };
  document.addEventListener("visibilitychange", onVisible);
  teardown = () => {
    stop();
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function threadCard(t: ThreadSummary): HTMLElement {
  const running = t.session === "running" || t.session === "warming";
  return h("li", {}, h("button", { class: "card", onclick: () => navigate(`/t/${t.config.threadId}`) },
    h("div", { class: "title" }, h("span", {}, t.config.title ?? "Untitled"), running ? h("span", { class: "badge running" }, "running") : null),
    t.preview ? h("div", { class: "preview" }, t.preview) : null,
    h("div", { class: "meta" }, h("span", {}, shortModel(t.config.model)), t.contextTokens !== null ? h("span", {}, `ctx ${fmtK(t.contextTokens)}`) : null, h("span", {}, fmtTime(t.lastTurnEndedAt ?? t.config.createdAt)), h("span", {}, shortPath(t.config.cwd))),
  ));
}

const shortModel = (m: string): string => m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
const shortPath = (p: string): string => p.replace(/^\/Users\/[^/]+/, "~");

// ---- new thread sheet -------------------------------------------------------

let modelsCache: readonly ModelChoice[] | null = null;
async function models(): Promise<readonly ModelChoice[]> {
  if (!modelsCache) modelsCache = await api.listModels();
  return modelsCache;
}

async function openNewThread(): Promise<void> {
  const roots = await api.browseDirs();
  const catalog = await models().catch(() => [] as readonly ModelChoice[]);
  let cwd = roots.find((r) => /Vault$/.test(r.path))?.path ?? roots[0]?.path ?? "/";
  const crumb = h("div", { class: "crumb" }, shortPath(cwd));
  const dirs = h("div", { class: "dirs" });
  const modelSel = h("select", {}) as HTMLSelectElement;
  for (const m of catalog) modelSel.append(h("option", { value: m.id }, m.label));
  const effortSel = h("select", {}) as HTMLSelectElement;
  const effortField = h("div", { class: "field" }, h("label", {}, "Effort"), effortSel);
  const syncEffort = (): void => {
    const m = catalog.find((c) => c.id === modelSel.value);
    effortSel.replaceChildren(...(m?.efforts ?? []).map((e) => h("option", { value: e, selected: e === "high" }, e)));
    effortField.hidden = !m?.supportsEffort;
  };
  modelSel.addEventListener("change", syncEffort);
  syncEffort();
  const err = h("p", { class: "error" });

  const browse = async (path: string, parent: string | null): Promise<void> => {
    cwd = path;
    crumb.textContent = shortPath(path);
    let entries: readonly DirEntry[] = [];
    try {
      entries = parent === null && path === "" ? roots : await api.browseDirs(path);
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
    }
    dirs.replaceChildren(
      ...(parent !== null ? [h("button", { onclick: () => void browse(parent, roots.some((r) => r.path === parent) ? "" : parentOf(parent)) }, "..")] : []),
      ...entries.map((d) => h("button", { onclick: () => void browse(d.path, path) }, d.name, h("span", { class: "flags" }, [d.hasClaudeMd ? "CLAUDE.md" : "", d.isGitRepo ? "git" : ""].filter(Boolean).join(" ")))),
    );
  };
  const parentOf = (p: string): string => p.replace(/\/[^/]+$/, "") || "/";
  await browse(cwd, roots.some((r) => r.path === cwd) ? "" : parentOf(cwd));

  const sheet = h("div", { class: "sheet", onclick: (e: Event) => e.target === sheet && sheet.remove() },
    h("div", { class: "panel" },
      h("h2", {}, "New thread"),
      h("div", { class: "field" }, h("label", {}, "Working directory (Claude reads its CLAUDE.md)"), crumb, dirs),
      h("div", { class: "field" }, h("label", {}, "Model"), catalog.length ? modelSel : h("span", { class: "error" }, "Model catalog unavailable")),
      effortField,
      err,
      h("div", { class: "row" }, h("button", { class: "btn", onclick: () => sheet.remove() }, "Cancel"), h("span", { class: "grow" }), h("button", { class: "btn primary", disabled: !catalog.length, onclick: async () => {
        try {
          const cfg = await api.createThread({ threadId: uuid(), cwd, model: modelSel.value as ModelChoice["id"], effort: (effortSel.value || "high") as "low" | "medium" | "high" });
          sheet.remove();
          navigate(`/t/${cfg.threadId}`);
        } catch (e) {
          err.textContent = e instanceof Error ? e.message : String(e);
        }
      } }, "Create")),
    ),
  );
  document.body.append(sheet);
}

// ---- thread view ------------------------------------------------------------

async function showThread(threadId: ThreadId): Promise<void> {
  let summary: ThreadSummary;
  try {
    summary = await api.getThread(threadId);
  } catch (err) {
    return showError(err);
  }
  let view: ThreadView = emptyView(threadId);
  let conn: Conn = "connecting";
  let attachments: { uploadId: string; name: string }[] = [];

  const title = h("h1", { onclick: () => void renameThread() }, summary.config.title ?? "Untitled");
  const sub = h("div", { class: "sub", onclick: () => void reconfigure() });
  const connEl = h("span", { class: "conn" });
  const transcript = h("div", { class: "transcript" });
  const attachEl = h("div", { class: "attachments" });
  const input = h("textarea", { placeholder: "Message", rows: 1 }) as HTMLTextAreaElement;
  const fileInput = h("input", { type: "file", multiple: true, hidden: true }) as HTMLInputElement;
  const sendBtn = h("button", { class: "btn primary", onclick: () => void send() }, "Send");
  const stopBtn = h("button", { class: "btn", onclick: () => void api.interrupt(threadId) }, "Stop");
  const attachBtn = h("button", { class: "btn", onclick: () => fileInput.click() }, "+");
  const screen = h("main", { class: "screen" },
    h("header", { class: "topbar" }, h("button", { class: "btn small", onclick: () => navigate("/") }, "‹"), h("div", { style: "flex:1;min-width:0" }, title, sub), connEl, h("button", { class: "btn small", onclick: () => void archive() }, "Archive")),
    transcript,
    attachEl,
    h("div", { class: "composer" }, attachBtn, input, sendBtn, stopBtn),
    fileInput,
  );
  mount(screen);

  const lineEls: HTMLElement[] = [];
  let prevLines: readonly Line[] = [];
  const paint = (): void => {
    connEl.textContent = conn === "live" ? (view.session === "running" ? "running" : "live") : conn;
    connEl.className = `conn ${conn}`;
    sub.textContent = `${shortModel(summary.config.model)} · ${summary.config.effort}${view.contextTokens !== null ? ` · ctx ${fmtK(view.contextTokens)}` : ""}`;
    const running = view.openTurn !== null || view.session === "running" || view.session === "warming";
    stopBtn.hidden = !running;
    // Re-render only lines whose identity changed (fold replaces at most a couple per event).
    const lines = view.lines;
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80 || prevLines.length === 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === prevLines[i] && lineEls[i]) continue;
      const el = renderLine(lines[i]!);
      if (lineEls[i]) lineEls[i]!.replaceWith(el);
      else transcript.append(el);
      lineEls[i] = el;
    }
    while (lineEls.length > lines.length) lineEls.pop()!.remove();
    prevLines = lines;
    if (atBottom) window.scrollTo(0, document.body.scrollHeight);
  };

  const renderLine = (l: Line): HTMLElement => {
    switch (l.kind) {
      case "prompt":
        return h("div", { class: `line prompt ${l.state}` },
          h("span", { class: "who" }, `[${l.label}] ${l.state === "pending" ? "sending" : l.state === "queued" ? "queued" : l.state === "dropped" ? "dropped: server restarted before this ran" : ">"}`),
          l.text,
          l.uploads.length ? h("div", { class: "muted" }, `attached: ${l.uploads.join(", ")}`) : null,
          l.state === "dropped" ? h("div", { class: "resend" }, h("button", { class: "btn small", onclick: () => void submit(l.text, []) }, "Resend")) : null,
        );
      case "text":
        return h("div", { class: "line text" }, l.text);
      case "thinking":
        return h("details", { class: "line thinking" }, h("summary", {}, "thinking"), h("div", { class: "body" }, l.text));
      case "tool": {
        const mark = l.isError === null ? h("span", { class: "mark busy" }, "running") : l.isError ? h("span", { class: "mark err" }, "✗ failed") : h("span", { class: "mark ok" }, "✓ done");
        return h("details", { class: "line tool" },
          h("summary", {}, h("span", {}, `${l.name} ${toolArg(l.input)}`), mark),
          h("pre", {}, `input: ${typeof l.input === "string" ? l.input : JSON.stringify(l.input, null, 1)}`),
          l.output !== null ? h("pre", {}, l.output) : null,
        );
      }
      case "end": {
        const u = l.usage;
        const stats = u ? ` · ${fmtK(u.inputTokens + u.cacheReadTokens)} in, ${fmtK(u.outputTokens)} out${u.costUsd !== null ? `, $${u.costUsd.toFixed(3)}` : ""}, ${Math.round(u.durationMs / 1000)}s` : "";
        const text = l.outcome === "ok" ? `done${stats}` : l.outcome === "interrupted" ? `stopped${stats}` : l.outcome === "orphaned" ? "server restarted mid-turn; resend to continue" : `error: ${l.error ?? "unknown"}${stats}`;
        return h("div", { class: `line end ${l.outcome}` }, text);
      }
      case "note":
        return h("div", { class: "line note" }, l.text);
    }
  };

  const toolArg = (input: unknown): string => {
    if (!input || typeof input !== "object") return "";
    const o = input as Record<string, unknown>;
    const v = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.query ?? o.url ?? o.description ?? "";
    return typeof v === "string" ? shortPath(v).slice(0, 80) : "";
  };

  const stop = api.attach(threadId, 0, {
    onEvent: (ev) => {
      view = fold(view, ev);
      if (ev.kind === "thread.config") {
        if (ev.patch.title !== undefined) title.textContent = ev.patch.title;
        summary = { ...summary, config: { ...summary.config, ...ev.patch } };
      }
      paint();
    },
    onSync: (frame) => {
      view = applySync(view, frame);
      if (view.headSeq === 0 && frame.headSeq > 0) {
        // Reset: the attach loop replays from zero and the fold rebuilds.
        prevLines = [];
        transcript.replaceChildren();
        lineEls.length = 0;
      }
      paint();
    },
    onState: (s) => {
      conn = s;
      paint();
    },
  });

  const submit = async (text: string, uploadIds: string[]): Promise<void> => {
    const clientMsgId = uuid();
    view = addPendingPrompt(view, clientMsgId, text, LABEL);
    paint();
    try {
      await api.send(threadId, { clientMsgId, text, uploadIds });
    } catch (err) {
      alert(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const send = async (): Promise<void> => {
    const text = input.value.trim();
    if (!text && !attachments.length) return;
    const ids = attachments.map((a) => a.uploadId);
    input.value = "";
    input.style.height = "";
    attachments = [];
    attachEl.replaceChildren();
    await submit(text, ids);
  };
  input.addEventListener("input", () => {
    input.style.height = "";
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
  });
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    if (!files.length) return;
    attachBtn.disabled = true;
    try {
      const staged = await api.upload(threadId, files);
      attachments.push(...staged.map((s) => ({ uploadId: s.uploadId, name: s.name })));
      attachEl.replaceChildren(...attachments.map((a) => h("span", {}, a.name)));
    } catch (err) {
      alert(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      attachBtn.disabled = false;
    }
  });

  const renameThread = async (): Promise<void> => {
    const t = prompt("Thread title", summary.config.title ?? "");
    if (t && t.trim()) await api.patchThread(threadId, { title: t.trim() });
  };
  const reconfigure = async (): Promise<void> => {
    const catalog = await models().catch(() => [] as readonly ModelChoice[]);
    if (!catalog.length) return;
    const current = catalog.find((c) => c.id === summary.config.model);
    const modelSel = h("select", {}) as HTMLSelectElement;
    for (const m of catalog) modelSel.append(h("option", { value: m.id, selected: m.id === summary.config.model }, m.label));
    const effortSel = h("select", {}) as HTMLSelectElement;
    const effortField = h("div", { class: "field" }, h("label", {}, "Effort"), effortSel);
    const syncEffort = (): void => {
      const m = catalog.find((c) => c.id === modelSel.value) ?? current;
      effortSel.replaceChildren(...(m?.efforts ?? []).map((e) => h("option", { value: e, selected: e === summary.config.effort }, e)));
      effortField.hidden = !m?.supportsEffort;
    };
    modelSel.addEventListener("change", syncEffort);
    syncEffort();
    const sheet = h("div", { class: "sheet", onclick: (e: Event) => e.target === sheet && sheet.remove() },
      h("div", { class: "panel" }, h("h2", {}, "Model and effort"), h("p", { class: "muted" }, "Applies at the next turn."),
        h("div", { class: "field" }, h("label", {}, "Model"), modelSel), effortField,
        h("div", { class: "row" }, h("button", { class: "btn", onclick: () => sheet.remove() }, "Cancel"), h("span", { class: "grow" }), h("button", { class: "btn primary", onclick: async () => {
          const patch: { model?: ModelChoice["id"]; effort?: "low" | "medium" | "high" } = {};
          if (modelSel.value !== summary.config.model) patch.model = modelSel.value as ModelChoice["id"];
          if (!effortField.hidden && effortSel.value !== summary.config.effort) patch.effort = effortSel.value as "low" | "medium" | "high";
          if (Object.keys(patch).length) await api.patchThread(threadId, patch);
          sheet.remove();
        } }, "Apply"))));
    document.body.append(sheet);
  };
  const archive = async (): Promise<void> => {
    if (!confirm("Archive this thread? Its process stops; history is kept.")) return;
    await api.archiveThread(threadId);
    navigate("/");
  };

  paint();
  teardown = stop;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
}

async function refreshPushButton(btn: HTMLButtonElement): Promise<void> {
  if (!("PushManager" in window) || !("Notification" in window)) {
    btn.hidden = true;
    return;
  }
  const reg = await swRegistration();
  const sub = await reg?.pushManager.getSubscription();
  btn.textContent = sub && Notification.permission === "granted" ? "Notifications on" : "Notifications";
  btn.disabled = Boolean(sub && Notification.permission === "granted");
}

async function enablePush(btn: HTMLButtonElement): Promise<void> {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    const reg = await swRegistration();
    if (!reg) return;
    const { key } = await api.pushPublicKey();
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey(key) as BufferSource });
    await api.pushSubscribe(sub.toJSON());
    await refreshPushButton(btn);
  } catch (err) {
    alert(`Notifications could not be enabled: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function vapidKey(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------

void swRegistration().catch(() => null);
void render();
