// The two browser ceremonies, with the byte fields the server sends as base64url turned into
// buffers on the way in and back into base64url on the way out. Hand rolled rather than the
// `toJSON` helpers, which the phone's Safari grew later than the rest of the API.

function toBytes(text: string): ArrayBuffer {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

function fromBytes(buffer: ArrayBuffer): string {
  let raw = "";
  for (const byte of new Uint8Array(buffer)) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Descriptor = { type: "public-key"; id: string; transports?: AuthenticatorTransport[] };

function descriptors(rows: Descriptor[] | undefined): PublicKeyCredentialDescriptor[] | undefined {
  return rows?.map((row) => ({ ...row, id: toBytes(row.id) }));
}

export type CreationOptions = Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> & {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: Descriptor[];
};

export type RequestOptions = Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials"> & {
  challenge: string;
  allowCredentials?: Descriptor[];
};

export function supported(): boolean {
  return typeof PublicKeyCredential !== "undefined" && typeof navigator.credentials?.create === "function";
}

export async function create(options: CreationOptions): Promise<unknown> {
  const { excludeCredentials, ...rest } = options;
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...rest,
    challenge: toBytes(options.challenge),
    user: { ...options.user, id: toBytes(options.user.id) },
  };
  const exclude = descriptors(excludeCredentials);
  if (exclude !== undefined) publicKey.excludeCredentials = exclude;
  const credential = await navigator.credentials.create({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("the browser made no passkey");
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: fromBytes(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: fromBytes(response.clientDataJSON),
      attestationObject: fromBytes(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
  };
}

export async function get(options: RequestOptions): Promise<unknown> {
  const { allowCredentials, ...rest } = options;
  const publicKey: PublicKeyCredentialRequestOptions = { ...rest, challenge: toBytes(options.challenge) };
  const allow = descriptors(allowCredentials);
  if (allow !== undefined) publicKey.allowCredentials = allow;
  const credential = await navigator.credentials.get({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("the browser signed nothing");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: fromBytes(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: fromBytes(response.clientDataJSON),
      authenticatorData: fromBytes(response.authenticatorData),
      signature: fromBytes(response.signature),
    },
  };
}
