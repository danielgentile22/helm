import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnrollTokens, FileSessionStore, WebAuthn, authenticate, bodyTooLarge, checkApiKey, sessionCookie } from "./auth";

test("checkApiKey fails closed when unconfigured, rejects a wrong or missing key, accepts the right one", () => {
  assert.deepEqual(checkApiKey("anything", undefined), { ok: false, status: 503, error: "API key not configured" });
  assert.deepEqual(checkApiKey(null, "secret"), { ok: false, status: 401, error: "missing API key" });
  assert.deepEqual(checkApiKey("wrong", "secret"), { ok: false, status: 401, error: "bad API key" });
  assert.deepEqual(checkApiKey("secre", "secret"), { ok: false, status: 401, error: "bad API key" });
  assert.deepEqual(checkApiKey("secret", "secret"), { ok: true, origin: { via: "key", label: "curl" } });
});

test("bodyTooLarge rejects a missing Content-Length and anything over the cap", () => {
  assert.equal(bodyTooLarge(new Headers(), 100), true);
  assert.equal(bodyTooLarge(new Headers({ "content-length": "101" }), 100), true);
  assert.equal(bodyTooLarge(new Headers({ "content-length": "100" }), 100), false);
  assert.equal(bodyTooLarge(new Headers({ "content-length": "abc" }), 100), true);
});

test("session store: mint, lookup, expiry, persistence across instances, revokeAll", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helm2-auth-"));
  let now = 1_000_000;
  const store = new FileSessionStore(join(dir, "sessions.json"), () => now);
  const token = await store.mint("iphone", 1000);
  assert.equal(token.length, 64);
  assert.deepEqual(await store.lookup(token), { label: "iphone" });
  assert.equal(await store.lookup("nope"), null);

  const reloaded = new FileSessionStore(join(dir, "sessions.json"), () => now);
  assert.deepEqual(await reloaded.lookup(token), { label: "iphone" }, "a restart keeps the phone logged in");

  now += 1001;
  assert.equal(await reloaded.lookup(token), null, "expired");
  const t2 = await reloaded.mint("laptop", 1000);
  await reloaded.revokeAll();
  assert.equal(await reloaded.lookup(t2), null);
  assert.equal(JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")).length, 0);
  await rm(dir, { recursive: true });
});

test("authenticate: cookie first, then API key header, else 401", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helm2-auth-"));
  const sessions = new FileSessionStore(join(dir, "sessions.json"), () => 0);
  const token = await sessions.mint("iphone", 60_000);
  const deps = { apiKey: "secret", sessions, now: () => 0 };
  const req = (h: Record<string, string>) => new Request("http://x/api/threads", { headers: h });
  assert.deepEqual(await authenticate(req({ cookie: `helm_session=${token}` }), deps), { ok: true, origin: { via: "pwa", label: "iphone" } });
  assert.deepEqual(await authenticate(req({ cookie: `other=1; helm_session=${token}; x=2` }), deps), { ok: true, origin: { via: "pwa", label: "iphone" } });
  assert.deepEqual(await authenticate(req({ "x-helm-key": "secret" }), deps), { ok: true, origin: { via: "key", label: "curl" } });
  assert.deepEqual(await authenticate(req({ cookie: "helm_session=stale", "x-helm-key": "secret" }), deps), { ok: true, origin: { via: "key", label: "curl" } });
  assert.deepEqual(await authenticate(req({}), deps), { ok: false, status: 401, error: "not signed in" });
  assert.deepEqual(await authenticate(req({ "x-helm-key": "wrong" }), deps), { ok: false, status: 401, error: "bad API key" });
  assert.equal((await authenticate(req({}), { ...deps, apiKey: undefined })).ok, false);
  await rm(dir, { recursive: true });
});

test("sessionCookie sets the hardened attributes and the configured lifetime", () => {
  const c = sessionCookie("abc", 12 * 3600_000);
  assert.equal(c, "helm_session=abc; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200");
  assert.equal(sessionCookie("", 0), "helm_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
});

test("enroll tokens are one-shot and expire", () => {
  let now = 0;
  const tokens = new EnrollTokens(() => now, 1000);
  const t = tokens.mint();
  assert.equal(tokens.consume("nope"), false);
  assert.equal(tokens.consume(t), true);
  assert.equal(tokens.consume(t), false, "second use rejected");
  const t2 = tokens.mint();
  now = 1001;
  assert.equal(tokens.consume(t2), false, "expired");
});

test("webauthn: registration and assertion options have the right shape; credentials persist as a list keyed by device", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helm2-auth-"));
  const sessions = new FileSessionStore(join(dir, "sessions.json"), () => 0);
  const wa = new WebAuthn({ rpId: "mac.tail1234.ts.net", origin: "https://mac.tail1234.ts.net", credentialsFile: join(dir, "credentials.json"), sessions, sessionTtlMs: 1000 });
  const reg = await wa.registrationOptions("iphone");
  assert.ok(reg.challengeId);
  const opts = reg.options as { rp: { id: string }; user: { name: string }; challenge: string; authenticatorSelection: { residentKey: string; userVerification: string } };
  assert.equal(opts.rp.id, "mac.tail1234.ts.net");
  assert.equal(opts.user.name, "iphone");
  assert.ok(opts.challenge.length > 20);
  assert.equal(opts.authenticatorSelection.residentKey, "required");
  assert.equal(opts.authenticatorSelection.userVerification, "required");

  const login = await wa.assertionOptions();
  const lo = login.options as { rpId: string; userVerification: string; allowCredentials?: unknown[] };
  assert.equal(lo.rpId, "mac.tail1234.ts.net");
  assert.equal(lo.userVerification, "required");
  assert.equal(await wa.listCredentials().then((l) => l.length), 0);

  await assert.rejects(wa.finishRegistration("bogus", {}), /unknown or expired challenge/);
  await assert.rejects(wa.finishRegistration(reg.challengeId, { id: "x", rawId: "x", type: "public-key", response: {} }));
  await assert.rejects(wa.finishRegistration(reg.challengeId, {}), /unknown or expired challenge/, "a failed attempt consumed the challenge");
  await rm(dir, { recursive: true });
});
