// push.mjs against a fake push service on loopback: one endpoint takes the notification, one
// answers 410, one answers 500. Run with `npm test` in dashboard/.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import ece from "http_ece";

const SCRIPT = new URL("./push.mjs", import.meta.url).pathname;
const state = mkdtempSync(join(tmpdir(), "helm-push-"));
const received = [];
let server;
let base;

// Asynchronous, because the fake push service answers from this same process.
function run(command, stdin = "") {
  const child = spawn(process.execPath, [SCRIPT, command], {
    env: { ...process.env, HELM_STATE: state, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(stdin);
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

const browsers = new Map();

function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey("base64url"), auth: randomBytes(16).toString("base64url") };
  browsers.set(keys.p256dh, { ecdh, auth: keys.auth });
  return keys;
}

function decrypt(body, keys) {
  const browser = browsers.get(keys.p256dh);
  const plain = ece.decrypt(body, { version: "aes128gcm", privateKey: browser.ecdh, authSecret: browser.auth });
  return JSON.parse(plain.toString("utf8"));
}

before(async () => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-subj", "/CN=localhost", "-days", "1", "-keyout", join(state, "key.pem"), "-out", join(state, "cert.pem")],
    { stdio: "ignore" });
  server = createServer({ key: readFileSync(join(state, "key.pem")), cert: readFileSync(join(state, "cert.pem")) },
    (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        res.statusCode = req.url === "/gone" ? 410 : req.url === "/broken" ? 500 : 201;
        res.end();
      });
    });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(state, { recursive: true, force: true });
});

test("key makes one VAPID pair, private to the owner, and prints the same key every time", async () => {
  const first = await run("key");
  assert.equal(first.status, 0, first.stderr);
  const key = first.stdout.trim();
  assert.match(key, /^[A-Za-z0-9_-]{87}$/);
  assert.equal(statSync(join(state, "push", "vapid.json")).mode & 0o777, 0o600);
  assert.equal((await run("key")).stdout.trim(), key);
});

test("send delivers to each subscription and names the gone ones without touching the file", async () => {
  mkdirSync(join(state, "push"), { recursive: true });
  const subs = ["/ok", "/gone", "/broken"].map((path) => ({ endpoint: base + path, keys: browserKeys(), created: "x" }));
  const file = join(state, "push", "dashboard.json");
  writeFileSync(file, JSON.stringify({ subscriptions: subs }));
  received.length = 0;

  const out = await run("send", JSON.stringify({ title: "backup failed: volume absent", tab: "background", count: 2 }));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { sent: 1, failed: 1, gone: [base + "/gone"] });
  assert.equal(received.length, 3);
  const ok = received.find((r) => r.path === "/ok");
  assert.equal(ok.headers["content-encoding"], "aes128gcm");
  assert.match(ok.headers.authorization, /^vapid t=/);
  assert.deepEqual(decrypt(ok.body, subs[0].keys), { title: "backup failed: volume absent", tab: "background", count: 2 });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).subscriptions, subs);
});

test("send with every subscription failing exits 1, and with none exits 0", async () => {
  const file = join(state, "push", "dashboard.json");
  writeFileSync(file, JSON.stringify({ subscriptions: [{ endpoint: base + "/broken", keys: browserKeys() }] }));
  const payload = JSON.stringify({ title: "t", tab: "ideas", count: 1 });
  assert.equal((await run("send", payload)).status, 1);
  writeFileSync(file, JSON.stringify({ subscriptions: [] }));
  const none = await run("send", payload);
  assert.equal(none.status, 0);
  assert.deepEqual(JSON.parse(none.stdout), { sent: 0, failed: 0, gone: [] });
});

test("send refuses a payload outside {title, tab, count}", async () => {
  for (const bad of [{ tab: "ideas", count: 1 }, { title: "t", tab: "nowhere", count: 1 }, { title: "t", tab: "ideas" }]) {
    assert.equal((await run("send", JSON.stringify(bad))).status, 1);
  }
});
