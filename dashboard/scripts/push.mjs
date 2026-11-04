#!/usr/bin/env node
// Web Push sender for helm's alerts (ADR 0039). runner/push.py is the only caller.
//
//   node push.mjs key          print the VAPID public key, making the pair on first use
//   node push.mjs send         read {title, tab, count} on stdin and send it to every
//                              subscription in ~/.helm/push/dashboard.json; print
//                              {sent, failed, gone} where gone lists endpoints that answered
//                              404 or 410
//
// This script never writes dashboard.json: push.py removes the gone endpoints under its lock.
// It exits 1 when there were subscriptions and none of them took the notification.
// HELM_PUSH_SUBJECT names the contact the push services see; the default is a placeholder.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";

const STATE = process.env.HELM_STATE || join(homedir(), ".helm");
const DIR = join(STATE, "push");
const VAPID = join(DIR, "vapid.json");
const SUBSCRIPTIONS = join(DIR, "dashboard.json");
const SUBJECT = process.env.HELM_PUSH_SUBJECT || "mailto:helm@example.com";
const GONE = new Set([404, 410]);
const TABS = new Set(["projects", "ideas", "background", "devices"]);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function vapidKeys() {
  const existing = readJson(VAPID);
  if (existing) return existing;
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const keys = webpush.generateVAPIDKeys();
  try {
    // wx: two first runs at once both generate, and only one pair is ever kept.
    writeFileSync(VAPID, JSON.stringify(keys, null, 1) + "\n", { flag: "wx", mode: 0o600 });
    return keys;
  } catch (err) {
    if (err.code === "EEXIST") return readJson(VAPID);
    throw err;
  }
}

function payloadFrom(text) {
  const raw = JSON.parse(text);
  if (typeof raw?.title !== "string" || raw.title === "") throw new Error("payload needs a title");
  if (!TABS.has(raw.tab)) throw new Error("payload needs a tab");
  if (!Number.isInteger(raw.count) || raw.count < 0) throw new Error("payload needs a count");
  return { title: raw.title, tab: raw.tab, count: raw.count };
}

async function send(payload) {
  const keys = vapidKeys();
  const subs = readJson(SUBSCRIPTIONS)?.subscriptions ?? [];
  const options = {
    vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 24 * 3600,
    timeout: 10_000,
  };
  const body = JSON.stringify(payload);
  const result = { sent: 0, failed: 0, gone: [] };
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, options);
        result.sent++;
      } catch (err) {
        if (GONE.has(err.statusCode)) {
          result.gone.push(sub.endpoint);
          return;
        }
        result.failed++;
        console.error(`push to ${new URL(sub.endpoint).host} failed: ${err.statusCode ?? err.code ?? err.message}`);
      }
    }),
  );
  return result;
}

async function main(command) {
  if (command === "key") {
    console.log(vapidKeys().publicKey);
    return 0;
  }
  if (command === "send") {
    const result = await send(payloadFrom(readFileSync(0, "utf8")));
    console.log(JSON.stringify(result));
    return result.failed > 0 && result.sent === 0 ? 1 : 0;
  }
  console.error("usage: node push.mjs key | send < payload.json");
  return 2;
}

main(process.argv[2]).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
