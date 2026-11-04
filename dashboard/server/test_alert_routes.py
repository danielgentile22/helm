"""The alert and push routes of ADR 0039, through `dispatch`, against a temp state folder.
The sender is replaced, so nothing here runs node or reaches a push service.

    python3 -m unittest dashboard/server/test_alert_routes.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import app  # noqa: E402
import routes  # noqa: E402
import alerts  # noqa: E402  after routes, which puts the runner on the path
import common  # noqa: E402
import push  # noqa: E402

TAILNET_HOST = "helm.example.ts.net:8643"
NOW = datetime(2026, 11, 4, 9, 0, tzinfo=timezone.utc)
SUBSCRIPTION = {"endpoint": "https://web.push.apple.com/QGx1", "keys": {"p256dh": "BOr", "auth": "k9"}}


def call(method: str, path: str, body: object = None, door: app.Via = "loopback", session: bool = False) -> app.Response:
    host = TAILNET_HOST if door == "tailnet" else "127.0.0.1:8642"
    headers = {"host": host, "origin": ("https://" if door == "tailnet" else "http://") + host}
    request = app.Request(method=method, path=path, headers=headers, peer="127.0.0.1", port=8642, door=door,
                          body=b"" if body is None else json.dumps(body).encode())
    tailnet = app.Tailnet(TAILNET_HOST, lambda r: session)
    try:
        return app.dispatch(request, routes.ROUTES, tailnet)
    except app.ApiError as e:
        return e.response()


def answer(response: app.Response) -> dict:
    return json.loads(response.body)


class AlertRouteTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(setattr, common, "STATE", common.STATE)
        common.STATE = Path(tmp.name)
        self.sent: list[tuple[str, str, int]] = []
        self.addCleanup(setattr, push, "send", push.send)
        push.send = lambda title, tab, count: self.sent.append((title, tab, count)) or {"sent": 1, "removed": 0, "failed": 0}
        alerts.write({
            "routine:backup": alerts.Alert("routine:backup", "background", "backup failed: volume absent",
                                           "2026-11-04T08:00:00Z", "volume absent"),
            "ci:keel#12": alerts.Alert("ci:keel#12", "projects", "CI fails on keel#12", "2026-11-04T08:30:00Z", "fail"),
            "quiet:capture": alerts.Alert("quiet:capture", "background", "capture has gone quiet",
                                          "2026-11-03T08:00:00Z", "quiet", closed="2026-11-03T09:00:00Z"),
        })

    def test_the_list_holds_open_undismissed_alerts_and_counts_per_tab(self) -> None:
        body = answer(call("GET", "/api/alerts"))
        self.assertEqual([a["key"] for a in body["alerts"]], ["ci:keel#12", "routine:backup"])
        self.assertEqual(body["counts"], {"projects": 1, "ideas": 0, "background": 1, "devices": 0})
        self.assertEqual(body["total"], 2)

    def test_dismiss_hides_an_alert_once_and_an_unknown_key_is_404(self) -> None:
        out = call("POST", "/api/alerts/ci:keel#12/dismiss")
        self.assertEqual(out.status, 200, out.body)
        self.assertTrue(answer(out)["changed"])
        self.assertFalse(answer(call("POST", "/api/alerts/ci:keel#12/dismiss"))["changed"])
        self.assertEqual(answer(call("GET", "/api/alerts"))["total"], 1)
        for key in ("routine:nothing", "nonsense", "idea:..%2F..%2Fx"):
            with self.subTest(key=key):
                self.assertEqual(call("POST", f"/api/alerts/{key}/dismiss").status, 404)

    def test_over_the_tailnet_every_alert_and_push_row_needs_a_session(self) -> None:
        for method, path in (("GET", "/api/alerts"), ("POST", "/api/alerts/routine:backup/dismiss"),
                             ("GET", "/api/push/key"), ("POST", "/api/push/subscribe"),
                             ("POST", "/api/push/unsubscribe")):
            with self.subTest(path=path):
                self.assertEqual(call(method, path, {}, door="tailnet").status, 401)
        self.assertEqual(call("GET", "/api/alerts", door="tailnet", session=True).status, 200)

    def test_the_test_push_is_loopback_only_and_sends_the_fixed_title(self) -> None:
        self.assertEqual(call("POST", "/api/push/test", door="tailnet", session=True).status, 403)
        self.assertEqual(self.sent, [])
        out = call("POST", "/api/push/test")
        self.assertEqual(out.status, 200, out.body)
        self.assertEqual(self.sent, [("Test notification from helm", "background", 2)])

    def test_subscribe_is_idempotent_and_unsubscribe_removes_it(self) -> None:
        self.assertTrue(answer(call("POST", "/api/push/subscribe", SUBSCRIPTION))["changed"])
        self.assertFalse(answer(call("POST", "/api/push/subscribe", SUBSCRIPTION))["changed"])
        stored = push.subscriptions()
        self.assertEqual([(s["endpoint"], s["keys"]) for s in stored], [(SUBSCRIPTION["endpoint"], SUBSCRIPTION["keys"])])
        self.assertEqual((push.subscriptions_file().stat().st_mode & 0o777), 0o600)
        self.assertTrue(answer(call("POST", "/api/push/unsubscribe", {"endpoint": SUBSCRIPTION["endpoint"]}))["changed"])
        self.assertEqual(push.subscriptions(), [])

    def test_a_subscription_without_an_https_endpoint_or_its_keys_is_400(self) -> None:
        for body in ({}, {"endpoint": "http://web.push.apple.com/x", "keys": SUBSCRIPTION["keys"]},
                     {"endpoint": SUBSCRIPTION["endpoint"]}, {"endpoint": SUBSCRIPTION["endpoint"], "keys": {"auth": "k"}}):
            with self.subTest(body=body):
                self.assertEqual(call("POST", "/api/push/subscribe", body).status, 400)

    def test_the_public_key_is_read_from_the_vapid_file(self) -> None:
        (common.STATE / "push").mkdir(parents=True, exist_ok=True)
        (common.STATE / "push" / "vapid.json").write_text(json.dumps({"publicKey": "BPub", "privateKey": "secret"}))
        body = answer(call("GET", "/api/push/key"))
        self.assertEqual(body, {"key": "BPub"})


if __name__ == "__main__":
    unittest.main()
