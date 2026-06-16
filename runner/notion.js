/**
 * Minimal Notion REST client for the Morphy board.
 *
 * The RUNNER owns all Notion I/O — the HUD/Next process never calls Notion, it
 * only reads the JSON cache the runner writes (system/morphy-state.json). The
 * token (NOTION_TOKEN) lives in ~/.claude/.env; the board's IDs are NOT secret
 * (default below, override via env). Uses global fetch (Node 18+). No deps.
 */

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";

// The Morphy "Tasks" database, created during the Morphy-workspace build.
export const MORPHY_DB_ID_DEFAULT = "REDACTED-NOTION-DB-ID";

export function notionConfigured(token) {
  return typeof token === "string" && token.length > 0;
}

async function notionFetch(token, route, init = {}) {
  const res = await fetch(`${API}${route}`, {
    ...init,
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

/** Page through the whole Tasks DB → a flat array of normalized task objects. */
export async function queryTasks(token, dbId = MORPHY_DB_ID_DEFAULT) {
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
        name: txt(props.Name?.title) || "(untitled)",
        status: sel(props.Status) || "Todo",
        assignee: sel(props.Assignee) || "Unassigned",
        addedBy: sel(props["Added by"]),
        priority: sel(props.Priority),
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
    body: JSON.stringify({ parent: { database_id: dbId || MORPHY_DB_ID_DEFAULT }, properties }),
  });
}
