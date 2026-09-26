"""Passkey tests. Nothing here opens a socket or stores anything: `passkey` is pure.

There is no authenticator to borrow, so this file is one. It signs with the curve arithmetic
the module already exposes, encodes CBOR (the module only decodes), and assembles authenticator
data and clientDataJSON byte for byte the way an iPhone would. That makes the round trip a real
signature check rather than a recorded fixture, and lets each refusal be provoked by changing
one field of a ceremony that otherwise passes.

    python3 -m unittest dashboard/server/test_passkey.py
"""
from __future__ import annotations

import hashlib
import hmac
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE)]

import passkey  # noqa: E402

RP_ID = "helm.example.ts.net"
ORIGIN = f"https://{RP_ID}"


def cbor(value: object) -> bytes:
    """Just enough CBOR to build an attestation object: ints, bytes, text, and maps."""
    def head(major: int, n: int) -> bytes:
        if n < 24:
            return bytes([major << 5 | n])
        for info, width in ((24, 1), (25, 2), (26, 4), (27, 8)):
            if n < 1 << (8 * width):
                return bytes([major << 5 | info]) + n.to_bytes(width, "big")
        raise ValueError(n)

    if isinstance(value, bool):
        raise ValueError("booleans are not encoded here")
    if isinstance(value, int):
        return head(0, value) if value >= 0 else head(1, -1 - value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        return head(3, len(value.encode())) + value.encode()
    if isinstance(value, list):
        return head(4, len(value)) + b"".join(cbor(v) for v in value)
    if isinstance(value, dict):
        return head(5, len(value)) + b"".join(cbor(k) + cbor(v) for k, v in value.items())
    raise ValueError(type(value))


def der_int(x: int) -> bytes:
    raw = x.to_bytes((x.bit_length() + 8) // 8 or 1, "big")
    return bytes([0x02, len(raw)]) + raw


def sign(private: int, message: bytes) -> bytes:
    """ECDSA over P-256 with SHA-256, DER encoded. The nonce is derived from the key and the
    message so a failure here is reproducible."""
    n = passkey.N
    e = int.from_bytes(hashlib.sha256(message).digest(), "big")
    counter = 0
    while True:
        seed = private.to_bytes(32, "big") + message + counter.to_bytes(4, "big")
        k = int.from_bytes(hmac.new(b"test nonce", seed, hashlib.sha256).digest(), "big") % n
        counter += 1
        if k == 0:
            continue
        point = passkey.point_mul(k, (passkey.GX, passkey.GY))
        r = point[0] % n
        s = pow(k, -1, n) * (e + r * private) % n
        if r and s:
            body = der_int(r) + der_int(s)
            return bytes([0x30, len(body)]) + body


PRIVATE = 0x5A1E7B33C0FFEE00DEADBEEF1234567890ABCDEF0011223344556677889900AA
PUBLIC_POINT = passkey.point_mul(PRIVATE, (passkey.GX, passkey.GY))
PUBLIC_KEY = b"\x04" + PUBLIC_POINT[0].to_bytes(32, "big") + PUBLIC_POINT[1].to_bytes(32, "big")
CRED_ID = bytes(range(32))


def cose_key(alg: int = passkey.ES256) -> bytes:
    return cbor({1: 2, 3: alg, -1: 1, -2: PUBLIC_KEY[1:33], -3: PUBLIC_KEY[33:]})


def auth_data(*, rp_id: str = RP_ID, flags: int = 0x45, sign_count: int = 0,
              attested: bytes | None = None) -> bytes:
    raw = hashlib.sha256(rp_id.encode()).digest() + bytes([flags]) + sign_count.to_bytes(4, "big")
    if attested is not None:
        raw += bytes(16) + len(CRED_ID).to_bytes(2, "big") + CRED_ID + attested
    return raw


def client_data(kind: str, challenge: bytes, origin: str = ORIGIN) -> bytes:
    return json.dumps({"type": kind, "challenge": passkey.b64url_encode(challenge),
                       "origin": origin, "crossOrigin": False}).encode()


def registration(challenge: bytes, *, fmt: str = "none", flags: int = 0x45,
                 alg: int = passkey.ES256, origin: str = ORIGIN, rp_id: str = RP_ID) -> dict:
    data = auth_data(rp_id=rp_id, flags=flags, attested=cose_key(alg))
    attestation = cbor({"fmt": fmt, "attStmt": {}, "authData": data})
    return {
        "id": passkey.b64url_encode(CRED_ID),
        "rawId": passkey.b64url_encode(CRED_ID),
        "type": "public-key",
        "response": {
            "clientDataJSON": passkey.b64url_encode(client_data("webauthn.create", challenge, origin)),
            "attestationObject": passkey.b64url_encode(attestation),
            "transports": ["internal", "hybrid"],
        },
    }


def assertion(challenge: bytes, *, flags: int = 0x05, sign_count: int = 0, origin: str = ORIGIN,
              rp_id: str = RP_ID, tamper: bool = False) -> dict:
    data = auth_data(rp_id=rp_id, flags=flags, sign_count=sign_count)
    client = client_data("webauthn.get", challenge, origin)
    signature = bytearray(sign(PRIVATE, data + hashlib.sha256(client).digest()))
    if tamper:
        signature[-1] ^= 0x01
    return {
        "id": passkey.b64url_encode(CRED_ID),
        "rawId": passkey.b64url_encode(CRED_ID),
        "type": "public-key",
        "response": {
            "clientDataJSON": passkey.b64url_encode(client),
            "authenticatorData": passkey.b64url_encode(data),
            "signature": passkey.b64url_encode(bytes(signature)),
        },
    }


class EcdsaTest(unittest.TestCase):
    """RFC 6979 appendix A.2.5, the P-256 key with SHA-256 over the message "sample"."""

    KEY = (0x60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6,
           0x7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299)
    R = 0xEFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716
    S = 0xF7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8

    def setUp(self) -> None:
        self.public = b"\x04" + self.KEY[0].to_bytes(32, "big") + self.KEY[1].to_bytes(32, "big")
        body = der_int(self.R) + der_int(self.S)
        self.signature = bytes([0x30, len(body)]) + body

    def test_known_answer(self) -> None:
        self.assertTrue(passkey.es256_verify(self.public, b"sample", self.signature))

    def test_flipped_bit_fails(self) -> None:
        self.assertFalse(passkey.es256_verify(self.public, b"sampld", self.signature))

    def test_private_key_derives_the_published_public_key(self) -> None:
        d = 0xC9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721
        self.assertEqual(passkey.point_mul(d, (passkey.GX, passkey.GY)), self.KEY)

    def test_signature_off_a_point_not_on_the_curve_is_refused(self) -> None:
        bad = b"\x04" + b"\x01" * 64
        with self.assertRaises(passkey.PasskeyError):
            passkey.es256_verify(bad, b"sample", self.signature)

    def test_der_must_be_minimal(self) -> None:
        body = b"\x02\x02\x00\x01" + der_int(self.S)
        with self.assertRaises(passkey.PasskeyError):
            passkey.parse_der_signature(bytes([0x30, len(body)]) + body)

    def test_der_trailing_bytes_refused(self) -> None:
        body = der_int(self.R) + der_int(self.S)
        with self.assertRaises(passkey.PasskeyError):
            passkey.parse_der_signature(bytes([0x30, len(body)]) + body + b"\x00")


class OptionsTest(unittest.TestCase):
    def test_registration_options(self) -> None:
        options = passkey.registration_options(rp_id=RP_ID, rp_name="helm", user_id=b"daniel",
                                               user_name="daniel", challenge=b"\x00\x01\x02")
        self.assertEqual(options["pubKeyCredParams"], [{"type": "public-key", "alg": -7}])
        self.assertEqual(options["authenticatorSelection"],
                         {"residentKey": "required", "userVerification": "required"})
        self.assertEqual(options["attestation"], "none")
        self.assertEqual(passkey.b64url_decode(options["challenge"]), b"\x00\x01\x02")
        self.assertEqual(passkey.b64url_decode(options["user"]["id"]), b"daniel")
        json.dumps(options)

    def test_authentication_options_omit_empty_allow_list(self) -> None:
        options = passkey.authentication_options(rp_id=RP_ID, challenge=b"abc", allow=[])
        self.assertNotIn("allowCredentials", options)
        self.assertEqual(options["userVerification"], "required")

    def test_authentication_options_list_credentials(self) -> None:
        options = passkey.authentication_options(rp_id=RP_ID, challenge=b"abc", allow=[CRED_ID])
        self.assertEqual(options["allowCredentials"],
                         [{"type": "public-key", "id": passkey.b64url_encode(CRED_ID)}])


class RoundTripTest(unittest.TestCase):
    CHALLENGE = b"\x11" * 32

    def register(self, **kwargs) -> passkey.Credential:
        return passkey.finish_registration(
            registration(self.CHALLENGE, **kwargs), expected_challenge=self.CHALLENGE,
            rp_id=RP_ID, origin=ORIGIN, label="iPhone", now="2026-09-23T12:00:00Z")

    def test_registration_then_authentication(self) -> None:
        credential = self.register()
        self.assertEqual(credential.id, CRED_ID)
        self.assertEqual(credential.public_key, PUBLIC_KEY)
        self.assertEqual(credential.transports, ("internal", "hybrid"))
        self.assertEqual(credential.label, "iPhone")
        self.assertEqual(credential.created_at, "2026-09-23T12:00:00Z")
        count = passkey.finish_authentication(assertion(b"\x22" * 32), credential,
                                              expected_challenge=b"\x22" * 32, rp_id=RP_ID,
                                              origin=ORIGIN)
        self.assertEqual(count, 0)

    def test_registration_wrong_origin(self) -> None:
        with self.assertRaisesRegex(passkey.PasskeyError, "origin"):
            self.register(origin="https://evil.example")

    def test_registration_wrong_challenge(self) -> None:
        with self.assertRaisesRegex(passkey.PasskeyError, "challenge"):
            passkey.finish_registration(registration(b"\xff" * 32), expected_challenge=self.CHALLENGE,
                                        rp_id=RP_ID, origin=ORIGIN, label="iPhone", now="now")

    def test_registration_wrong_rp_id(self) -> None:
        with self.assertRaisesRegex(passkey.PasskeyError, "was not made for"):
            self.register(rp_id="other.example")

    def test_registration_without_user_verification(self) -> None:
        with self.assertRaisesRegex(passkey.PasskeyError, "user verification"):
            self.register(flags=0x41)

    def test_registration_without_attested_credential_data(self) -> None:
        data = auth_data(flags=0x05)
        attestation = cbor({"fmt": "none", "attStmt": {}, "authData": data})
        response = registration(self.CHALLENGE)
        response["response"]["attestationObject"] = passkey.b64url_encode(attestation)
        with self.assertRaises(passkey.PasskeyError):
            passkey.finish_registration(response, expected_challenge=self.CHALLENGE, rp_id=RP_ID,
                                        origin=ORIGIN, label="iPhone", now="now")

    def test_registration_accepts_extension_output(self) -> None:
        data = auth_data(flags=0xC5, attested=cose_key()) + cbor({"credProtect": 3})
        attestation = cbor({"fmt": "none", "attStmt": {}, "authData": data})
        response = registration(self.CHALLENGE)
        response["response"]["attestationObject"] = passkey.b64url_encode(attestation)
        credential = passkey.finish_registration(response, expected_challenge=self.CHALLENGE,
                                                 rp_id=RP_ID, origin=ORIGIN, label="iPhone",
                                                 now="now")
        self.assertEqual(credential.public_key, PUBLIC_KEY)

    def test_registration_rejects_trailing_bytes_without_the_extension_flag(self) -> None:
        data = auth_data(attested=cose_key()) + b"\x00"
        attestation = cbor({"fmt": "none", "attStmt": {}, "authData": data})
        response = registration(self.CHALLENGE)
        response["response"]["attestationObject"] = passkey.b64url_encode(attestation)
        with self.assertRaisesRegex(passkey.PasskeyError, "trailing"):
            passkey.finish_registration(response, expected_challenge=self.CHALLENGE, rp_id=RP_ID,
                                        origin=ORIGIN, label="iPhone", now="now")

    def test_registration_non_es256_key(self) -> None:
        with self.assertRaisesRegex(passkey.PasskeyError, "only ES256"):
            self.register(alg=-257)

    def test_registration_packed_attestation_refused(self) -> None:
        with self.assertRaisesRegex(passkey.PasskeyError, "attestation format"):
            self.register(fmt="packed")

    def test_registration_wrong_ceremony_type(self) -> None:
        response = registration(self.CHALLENGE)
        response["response"]["clientDataJSON"] = passkey.b64url_encode(
            client_data("webauthn.get", self.CHALLENGE))
        with self.assertRaisesRegex(passkey.PasskeyError, "webauthn.create"):
            passkey.finish_registration(response, expected_challenge=self.CHALLENGE, rp_id=RP_ID,
                                        origin=ORIGIN, label="iPhone", now="now")

    def test_authentication_wrong_origin(self) -> None:
        credential = self.register()
        with self.assertRaisesRegex(passkey.PasskeyError, "origin"):
            passkey.finish_authentication(assertion(b"\x22" * 32, origin="https://evil.example"),
                                          credential, expected_challenge=b"\x22" * 32,
                                          rp_id=RP_ID, origin=ORIGIN)

    def test_authentication_wrong_challenge(self) -> None:
        credential = self.register()
        with self.assertRaisesRegex(passkey.PasskeyError, "challenge"):
            passkey.finish_authentication(assertion(b"\x33" * 32), credential,
                                          expected_challenge=b"\x22" * 32, rp_id=RP_ID, origin=ORIGIN)

    def test_authentication_wrong_rp_id(self) -> None:
        credential = self.register()
        with self.assertRaisesRegex(passkey.PasskeyError, "was not made for"):
            passkey.finish_authentication(assertion(b"\x22" * 32, rp_id="other.example"),
                                          credential, expected_challenge=b"\x22" * 32,
                                          rp_id=RP_ID, origin=ORIGIN)

    def test_authentication_without_user_verification(self) -> None:
        credential = self.register()
        with self.assertRaisesRegex(passkey.PasskeyError, "user verification"):
            passkey.finish_authentication(assertion(b"\x22" * 32, flags=0x01), credential,
                                          expected_challenge=b"\x22" * 32, rp_id=RP_ID, origin=ORIGIN)

    def test_authentication_tampered_signature(self) -> None:
        credential = self.register()
        with self.assertRaises(passkey.PasskeyError):
            passkey.finish_authentication(assertion(b"\x22" * 32, tamper=True), credential,
                                          expected_challenge=b"\x22" * 32, rp_id=RP_ID, origin=ORIGIN)

    def test_authentication_unknown_credential_id(self) -> None:
        credential = self.register()
        other = passkey.Credential(b"\x99" * 32, credential.public_key, 0, (), "other", "now")
        with self.assertRaisesRegex(passkey.PasskeyError, "does not know"):
            passkey.finish_authentication(assertion(b"\x22" * 32), other,
                                          expected_challenge=b"\x22" * 32, rp_id=RP_ID, origin=ORIGIN)

    def test_sign_count_advances(self) -> None:
        credential = self.register()
        count = passkey.finish_authentication(assertion(b"\x22" * 32, sign_count=7), credential,
                                              expected_challenge=b"\x22" * 32, rp_id=RP_ID,
                                              origin=ORIGIN)
        self.assertEqual(count, 7)

    def test_replayed_sign_count(self) -> None:
        base = self.register()
        credential = passkey.Credential(base.id, base.public_key, 7, base.transports, base.label,
                                        base.created_at)
        with self.assertRaisesRegex(passkey.PasskeyError, "replay"):
            passkey.finish_authentication(assertion(b"\x22" * 32, sign_count=7), credential,
                                          expected_challenge=b"\x22" * 32, rp_id=RP_ID, origin=ORIGIN)


class Base64UrlTest(unittest.TestCase):
    def test_round_trip_every_length(self) -> None:
        for n in range(0, 8):
            raw = bytes(range(248, 248 + n))
            self.assertEqual(passkey.b64url_decode(passkey.b64url_encode(raw)), raw)

    def test_unpadded_and_url_safe(self) -> None:
        self.assertEqual(passkey.b64url_encode(b"\xfb\xff"), "-_8")
        self.assertEqual(passkey.b64url_decode("-_8"), b"\xfb\xff")

    def test_non_string_refused(self) -> None:
        with self.assertRaises(passkey.PasskeyError):
            passkey.b64url_decode(None)

    def test_garbage_refused(self) -> None:
        with self.assertRaises(passkey.PasskeyError):
            passkey.b64url_decode("a")


class CborTest(unittest.TestCase):
    def test_round_trip(self) -> None:
        for value in (0, 23, 24, 255, 256, 65536, 4294967296, -1, -24, -1000,
                      b"", b"\x00" * 300, "hello", ["a", 1], {1: 2, "x": b"y"}):
            self.assertEqual(passkey.cbor_decode(cbor(value))[0], value)

    def test_offset_reports_bytes_consumed(self) -> None:
        data = cbor({1: 2}) + b"trailing"
        self.assertEqual(passkey.cbor_decode(data), ({1: 2}, len(cbor({1: 2}))))

    def test_indefinite_length_refused(self) -> None:
        with self.assertRaisesRegex(passkey.PasskeyError, "indefinite"):
            passkey.cbor_decode(b"\x5f\x41\x00\xff")

    def test_truncated_refused(self) -> None:
        for data in (b"", b"\x18", b"\x43\x00", b"\x82\x01", b"\xa1\x01"):
            with self.assertRaises(passkey.PasskeyError):
                passkey.cbor_decode(data)

    def test_float_refused(self) -> None:
        with self.assertRaises(passkey.PasskeyError):
            passkey.cbor_decode(b"\xfa\x00\x00\x00\x00")

    def test_tag_refused(self) -> None:
        with self.assertRaises(passkey.PasskeyError):
            passkey.cbor_decode(b"\xc0\x01")

    def test_reserved_additional_information_refused(self) -> None:
        with self.assertRaises(passkey.PasskeyError):
            passkey.cbor_decode(b"\x1c")

    def test_byte_string_map_key_refused(self) -> None:
        with self.assertRaises(passkey.PasskeyError):
            passkey.cbor_decode(b"\xa1\x41\x00\x01")


if __name__ == "__main__":
    unittest.main()
