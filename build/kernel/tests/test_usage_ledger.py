"""用量账本测试：token 提取、日/月/年聚合、积分采样差分、持久化与容错。

用 unittest（venv 里没有 pytest），与既有内核测试风格一致。
"""
import json
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

import admin.server as admin_server
from admin.usage import CN, UsageLedger, extract_usage

ADMIN = "admin-test-credential-long-enough"
API = "client-existing-key"


def credential(uid="one", name="测试账号"):
    return {"account": {"uid": uid, "nickname": name, "enterpriseId": "test"},
            "auth": {"accessToken": "private-access-token", "refreshToken": "private-refresh-token",
                     "expiresAt": int(time.time() * 1000) + 3600000}}


class FixedClock:
    def __init__(self, start=None):
        self.now = start if start is not None else 1790000000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class ExtractUsageTests(unittest.TestCase):
    def test_chat_chunk(self):
        value = {"choices": [{"finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}
        self.assertEqual(extract_usage(value), (100, 20, 120))

    def test_responses_completed_event(self):
        value = {"type": "response.completed",
                 "response": {"usage": {"input_tokens": 50, "output_tokens": 7, "total_tokens": 57}}}
        self.assertEqual(extract_usage(value), (50, 7, 57))

    def test_responses_partial_usage_pads_total(self):
        value = {"response": {"usage": {"input_tokens": 50, "output_tokens": 5}}}
        self.assertEqual(extract_usage(value), (50, 5, 55))

    def test_anthropic_message_delta(self):
        value = {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
                 "usage": {"input_tokens": 30, "output_tokens": 9}}
        self.assertEqual(extract_usage(value), (30, 9, 39))

    def test_anthropic_message_start_is_zero_placeholder(self):
        value = {"type": "message_start",
                 "message": {"usage": {"input_tokens": 0, "output_tokens": 0}}}
        # message 在 message 字段里，不在 usage 顶层 → 不误取
        self.assertIsNone(extract_usage(value))

    def test_no_usage(self):
        self.assertIsNone(extract_usage({"delta": "text"}))
        self.assertIsNone(extract_usage({"usage": {"foo": 1}}))
        self.assertIsNone(extract_usage("not a dict"))
        self.assertIsNone(extract_usage({"usage": "broken"}))

    def test_negative_and_garbage_are_clamped(self):
        self.assertEqual(extract_usage({"usage": {"prompt_tokens": -5, "completion_tokens": None}}), (0, 0, 0))
        self.assertEqual(extract_usage({"usage": {"prompt_tokens": "12x", "total_tokens": "abc"}}), (0, 0, 0))


class LedgerTokenTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.clock = FixedClock()
        self.ledger = UsageLedger(self.root, clock=self.clock)

    def tearDown(self):
        self.temp.cleanup()

    def test_tokens_accumulate_into_today(self):
        self.ledger.record_tokens("api", 100, 20, 120, account="a1", model="glm-5.2")
        self.ledger.record_tokens("api", 50, 10, 60, account="a1", model="glm-5.2")
        self.ledger.record_tokens("test", 5, 1, 6, account="a1", model="glm-5.2")
        snap = self.ledger.snapshot("day")
        today = snap["buckets"][-1]
        self.assertEqual(today["api_requests"], 2)
        self.assertEqual(today["test_requests"], 1)
        self.assertEqual(today["prompt_tokens"], 155)
        self.assertEqual(today["completion_tokens"], 31)
        self.assertEqual(today["total_tokens"], 186)
        self.assertEqual(today["unmetered"], 0)
        self.assertEqual(snap["totals"]["total_tokens"], 186)
        self.assertEqual(snap["models"][0]["model"], "glm-5.2")
        self.assertEqual(snap["accounts"][0]["total_tokens"], 186)

    def test_missing_usage_still_counts_request(self):
        self.ledger.record_tokens("api", None, None, None, account="a1", model="m")
        today = self.ledger.snapshot("day")["buckets"][-1]
        self.assertEqual(today["api_requests"], 1)
        self.assertEqual(today["unmetered"], 1)
        self.assertEqual(today["total_tokens"], 0)

    def test_day_buckets_use_beijing_time(self):
        # 2026-09-27 15:59:59 UTC = 2026-09-27 23:59:59 +08:00
        base = datetime(2026, 9, 27, 15, 59, 59, tzinfo=timezone.utc).timestamp()
        # 时钟要对齐到被测日期附近，否则那些天不在「最近 30 天」窗口里。
        self.clock.now = base + 60
        self.ledger.record_tokens("api", 1, 1, 2, at=base)
        self.ledger.record_tokens("api", 1, 1, 2, at=base + 2)  # 已跨到 09-28（北京时间）
        keys = {b["key"]: b["total_tokens"] for b in self.ledger.snapshot("day")["buckets"] if b["total_tokens"]}
        self.assertEqual(keys, {"2026-09-27": 2, "2026-09-28": 2})

    def test_missing_buckets_are_zero_filled(self):
        snap = self.ledger.snapshot("day")
        self.assertEqual(len(snap["buckets"]), 30)
        self.assertEqual(sum(b["total_tokens"] for b in snap["buckets"]), 0)
        self.assertEqual(len(self.ledger.snapshot("month")["buckets"]), 12)
        self.assertEqual(len(self.ledger.snapshot("year")["buckets"]), 5)

    def test_month_and_year_aggregate_across_days(self):
        base = datetime(2026, 9, 10, 12, 0, 0, tzinfo=CN).timestamp()
        day = 86400
        # 时钟落在最后一个数据点之后，确保 9 月与 10 月都落在展示窗口内
        self.clock.now = base + 41 * day
        for offset in range(3):
            self.ledger.record_tokens("api", 10, 5, 15, at=base + offset * day)
        self.ledger.record_tokens("api", 7, 3, 10, at=base + 40 * day)  # 进入 10 月
        months = {b["key"]: b["total_tokens"] for b in self.ledger.snapshot("month")["buckets"]}
        self.assertEqual(months["2026-09"], 45)
        self.assertEqual(months["2026-10"], 10)
        years = {b["key"]: b["total_tokens"] for b in self.ledger.snapshot("year")["buckets"]}
        self.assertEqual(years["2026"], 55)

    def test_invalid_period_rejected(self):
        with self.assertRaises(ValueError):
            self.ledger.snapshot("week")


class LedgerCreditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.clock = FixedClock()
        self.ledger = UsageLedger(self.root, clock=self.clock)

    def tearDown(self):
        self.temp.cleanup()

    def test_first_sample_only_sets_baseline(self):
        self.ledger.record_credit_sample("a1", 1000.0)
        today = self.ledger.snapshot("day")["buckets"][-1]
        self.assertEqual(today["credits_used"], 0.0)
        self.assertEqual(today["credits_granted"], 0.0)

    def test_balance_drop_is_consumption(self):
        self.ledger.record_credit_sample("a1", 1000.0)
        self.ledger.record_credit_sample("a1", 870.5)
        today = self.ledger.snapshot("day")["buckets"][-1]
        self.assertAlmostEqual(today["credits_used"], 129.5, places=6)
        self.assertEqual(today["credits_granted"], 0.0)

    def test_balance_rise_is_grant_not_negative_usage(self):
        self.ledger.record_credit_sample("a1", 100.0)
        self.ledger.record_credit_sample("a1", 600.0)  # 签到赠包
        today = self.ledger.snapshot("day")["buckets"][-1]
        self.assertEqual(today["credits_used"], 0.0)
        self.assertAlmostEqual(today["credits_granted"], 500.0, places=6)

    def test_consumption_lands_in_sampling_day(self):
        self.ledger.record_credit_sample("a1", 1000.0)
        self.clock.advance(86400)
        self.ledger.record_credit_sample("a1", 900.0)
        buckets = {b["key"]: b["credits_used"] for b in self.ledger.snapshot("day")["buckets"]}
        self.assertEqual(len([v for v in buckets.values() if v]), 1)
        self.assertAlmostEqual(max(buckets.values()), 100.0, places=6)

    def test_per_account_baselines_are_independent(self):
        self.ledger.record_credit_sample("a1", 100.0)
        self.ledger.record_credit_sample("a2", 200.0)
        self.ledger.record_credit_sample("a1", 90.0)
        self.ledger.record_credit_sample("a2", 150.0)
        today = self.ledger.snapshot("day")["buckets"][-1]
        self.assertAlmostEqual(today["credits_used"], 60.0, places=6)

    def test_none_balance_is_ignored(self):
        self.ledger.record_credit_sample("a1", None)
        self.assertEqual(self.ledger.snapshot("day")["balances"], [])


class LedgerPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.clock = FixedClock()

    def tearDown(self):
        self.temp.cleanup()

    def test_round_trip_survives_restart(self):
        first = UsageLedger(self.root, clock=self.clock)
        first.record_tokens("api", 100, 20, 120, account="a1", model="glm-5.2")
        first.record_credit_sample("a1", 1000.0)
        first.record_credit_sample("a1", 800.0)
        self.assertTrue(first.flush(force=True))

        second = UsageLedger(self.root, clock=self.clock)
        snap = second.snapshot("day")
        self.assertEqual(snap["totals"]["total_tokens"], 120)
        self.assertAlmostEqual(snap["totals"]["credits_used"], 200.0, places=6)
        # 基线也要保留，否则重启后第一次采样会被当成基线、丢掉这段消耗
        second.record_credit_sample("a1", 700.0)
        self.assertAlmostEqual(second.snapshot("day")["totals"]["credits_used"], 300.0, places=6)

    def test_flush_is_throttled_then_forced(self):
        ledger = UsageLedger(self.root, clock=self.clock)
        ledger.record_tokens("api", 1, 1, 2)
        self.assertTrue(ledger.flush())          # 首次立即写
        ledger.record_tokens("api", 1, 1, 2)
        self.assertFalse(ledger.flush())         # 节流窗口内不写
        self.assertTrue(ledger.flush(force=True))
        self.assertEqual(UsageLedger(self.root, clock=self.clock).snapshot("day")["totals"]["total_tokens"], 4)

    def test_nothing_dirty_means_no_write(self):
        ledger = UsageLedger(self.root, clock=self.clock)
        self.assertFalse(ledger.flush())

    def test_corrupt_file_degrades_to_empty_ledger(self):
        path = self.root / "usage.json"
        path.write_text("{ this is not json", encoding="utf-8")
        ledger = UsageLedger(self.root, clock=self.clock)
        self.assertEqual(ledger.snapshot("day")["totals"]["total_tokens"], 0)
        self.assertTrue((self.root / "usage.corrupt.json").exists())

    def test_wrong_shape_also_degrades(self):
        (self.root / "usage.json").write_text(json.dumps(["not", "a", "dict"]), encoding="utf-8")
        ledger = UsageLedger(self.root, clock=self.clock)
        ledger.record_tokens("api", 1, 1, 2)
        self.assertEqual(ledger.snapshot("day")["totals"]["total_tokens"], 2)

    def test_prune_drops_old_days_and_dead_accounts(self):
        ledger = UsageLedger(self.root, clock=self.clock)
        now = datetime.fromtimestamp(self.clock(), CN)
        old = (now - timedelta(days=500)).timestamp()
        ledger.record_tokens("api", 1, 1, 2, at=old, account="dead")
        ledger.record_tokens("api", 1, 1, 2, account="alive")
        ledger.record_credit_sample("dead", 10.0)
        ledger.record_credit_sample("alive", 10.0)
        ledger.prune(keep_accounts={"alive"})
        self.assertEqual(ledger.snapshot("day")["coverage"]["stored_days"], 1)
        self.assertEqual([b["id"] for b in ledger.snapshot("day")["balances"]], ["alive"])

    def test_tolerates_partial_and_typed_drift(self):
        (self.root / "usage.json").write_text(json.dumps({
            "version": 1,
            "days": {"2026-09-27": {"api": {"requests": "3", "total": None},
                                    "models": {"m": {"requests": 1}},
                                    "credits": {"used": "12.5"}}},
            "balances": {"a1": {"remaining": "50", "at": 1}, "bad": "nope"},
        }), encoding="utf-8")
        ledger = UsageLedger(self.root, clock=self.clock)
        day = ledger._days["2026-09-27"]
        self.assertEqual(day["api"]["requests"], 3)
        self.assertEqual(day["api"]["total"], 0)
        self.assertEqual(day["test"]["requests"], 0)
        self.assertAlmostEqual(day["credits"]["used"], 12.5, places=6)
        self.assertEqual(list(ledger._balances), ["a1"])


class UsageEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.auth = self.root / "auth"
        self.auth.mkdir()
        (self.auth / "session.info").write_text(json.dumps(credential()), encoding="utf-8")
        self.app = admin_server.create_app(self.root / "management", self.auth, API, ADMIN)
        self.transport = httpx.ASGITransport(app=self.app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="https://console.test")

    async def asyncTearDown(self):
        await self.client.aclose()
        self.temp.cleanup()

    async def login(self):
        result = await self.client.post("/admin/api/login", json={"key": ADMIN})
        self.assertEqual(result.status_code, 200)
        self.client.headers["X-CSRF-Token"] = result.json()["csrf"]

    async def test_requires_admin(self):
        self.assertEqual((await self.client.get("/admin/api/usage")).status_code, 401)
        self.assertEqual((await self.client.get("/admin/api/usage?period=day",
                                                headers={"Authorization": "Bearer " + API})).status_code, 401)

    async def test_invalid_period_is_400(self):
        await self.login()
        self.assertEqual((await self.client.get("/admin/api/usage?period=week")).status_code, 400)

    async def test_empty_ledger_returns_zero_filled_buckets(self):
        await self.login()
        result = await self.client.get("/admin/api/usage?period=day")
        self.assertEqual(result.status_code, 200)
        body = result.json()
        self.assertEqual(body["period"], "day")
        self.assertEqual(body["timezone"], "+08:00")
        self.assertEqual(len(body["buckets"]), 30)
        self.assertEqual(body["totals"]["total_tokens"], 0)
        self.assertEqual(body["totals"]["credits_used"], 0.0)
        self.assertEqual(body["models"], [])
        self.assertEqual(body["accounts"], [])
        self.assertTrue(body["coverage"]["credit_note"])
        self.assertIn("采样", body["coverage"]["credit_note"])

    async def test_reflects_recorded_usage(self):
        await self.login()
        ledger = self.app.state.ledger
        ledger.record_tokens("api", 100, 20, 120, account="a1", model="glm-5.2")
        ledger.record_credit_sample("a1", 500.0)
        ledger.record_credit_sample("a1", 380.0)
        body = (await self.client.get("/admin/api/usage?period=month")).json()
        self.assertEqual(body["period"], "month")
        self.assertEqual(body["totals"]["total_tokens"], 120)
        self.assertAlmostEqual(body["totals"]["credits_used"], 120.0, places=6)
        self.assertEqual(body["models"][0]["model"], "glm-5.2")

    async def test_default_period_is_day(self):
        await self.login()
        self.assertEqual((await self.client.get("/admin/api/usage")).json()["period"], "day")


class OverviewMetricsTests(unittest.IsolatedAsyncioTestCase):
    """overview 里的 token 累计是新字段，且不能破坏既有键。"""

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.auth = self.root / "auth"
        self.auth.mkdir()
        (self.auth / "session.info").write_text(json.dumps(credential()), encoding="utf-8")
        self.app = admin_server.create_app(self.root / "management", self.auth, API, ADMIN)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="https://console.test")
        result = await self.client.post("/admin/api/login", json={"key": ADMIN})
        self.client.headers["X-CSRF-Token"] = result.json()["csrf"]

    async def asyncTearDown(self):
        await self.client.aclose()
        self.temp.cleanup()

    async def test_metrics_expose_tokens_and_no_secrets(self):
        metrics = self.app.state.metrics
        metrics.begin()
        metrics.finish("/v1/chat/completions", "api", 200, True, 12.0, "success",
                       usage=(10, 2, 12), account="a1", model="m")
        body = (await self.client.get("/admin/api/overview")).json()
        m = body["metrics"]
        self.assertEqual(m["total_tokens"], 12)
        self.assertEqual(m["prompt_tokens"], 10)
        self.assertEqual(m["completion_tokens"], 2)
        self.assertEqual(m["unmetered"], 0)
        self.assertEqual(m["completed"], 1)
        self.assertEqual(self.app.state.ledger.snapshot("day")["totals"]["total_tokens"], 12)

    async def test_ledger_records_unmetered_without_usage(self):
        metrics = self.app.state.metrics
        metrics.begin()
        metrics.finish("/v1/messages", "api", 200, True, 5.0, "success")
        self.assertEqual((await self.client.get("/admin/api/overview")).json()["metrics"]["unmetered"], 1)
        self.assertEqual(self.app.state.ledger.snapshot("day")["totals"]["unmetered"], 1)


if __name__ == "__main__":
    unittest.main()
