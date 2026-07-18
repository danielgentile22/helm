/**
 * Minimal Notion REST client for the Morphy board.
 *
 * The RUNNER owns all Notion I/O — the HUD/Next process never calls Notion, it
 * only reads the JSON cache the runner writes (system/morphy-state.json). The
 * token (NOTION_TOKEN) and the Tasks database id (MORPHY_DB_ID) both live in
 * ~/.claude/.env — no hardcoded defaults. Uses global fetch (Node 18+). No deps.
 */

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";

export function notionConfigured(token) {
  return typeof token === "string" && token.length > 0;
}

async function notionFetch(token, route, init = {}) {
  const res = await fetch(`${API}${route}`, {
    ...init,
    // a hung TCP connection must not pin a runner slot for undici's ~300s
    // default — fail the sync and let the next cycle retry
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Notion ${route} ${res.status}: ${body.slice(0, 180)}`);
  }
  return res.json();
}

const sel = (p) => p?.select?.name ?? null;
const txt = (rich) => (rich || []).map((r) => r.plain_text).join("").trim();

// Board text (task names AND the Assignee/Status/Priority/Added-by select
// options) is co-edited by the collaborator / an API client and flows verbatim into
// files that skip-permissions sessions are *instructed* to read
// (morphy-state.json, the board snapshot -> the morning-report/weekly-review
// prompts). Replace every Unicode control char (\p{Cc} covers C0, DEL, and C1
// such as U+0085 NEL) with a space, collapse the remaining whitespace (\s folds
// U+2028/U+2029 line/para separators too), and length-cap -- so no field can
// inject a markdown heading or a line of "instructions" into those reads (#18).
export function sanitizeBoardText(s) {
  return String(s ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Page through the whole Tasks DB → a flat array of normalized task objects. */
export async function queryTasks(token, dbId) {
  if (!dbId) throw new Error("no MORPHY_DB_ID in ~/.claude/.env");
  const tasks = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(token, `/databases/${dbId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    for (const pg of data.results || []) {
      const props = pg.properties || {};
      tasks.push({
        id: pg.id,
        name: sanitizeBoardText(txt(props.Name?.title)) || "(untitled)",
        status: sanitizeBoardText(sel(props.Status)) || "Todo",
        assignee: sanitizeBoardText(sel(props.Assignee)) || "Unassigned",
        addedBy: sanitizeBoardText(sel(props["Added by"])) || null,
        priority: sanitizeBoardText(sel(props.Priority)) || null,
        due: props.Due?.date?.start ?? null,
        lastEdited: pg.last_edited_time ?? null,
      });
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return tasks;
}

/** Create one task row. Defaults match a voice-captured todo from Daniel. */
export async function createTask(token, dbId, task) {
  if (!dbId) throw new Error("no MORPHY_DB_ID in ~/.claude/.env");
  const {
    title,
    status = "Todo",
    assignee = "Unassigned",
    addedBy = "Daniel",
    priority = "Med",
    notes,
  } = task || {};
  const properties = {
    Name: { title: [{ text: { content: String(title).slice(0, 200) } }] },
    Status: { select: { name: status } },
    Assignee: { select: { name: assignee } },
    "Added by": { select: { name: addedBy } },
    Priority: { select: { name: priority } },
  };
  if (notes) {
    properties.Notes = { rich_text: [{ text: { content: String(notes).slice(0, 1900) } }] };
  }
  return notionFetch(token, `/pages`, {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: dbId }, properties }),
  });
}
