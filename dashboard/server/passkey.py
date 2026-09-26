"""The verification half of a WebAuthn passkey ceremony, for one user and one key type.

Python standard library only (ADR 0021), so the pieces a passkey library would supply are
here: unpadded base64url, a CBOR reader narrow enough to read an attestation object and a
COSE key, and P-256 ECDSA verification over plain integers. Nothing here signs, so the
integer arithmetic runs against a public key only and constant time does not apply.

Only ES256 (COSE alg -7, P-256 with SHA-256) is accepted. That is what an iPhone passkey
with Face ID produces, and every other algorithm is refused rather than half supported.

This module is pure: it takes the JSON the browser posted and returns a `Credential` or a
sign count. Storage, challenge issue and expiry, and the cookie all belong to the HTTP layer.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from base64 import urlsafe_b64decode, urlsafe_b64encode
from dataclasses import dataclass

P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5

ES256 = -7
COSE_EC2 = 2
COSE_P256 = 1

FLAG_UP = 0x01
FLAG_UV = 0x04
FLAG_AT = 0x40
FLAG_ED = 0x80


class PasskeyError(Exception):
    """Every refusal in this module. The message is written to be shown to the client: it says
    which check failed and never carries a key, a signature, or a challenge."""


@dataclass(frozen=True)
class Credential:
    id: bytes
    public_key: bytes
    sign_count: int
    transports: tuple[str, ...]
    label: str
    created_at: str


def b64url_encode(raw: bytes) -> str:
    return urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def b64url_decode(text: str) -> bytes:
    if not isinstance(text, str):
        raise PasskeyError("expected a base64url string")
    try:
        return urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except Exception:
        raise PasskeyError("a field is not valid base64url") from None


def cbor_decode(data: bytes, offset: int = 0) -> tuple[object, int]:
    """One CBOR item and the offset just past it. Definite lengths only.

    The offset comes back because the COSE key inside authenticator data has no length prefix
    of its own: the only way to know where it ends is to decode it and see.
    """
    if offset >= len(data):
        raise PasskeyError("CBOR data ended early")
    major, info = data[offset] >> 5, data[offset] & 0x1F
    offset += 1
    if info == 31:
        raise PasskeyError("CBOR indefinite lengths are refused here")
    if info < 24:
        value = info
    elif info < 28:
        width = 1 << (info - 24)
        if offset + width > len(data):
            raise PasskeyError("CBOR data ended early")
        value = int.from_bytes(data[offset:offset + width], "big")
        offset += width
    else:
        raise PasskeyError(f"CBOR additional information {info} is not understood")
    if major == 0:
        return value, offset
    if major == 1:
        return -1 - value, offset
    if major in (2, 3):
        if offset + value > len(data):
            raise PasskeyError("CBOR data ended early")
        chunk = data[offset:offset + value]
        offset += value
        if major == 2:
            return chunk, offset
        try:
            return chunk.decode("utf-8"), offset
        except UnicodeDecodeError:
            raise PasskeyError("CBOR text string is not valid UTF-8") from None
    if major == 4:
        items = []
        for _ in range(value):
            item, offset = cbor_decode(data, offset)
            items.append(item)
        return items, offset
    if major == 5:
        out: dict[object, object] = {}
        for _ in range(value):
            key, offset = cbor_decode(data, offset)
            item, offset = cbor_decode(data, offset)
            if isinstance(key, (bytes, list, dict)):
                raise PasskeyError("CBOR map keys must be integers or text here")
            out[key] = item
        return out, offset
    raise PasskeyError(f"CBOR major type {major} is not understood")


def _mod_inv(x: int) -> int:
    return pow(x, -1, P)


def _on_curve(point: tuple[int, int]) -> bool:
    x, y = point
    if not (0 <= x < P and 0 <= y < P):
        return False
    return (y * y - (x * x * x + A * x + B)) % P == 0


def _double(point: tuple[int, int] | None) -> tuple[int, int] | None:
    if point is None:
        return None
    x, y = point
    if y == 0:
        return None
    s = (3 * x * x + A) * _mod_inv(2 * y) % P
    nx = (s * s - 2 * x) % P
    return nx, (s * (x - nx) - y) % P


def _add(p1: tuple[int, int] | None, p2: tuple[int, int] | None) -> tuple[int, int] | None:
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    if p1[0] == p2[0]:
        return None if (p1[1] + p2[1]) % P == 0 else _double(p1)
    s = (p2[1] - p1[1]) * _mod_inv(p2[0] - p1[0]) % P
    nx = (s * s - p1[0] - p2[0]) % P
    return nx, (s * (p1[0] - nx) - p1[1]) % P


def point_mul(k: int, point: tuple[int, int] | None) -> tuple[int, int] | None:
    """Scalar multiplication by double and add. The key is public, so the early exit on a zero
    bit leaks nothing worth having."""
    result: tuple[int, int] | None = None
    addend = point
    while k:
        if k & 1:
            result = _add(result, addend)
        addend = _double(addend)
        k >>= 1
    return result


def parse_der_signature(der: bytes) -> tuple[int, int]:
    """(r, s) out of a DER SEQUENCE of two INTEGERs, strictly. A signature that re-encodes to
    anything but the bytes handed in is refused rather than normalized."""
    def integer(data: bytes, i: int) -> tuple[int, int]:
        if i + 2 > len(data) or data[i] != 0x02:
            raise PasskeyError("signature is not a DER integer where one is required")
        length = data[i + 1]
        if length == 0 or length > 0x7F or i + 2 + length > len(data):
            raise PasskeyError("signature has a bad DER integer length")
        raw = data[i + 2:i + 2 + length]
        if raw[0] & 0x80:
            raise PasskeyError("signature has a negative DER integer")
        if raw[0] == 0 and len(raw) > 1 and not raw[1] & 0x80:
            raise PasskeyError("signature has a non-minimal DER integer")
        return int.from_bytes(raw, "big"), i + 2 + length

    if len(der) < 2 or der[0] != 0x30:
        raise PasskeyError("signature is not a DER sequence")
    if der[1] > 0x7F or der[1] + 2 != len(der):
        raise PasskeyError("signature length does not match its DER header")
    r, i = integer(der, 2)
    s, i = integer(der, i)
    if i != len(der):
        raise PasskeyError("signature has trailing bytes after the DER sequence")
    return r, s


def es256_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """ECDSA over P-256 with SHA-256, against an uncompressed SEC1 point."""
    if len(public_key) != 65 or public_key[0] != 0x04:
        raise PasskeyError("public key is not an uncompressed P-256 point")
    q = (int.from_bytes(public_key[1:33], "big"), int.from_bytes(public_key[33:], "big"))
    if not _on_curve(q):
        raise PasskeyError("public key is not a point on P-256")
    r, s = parse_der_signature(signature)
    if not (1 <= r < N and 1 <= s < N):
        raise PasskeyError("signature r or s is out of range")
    e = int.from_bytes(hashlib.sha256(message).digest(), "big")
    w = pow(s, -1, N)
    point = _add(point_mul(e * w % N, (GX, GY)), point_mul(r * w % N, q))
    return point is not None and point[0] % N == r


@dataclass(frozen=True)
class AuthenticatorData:
    rp_id_hash: bytes
    flags: int
    sign_count: int
    credential_id: bytes = b""
    public_key: bytes = b""


def parse_authenticator_data(raw: bytes) -> AuthenticatorData:
    if len(raw) < 37:
        raise PasskeyError("authenticator data is too short")
    flags = raw[32]
    base = AuthenticatorData(raw[:32], flags, int.from_bytes(raw[33:37], "big"))
    if not flags & FLAG_AT:
        return base
    if len(raw) < 55:
        raise PasskeyError("authenticator data claims an attested credential but is too short")
    length = int.from_bytes(raw[53:55], "big")
    if len(raw) < 55 + length:
        raise PasskeyError("authenticator data credential id runs past the end")
    credential_id = raw[55:55 + length]
    cose, end = cbor_decode(raw, 55 + length)
    # Trailing bytes are extension output, which is legal only when the authenticator said it
    # sent some. Nothing here asks for an extension, so the bytes are skipped rather than read.
    if end != len(raw) and not flags & FLAG_ED:
        raise PasskeyError("authenticator data has trailing bytes after the public key")
    return AuthenticatorData(base.rp_id_hash, flags, base.sign_count, credential_id, cose_to_sec1(cose))


def cose_to_sec1(cose: object) -> bytes:
    """A COSE_Key map to 0x04 || X || Y, ES256 only."""
    if not isinstance(cose, dict):
        raise PasskeyError("the credential public key is not a COSE key")
    if cose.get(3) != ES256:
        raise PasskeyError(f"only ES256 passkeys are accepted here, this key is algorithm {cose.get(3)}")
    if cose.get(1) != COSE_EC2 or cose.get(-1) != COSE_P256:
        raise PasskeyError("only P-256 elliptic curve passkeys are accepted here")
    x, y = cose.get(-2), cose.get(-3)
    if not isinstance(x, bytes) or not isinstance(y, bytes) or len(x) != 32 or len(y) != 32:
        raise PasskeyError("the credential public key coordinates are malformed")
    key = b"\x04" + x + y
    if not _on_curve((int.from_bytes(x, "big"), int.from_bytes(y, "big"))):
        raise PasskeyError("the credential public key is not a point on P-256")
    return key


def registration_options(*, rp_id: str, rp_name: str, user_id: bytes, user_name: str,
                         challenge: bytes) -> dict:
    """The PublicKeyCredentialCreationOptions the browser is handed, as JSON.

    A resident key is required because the dashboard has no username field: the passkey has to
    be discoverable for the browser to offer it unprompted. User verification is required so
    Face ID is part of every ceremony rather than possession of the phone alone. Attestation is
    "none" because a single user vouching for their own phone gains nothing from a certificate
    chain this module would then have to validate."""
    return {
        "rp": {"id": rp_id, "name": rp_name},
        "user": {"id": b64url_encode(user_id), "name": user_name, "displayName": user_name},
        "challenge": b64url_encode(challenge),
        "pubKeyCredParams": [{"type": "public-key", "alg": ES256}],
        "authenticatorSelection": {"residentKey": "required", "userVerification": "required"},
        "attestation": "none",
    }


def authentication_options(*, rp_id: str, challenge: bytes, allow: list[bytes]) -> dict:
    options = {
        "rpId": rp_id,
        "challenge": b64url_encode(challenge),
        "userVerification": "required",
    }
    if allow:
        options["allowCredentials"] = [
            {"type": "public-key", "id": b64url_encode(cid)} for cid in allow
        ]
    return options


def _client_data(response: dict, *, kind: str, expected_challenge: bytes, origin: str) -> bytes:
    """The raw clientDataJSON, once its type, challenge and origin check out.

    The raw bytes are what comes back rather than the parsed object, because the signature is
    over the bytes the authenticator saw and re-serializing would not reproduce them."""
    inner = response.get("response")
    if not isinstance(inner, dict):
        raise PasskeyError("the credential response is missing its `response` object")
    raw = b64url_decode(inner.get("clientDataJSON", ""))
    try:
        client = json.loads(raw)
    except ValueError:
        raise PasskeyError("clientDataJSON is not valid JSON") from None
    if not isinstance(client, dict):
        raise PasskeyError("clientDataJSON is not a JSON object")
    if client.get("type") != kind:
        raise PasskeyError(f"expected a {kind} ceremony, got {client.get('type')!r}")
    if not hmac.compare_digest(b64url_decode(client.get("challenge", "")), expected_challenge):
        raise PasskeyError("the challenge does not match the one this server issued")
    if client.get("origin") != origin:
        raise PasskeyError(f"origin {client.get('origin')!r} is not {origin!r}")
    return raw


def _check_flags(auth: AuthenticatorData, rp_id: str) -> None:
    if not hmac.compare_digest(auth.rp_id_hash, hashlib.sha256(rp_id.encode("utf-8")).digest()):
        raise PasskeyError(f"the credential was not made for {rp_id}")
    if not auth.flags & FLAG_UP:
        raise PasskeyError("the authenticator did not report user presence")
    if not auth.flags & FLAG_UV:
        raise PasskeyError("the authenticator did not report user verification, so Face ID or a "
                           "passcode was not used")


def finish_registration(response: dict, *, expected_challenge: bytes, rp_id: str, origin: str,
                        label: str, now: str) -> Credential:
    _client_data(response, kind="webauthn.create", expected_challenge=expected_challenge, origin=origin)
    inner = response["response"]
    attestation, _ = cbor_decode(b64url_decode(inner.get("attestationObject", "")))
    if not isinstance(attestation, dict):
        raise PasskeyError("the attestation object is not a CBOR map")
    if attestation.get("fmt") != "none":
        raise PasskeyError(f"attestation format {attestation.get('fmt')!r} is refused here, "
                           "this server asked for none")
    if not isinstance(attestation.get("authData"), bytes):
        raise PasskeyError("the attestation object has no authenticator data")
    auth = parse_authenticator_data(attestation["authData"])
    _check_flags(auth, rp_id)
    if not auth.flags & FLAG_AT:
        raise PasskeyError("the authenticator returned no attested credential data")
    raw_id = b64url_decode(response.get("rawId", response.get("id", "")))
    if not hmac.compare_digest(raw_id, auth.credential_id):
        raise PasskeyError("the credential id does not match the one inside the authenticator data")
    transports = inner.get("transports") or ()
    return Credential(
        id=auth.credential_id,
        public_key=auth.public_key,
        sign_count=auth.sign_count,
        transports=tuple(str(t) for t in transports),
        label=label,
        created_at=now,
    )


def finish_authentication(response: dict, credential: Credential, *, expected_challenge: bytes,
                          rp_id: str, origin: str) -> int:
    """The new sign count, once the assertion verifies. The caller stores it.

    A sign count of zero means the authenticator does not keep one, which is the normal case
    for a platform passkey synced across devices. When it does keep one, a count that failed to
    advance is a replay or a cloned key, so it is refused."""
    client_data = _client_data(response, kind="webauthn.get",
                               expected_challenge=expected_challenge, origin=origin)
    inner = response["response"]
    raw_id = b64url_decode(response.get("rawId", response.get("id", "")))
    if not hmac.compare_digest(raw_id, credential.id):
        raise PasskeyError("this assertion is for a credential this server does not know")
    auth_data = b64url_decode(inner.get("authenticatorData", ""))
    auth = parse_authenticator_data(auth_data)
    _check_flags(auth, rp_id)
    signature = b64url_decode(inner.get("signature", ""))
    if not es256_verify(credential.public_key, auth_data + hashlib.sha256(client_data).digest(), signature):
        raise PasskeyError("the assertion signature does not verify")
    if auth.sign_count and auth.sign_count <= credential.sign_count:
        raise PasskeyError("the authenticator sign count did not advance, so this assertion is a "
                           "replay or the key has been cloned")
    return auth.sign_count
