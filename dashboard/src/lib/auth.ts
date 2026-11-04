import { fetchJson } from "./api";

interface LoginOptions {
  challengeId: string;
  options: {
    rpId: string;
    challenge: string;
    userVerification: UserVerificationRequirement;
    allowCredentials?: { type: "public-key"; id: string }[];
  };
}

function fromBase64url(text: string): ArrayBuffer {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return bytes.buffer;
}

function toBase64url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The passkey sign in ceremony. Resolves to null on success (the server set the cookie), else what went wrong. */
export async function signIn(): Promise<string | null> {
  if (!("credentials" in navigator) || typeof PublicKeyCredential === "undefined") {
    return "This browser cannot use passkeys. Open helm in Safari or Chrome.";
  }
  const begun = await fetchJson<LoginOptions>("/auth/login/options", {});
  if (begun.state !== "ready") return begun.detail;
  const { challengeId, options } = begun.data;

  const publicKey: PublicKeyCredentialRequestOptions = {
    rpId: options.rpId,
    challenge: fromBase64url(options.challenge),
    userVerification: options.userVerification,
  };
  if (options.allowCredentials !== undefined) {
    publicKey.allowCredentials = options.allowCredentials.map((c) => ({ type: c.type, id: fromBase64url(c.id) }));
  }

  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({ publicKey });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return `The passkey was not used (${why}). Try again.`;
  }
  if (!(credential instanceof PublicKeyCredential)) return "The browser returned no passkey. Try again.";
  const response = credential.response as AuthenticatorAssertionResponse;

  const verified = await fetchJson<{ label: string }>("/auth/login/verify", {
    challengeId,
    credential: {
      id: credential.id,
      rawId: toBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toBase64url(response.clientDataJSON),
        authenticatorData: toBase64url(response.authenticatorData),
        signature: toBase64url(response.signature),
        userHandle: response.userHandle === null ? null : toBase64url(response.userHandle),
      },
    },
  });
  return verified.state === "ready" ? null : verified.detail;
}
