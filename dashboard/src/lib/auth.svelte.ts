// The door, as the page sees it. Over loopback the server says the visitor is in and none
// of this is shown. Over the tailnet the page asks once at load, shows the sign in screen on
// a no, and drops back to it the moment any read answers 401.

import { getMe, onUnauthorized, postJson } from "./api";
import { create, get, supported } from "./webauthn";
import type { CreationOptions, RequestOptions } from "./webauthn";

export type Gate =
  | { name: "checking" }
  | { name: "in" }
  | { name: "out"; busy: boolean; message: string }
  | { name: "enroll"; token: string; busy: boolean; message: string };

let gate = $state<Gate>({ name: "checking" });

onUnauthorized(() => auth.expired());

function reason(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

async function ceremony(run: () => Promise<void>, failed: (message: string) => Gate): Promise<void> {
  if (!supported()) {
    gate = failed("this browser has no passkeys");
    return;
  }
  try {
    await run();
    gate = { name: "in" };
  } catch (cause) {
    gate = failed(reason(cause));
  }
}

export const auth = {
  get gate(): Gate {
    return gate;
  },

  /** Once, at load. The enroll link carries its token in the query and shows the enroll
   *  screen whatever the session says, so a second phone can be added from a signed in one. */
  async check(): Promise<void> {
    const token = new URLSearchParams(window.location.search).get("token");
    if (window.location.pathname === "/enroll" && token !== null) {
      gate = { name: "enroll", token, busy: false, message: "" };
      return;
    }
    try {
      const me = await getMe();
      gate = me.authenticated ? { name: "in" } : { name: "out", busy: false, message: "" };
    } catch (cause) {
      gate = { name: "out", busy: false, message: reason(cause) };
    }
  },

  /** A 401 on any read. The page goes back to the door without losing what it had. */
  expired(): void {
    if (gate.name === "in") gate = { name: "out", busy: false, message: "signed out; sign in again" };
  },

  async signIn(): Promise<void> {
    gate = { name: "out", busy: true, message: "" };
    await ceremony(async () => {
      const started = await postJson<{ challengeId: string; options: RequestOptions }>("/auth/login/options", {});
      const credential = await get(started.options);
      await postJson("/auth/login/verify", { challengeId: started.challengeId, credential });
    }, (message) => ({ name: "out", busy: false, message }));
  },

  async enroll(label: string): Promise<void> {
    if (gate.name !== "enroll") return;
    const token = gate.token;
    gate = { name: "enroll", token, busy: true, message: "" };
    await ceremony(async () => {
      const started = await postJson<{ challengeId: string; options: CreationOptions }>("/auth/register/options", { token });
      const credential = await create(started.options);
      await postJson("/auth/register/verify", { token, challengeId: started.challengeId, credential, label });
      window.history.replaceState(null, "", "/");
    }, (message) => ({ name: "enroll", token, busy: false, message }));
  },
};
