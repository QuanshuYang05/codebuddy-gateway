"""用量账本：按天累计 token 与积分消耗，跨重启保留。

设计约束（读上游与内核代码得出，非猜测）：

1. **上游没有按日用量接口**。`/v2/billing/meter/get-user-resource` 只返回积分包
   快照（CapacityUsed/Remain/Size、CycleStartTime/EndTime），其余 dosage/usage/
   consume/bill 一类端点一律 404。所以 token 只能从响应流里自己取，积分只能靠
   「定期采样余额、相邻两次做差分」折算。
2. **必须落盘**。内核既有的 RequestMetrics 是进程内累计、重启清零；用量要能按
   日/月/年看，就必须自己持久化。
3. **不能每请求写盘**。高频请求下每次都 fsync 会拖垮转发路径，因此内存累加 +
   节流 flush，最多丢一个节流窗口。
4. **不能把内核写崩**。账本损坏时退化为空账本并备份坏文件，绝不阻止启动。

分桶一律用北京时间（+08:00），与 pool.py 的签到口径保持一致：用户看到的
「今天」应当是本地日，而不是 UTC 日。
"""

import json
import math
import os
import threading
import time
from datetime import datetime, timedelta, timezone

CN = timezone(timedelta(hours=8))

#: period -> 展示多少个桶（含当前桶）
PERIODS = {"day": 30, "month": 12, "year": 5}

#: 保留天数；超出即裁剪
RETENTION_DAYS = 400

#: 节流写盘间隔（秒）
FLUSH_INTERVAL = 30

CORRUPT_NAME = "usage.corrupt.json"


def _write_text(path, text):
    """原子写：先写临时文件再 os.replace，避免半截 JSON。"""
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        out.write(text)
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)


def _int(value):
    if isinstance(value, bool) or value is None:
        return 0
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, n)


def _number(value):
    if isinstance(value, bool) or value is None:
        return 0.0
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n):
        return 0.0
    return max(0.0, n)


def extract_usage(value):
    """从一段已解码的 SSE/JSON 对象里取 usage，返回 (prompt, completion, total) 或 None。

    三种上游形状都覆盖：
      - chat:      {"usage": {"prompt_tokens": .., "completion_tokens": .., "total_tokens": ..}}
      - responses: {"type": "response.completed", "response": {"usage": {"input_tokens": .., ...}}}
      - anthropic: {"type": "message_delta", "usage": {"input_tokens": .., "output_tokens": ..}}

    message_start 的 usage 恒为 0，属于占位值，会返回 (0,0,0)，由调用方决定是否忽略。
    """
    if not isinstance(value, dict):
        return None
    usage = None
    if isinstance(value.get("usage"), dict):
        usage = value["usage"]
    else:
        response = value.get("response")
        if isinstance(response, dict) and isinstance(response.get("usage"), dict):
            usage = response["usage"]
    if usage is None:
        return None

    prompt = usage.get("prompt_tokens", usage.get("input_tokens"))
    completion = usage.get("completion_tokens", usage.get("output_tokens"))
    total = usage.get("total_tokens")
    if prompt is None and completion is None and total is None:
        return None
    prompt = _int(prompt)
    completion = _int(completion)
    total = _int(total) or (prompt + completion)
    return prompt, completion, total


class UsageLedger:
    """按天聚合的用量账本。线程安全：pool.operate 跑在 asyncio.to_thread 里。"""

    def __init__(self, root, clock=time.time):
        self.clock = clock
        self.lock = threading.RLock()
        self.path = root / "usage.json"
        self._days = {}
        self._balances = {}
        self._dirty = False
        self._last_flush = 0.0
        self._load()

    # ---- 持久化 ----

    def _load(self):
        if not self.path.exists():
            return
        try:
            doc = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(doc, dict):
                raise ValueError("root not a dict")
            days = doc.get("days")
            if not isinstance(days, dict):
                raise ValueError("days not a dict")
        except (ValueError, OSError):
            # 坏文件不能阻止内核启动：备份后从空账本开始。
            try:
                self.path.replace(self.path.with_name(CORRUPT_NAME))
            except OSError:
                pass
            return
        with self.lock:
            for key, value in days.items():
                if isinstance(key, str) and isinstance(value, dict):
                    self._days[key] = self._normalize_day(value)
            balances = doc.get("balances")
            if isinstance(balances, dict):
                for aid, item in balances.items():
                    if not isinstance(item, dict):
                        continue
                    remaining = item.get("remaining")
                    if remaining is None:
                        continue
                    self._balances[str(aid)] = {
                        "remaining": _number(remaining),
                        "at": _int(item.get("at")),
                    }

    @staticmethod
    def _normalize_day(value):
        """把磁盘上的一天归一化成完整结构，容忍缺字段与类型漂移。"""
        day = {
            "api": {"requests": 0, "prompt": 0, "completion": 0, "total": 0, "unmetered": 0},
            "test": {"requests": 0, "prompt": 0, "completion": 0, "total": 0, "unmetered": 0},
            "models": {},
            "accounts": {},
            "credits": {"used": 0.0, "granted": 0.0, "samples": 0},
        }
        for source in ("api", "test"):
            raw = value.get(source)
            if isinstance(raw, dict):
                for field in ("requests", "prompt", "completion", "total", "unmetered"):
                    day[source][field] = _int(raw.get(field))
        for group in ("models", "accounts"):
            raw = value.get(group)
            if isinstance(raw, dict):
                for name, item in raw.items():
                    if not isinstance(item, dict):
                        continue
                    day[group][str(name)] = {
                        "requests": _int(item.get("requests")),
                        "total": _int(item.get("total")),
                    }
        raw = value.get("credits")
        if isinstance(raw, dict):
            day["credits"] = {
                "used": _number(raw.get("used")),
                "granted": _number(raw.get("granted")),
                "samples": _int(raw.get("samples")),
            }
        return day

    def _serialize_locked(self):
        # 在锁内序列化，锁外只做写入，避免快照与累加并发。
        return json.dumps(
            {"version": 1, "days": self._days, "balances": self._balances},
            ensure_ascii=False,
            indent=2,
        )

    def flush(self, force=False):
        """节流落盘。返回是否真的写了。"""
        with self.lock:
            if not self._dirty:
                return False
            now = self.clock()
            if not force and now - self._last_flush < FLUSH_INTERVAL:
                return False
            text = self._serialize_locked()
            self._last_flush = now
            self._dirty = False
        try:
            _write_text(self.path, text)
            return True
        except OSError:
            with self.lock:
                self._dirty = True
            return False

    # ---- 累加 ----

    @staticmethod
    def day_key(ts):
        return datetime.fromtimestamp(ts, CN).strftime("%Y-%m-%d")

    def _day_locked(self, key):
        day = self._days.get(key)
        if day is None:
            day = self._normalize_day({})
            self._days[key] = day
        return day

    def record_tokens(self, source, prompt, completion, total, account=None, model=None, at=None):
        """记一次请求的 token。

        usage 缺失时（客户端在 finish_reason 后立刻断开就拿不到 usage chunk）
        仍然记请求数，并累计 unmetered，让界面能如实显示「有 N 笔没取到用量」。
        """
        key = self.day_key(at if at is not None else self.clock())
        bucket = "test" if source == "test" else "api"
        with self.lock:
            day = self._day_locked(key)
            stats = day[bucket]
            stats["requests"] += 1
            if prompt is None and completion is None and total is None:
                stats["unmetered"] += 1
                self._dirty = True
                return
            prompt = _int(prompt)
            completion = _int(completion)
            total = _int(total) or (prompt + completion)
            stats["prompt"] += prompt
            stats["completion"] += completion
            stats["total"] += total
            if model:
                slot = day["models"].setdefault(str(model), {"requests": 0, "total": 0})
                slot["requests"] += 1
                slot["total"] += total
            if account:
                slot = day["accounts"].setdefault(str(account), {"requests": 0, "total": 0})
                slot["requests"] += 1
                slot["total"] += total
            self._dirty = True

    def record_credit_sample(self, account, remaining, at=None):
        """记一次积分余额采样，与上一次做差分得到消耗量。

        首次采样只建立基线（否则会把历史消耗全算到当天）。
        余额上升（充值/签到赠包）记为 granted，绝不产生负消耗。
        差分全部落在**当前**这一天：采样间隔内的消耗无法再细分。
        """
        if not account or remaining is None:
            return
        value = _number(remaining)
        now = at if at is not None else self.clock()
        key = self.day_key(now)
        with self.lock:
            previous = self._balances.get(str(account))
            self._balances[str(account)] = {"remaining": value, "at": _int(now)}
            self._dirty = True
            if previous is None:
                return
            delta = float(previous["remaining"]) - value
            if abs(delta) < 1e-9:
                return
            credits = self._day_locked(key)["credits"]
            credits["samples"] += 1
            if delta > 0:
                credits["used"] = round(credits["used"] + delta, 6)
            else:
                credits["granted"] = round(credits["granted"] - delta, 6)

    def prune(self, keep_days=RETENTION_DAYS, keep_accounts=None):
        """裁掉过老的日期；账号被删除后其余额基线也一并清掉。

        按日期阈值裁剪而不是「保留 N 个键」：否则一个很旧的日子会一直留到攒满
        N 天数据才被清掉。
        """
        with self.lock:
            if keep_days is not None:
                cutoff = (datetime.fromtimestamp(self.clock(), CN) - timedelta(days=keep_days)).strftime("%Y-%m-%d")
                for key in [k for k in self._days if k < cutoff]:
                    del self._days[key]
                    self._dirty = True
            if keep_accounts is not None:
                for account in list(self._balances):
                    if account not in keep_accounts:
                        del self._balances[account]
                        self._dirty = True

    # ---- 查询 ----

    def _bucket_keys(self, period):
        """返回该周期需要展示的桶 key 列表（旧的在前），含当前桶。"""
        now = datetime.fromtimestamp(self.clock(), CN)
        if period == "month":
            keys = []
            year, month = now.year, now.month
            for _ in range(PERIODS["month"]):
                keys.append(f"{year:04d}-{month:02d}")
                month -= 1
                if month == 0:
                    month, year = 12, year - 1
            return list(reversed(keys))
        if period == "year":
            return [str(now.year - offset) for offset in reversed(range(PERIODS["year"]))]
        return [
            (now - timedelta(days=offset)).strftime("%Y-%m-%d")
            for offset in reversed(range(PERIODS["day"]))
        ]

    @staticmethod
    def _label(period, key):
        if period == "day":
            return key[5:]
        if period == "month":
            return key
        return key

    def snapshot(self, period="day", account_names=None):
        """按周期聚合。缺失的桶补零，保证坐标轴连续、不跳格。"""
        if period not in PERIODS:
            raise ValueError("统计周期无效")
        names = account_names or {}
        with self.lock:
            keys = self._bucket_keys(period)
            days = {key: value for key, value in self._days.items()}
            balances = {aid: dict(item) for aid, item in self._balances.items()}

        buckets = []
        index = {}
        for key in keys:
            bucket = {
                "key": key,
                "label": self._label(period, key),
                "api_requests": 0,
                "test_requests": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "unmetered": 0,
                "credits_used": 0.0,
                "credits_granted": 0.0,
            }
            buckets.append(bucket)
            index[key] = bucket

        models, accounts = {}, {}
        sampled_days = 0
        for day_key, day in days.items():
            if period == "day":
                key = day_key
            elif period == "month":
                key = day_key[:7]
            else:
                key = day_key[:4]
            bucket = index.get(key)
            if bucket is None:
                continue  # 落在展示窗口之外，但仍计入覆盖统计
            for source in ("api", "test"):
                stats = day[source]
                bucket[f"{source}_requests"] += stats["requests"]
                bucket["prompt_tokens"] += stats["prompt"]
                bucket["completion_tokens"] += stats["completion"]
                bucket["total_tokens"] += stats["total"]
                bucket["unmetered"] += stats["unmetered"]
            bucket["credits_used"] = round(bucket["credits_used"] + day["credits"]["used"], 6)
            bucket["credits_granted"] = round(bucket["credits_granted"] + day["credits"]["granted"], 6)
            if day["credits"]["samples"]:
                sampled_days += 1
            for name, item in day["models"].items():
                slot = models.setdefault(name, {"model": name, "requests": 0, "total_tokens": 0})
                slot["requests"] += item["requests"]
                slot["total_tokens"] += item["total"]
            for aid, item in day["accounts"].items():
                slot = accounts.setdefault(aid, {"id": aid, "requests": 0, "total_tokens": 0})
                slot["requests"] += item["requests"]
                slot["total_tokens"] += item["total"]

        totals = {
            "api_requests": sum(b["api_requests"] for b in buckets),
            "test_requests": sum(b["test_requests"] for b in buckets),
            "prompt_tokens": sum(b["prompt_tokens"] for b in buckets),
            "completion_tokens": sum(b["completion_tokens"] for b in buckets),
            "total_tokens": sum(b["total_tokens"] for b in buckets),
            "unmetered": sum(b["unmetered"] for b in buckets),
            "credits_used": round(sum(b["credits_used"] for b in buckets), 6),
            "credits_granted": round(sum(b["credits_granted"] for b in buckets), 6),
        }

        rows = sorted(accounts.values(), key=lambda item: -item["total_tokens"])[:20]
        for row in rows:
            row["name"] = names.get(row["id"]) or row["id"]

        return {
            "period": period,
            "timezone": "+08:00",
            "bucket_count": len(buckets),
            "buckets": buckets,
            "totals": totals,
            "models": sorted(models.values(), key=lambda item: -item["total_tokens"])[:10],
            "accounts": rows,
            "balances": [
                {"id": aid, "name": names.get(aid) or aid, "remaining": item["remaining"], "at": item["at"]}
                for aid, item in sorted(balances.items(), key=lambda kv: kv[1]["at"])
            ],
            "coverage": {
                "retention_days": RETENTION_DAYS,
                "sampled_days": sampled_days,
                "stored_days": len(days),
                "credit_note": "积分消耗按余额采样差分折算，不是上游账单",
            },
            "generated_at": int(self.clock()),
        }
