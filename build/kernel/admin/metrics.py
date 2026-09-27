"""Bounded process-lifetime counters; never store prompts, responses or keys.

进程内的请求统计。token 用量除了这里的累计值，还会经 UsageLedger 落到
usage.json（跨重启保留、可按日/月/年聚合）：两者口径一致但生命周期不同，
本模块的计数重启即清零，账本不清零。
"""
import json
import threading
import time
from collections import deque

from .usage import extract_usage

PATHS = {"/v1/chat/completions", "/v1/responses", "/v1/messages"}

#: 非流式响应缓冲上限：只为取 usage；超出即放弃提取（按「未取到用量」计）
MAX_BUFFER = 256 * 1024


class RequestMetrics:
    def __init__(self, ledger=None):
        self.lock = threading.Lock()
        self.ledger = ledger
        self.started_at = int(time.time())
        self.in_flight = self.total = self.success = self.http_success = 0
        self.duration_sum = 0
        self.api_count = self.test_count = 0
        # token 累计（仅本次进程），供状态页 KPI 与账本做对照
        self.prompt_tokens = self.completion_tokens = self.total_tokens = 0
        self.unmetered = 0
        self.recent = deque(maxlen=100)

    def begin(self):
        with self.lock:
            self.in_flight += 1

    def finish(self, path, source, status, ok, duration, outcome,
               usage=None, account=None, model=None):
        """usage 为 (prompt, completion, total)；None 表示这次没取到用量。

        新增的 usage/account/model 都是关键字参数，保持既有位置调用兼容。
        """
        with self.lock:
            self.in_flight -= 1
            self.total += 1
            self.success += int(ok)
            self.http_success += int(status is not None and 200 <= status < 300)
            self.duration_sum += duration
            self.api_count += int(source == "api")
            self.test_count += int(source == "test")
            if usage is None:
                self.unmetered += 1
            else:
                self.prompt_tokens += usage[0]
                self.completion_tokens += usage[1]
                self.total_tokens += usage[2]
            self.recent.appendleft({"time": int(time.time()), "path": path, "source": source,
                                    "status": status, "ok": ok, "duration_ms": round(duration), "outcome": outcome})
        if self.ledger is not None:
            prompt, completion, total = usage if usage is not None else (None, None, None)
            self.ledger.record_tokens(source, prompt, completion, total,
                                      account=account, model=model)

    def snapshot(self):
        with self.lock:
            return {"started_at": self.started_at, "completed": self.total, "in_flight": self.in_flight,
                    "succeeded": self.success, "failed": self.total - self.success,
                    "success_rate": round(100*self.success/self.total, 1) if self.total else None,
                    "http_success_rate": round(100*self.http_success/self.total, 1) if self.total else None,
                    "avg_duration_ms": round(self.duration_sum/self.total) if self.total else None,
                    "api_count": self.api_count, "test_count": self.test_count,
                    "prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens,
                    "total_tokens": self.total_tokens, "unmetered": self.unmetered,
                    "recent": list(self.recent)}


class MetricsMiddleware:
    def __init__(self, app, metrics, source="api"):
        self.app, self.metrics, self.source = app, metrics, source

    async def __call__(self, scope, receive, send):
        path = scope.get("path")
        if scope["type"] != "http" or scope["method"] != "POST" or path not in PATHS:
            return await self.app(scope, receive, send)
        start = time.monotonic()
        self.metrics.begin()
        status = None
        completed = failed = streaming = terminal = disconnected = False
        buffer = b""
        oversized_line = False
        usage = None       # (prompt, completion, total)
        body = b""         # 非流式：为取 usage 而缓冲的响应体
        body_oversized = False

        def capture(value):
            """记录一段已解码 JSON 里的 usage；非零值优先于先到的占位零值。"""
            nonlocal usage
            found = extract_usage(value)
            if found is None:
                return
            if usage is None or found[2] > 0:
                usage = found

        def event(line):
            nonlocal failed, terminal
            if not line.startswith(b"data:"):
                return
            payload = line[5:].strip()
            if payload == b"[DONE]":
                terminal = True
                return
            try:
                value = json.loads(payload)
            except ValueError:
                return
            if not isinstance(value, dict):
                return
            typ = value.get("type")
            if value.get("error") or typ in ("error", "response.failed", "response.incomplete"):
                failed = True
            if typ in ("response.completed", "message_stop"):
                terminal = True
            response = value.get("response")
            if isinstance(response, dict) and (response.get("error") or response.get("status") in ("failed", "incomplete")):
                failed = True
            # OpenAI chat completion 流：choices[].finish_reason 非空即代表生成已结束。
            # 不少客户端（Cherry Studio / HexHub 等）在收到 finish_reason 后直接关闭连接、
            # 不再等待 [DONE]，因此这里也把它视为流已正常结束，避免误判为「中断」。
            for choice in value.get("choices") or []:
                if isinstance(choice, dict) and choice.get("finish_reason"):
                    terminal = True
            capture(value)

        async def observed_receive():
            nonlocal disconnected
            message = await receive()
            # 流已经到达结束标记（terminal）之后客户端断开，是正常行为
            # （例如收到 finish_reason 就断开去执行工具），不应算作中断。
            if message["type"] == "http.disconnect" and not completed and not terminal:
                disconnected = True
            return message

        async def observed_send(message):
            nonlocal status, streaming, completed, buffer, failed, oversized_line
            nonlocal body, body_oversized
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = dict(message.get("headers", []))
                streaming = b"text/event-stream" in headers.get(b"content-type", b"").lower()
            elif message["type"] == "http.response.body":
                if streaming:
                    # Bound storage even if the upstream sends a huge unterminated line.
                    for fragment in message.get("body", b"").splitlines(keepends=True):
                        end = fragment.endswith(b"\n")
                        if not oversized_line and len(buffer) + len(fragment) <= 65536:
                            buffer += fragment
                        else:
                            oversized_line = True
                            buffer = b""
                        if end:
                            if not oversized_line:
                                event(buffer)
                            buffer = b""
                            oversized_line = False
                else:
                    # 非流式响应通常是单个 chat.completion / response / message 对象，
                    # 里面就带 usage。超上限则放弃提取（如实计入未取到用量）。
                    chunk = message.get("body", b"")
                    if not body_oversized:
                        if len(body) + len(chunk) <= MAX_BUFFER:
                            body += chunk
                        else:
                            body_oversized = True
                            body = b""
                if not message.get("more_body", False):
                    if streaming and buffer:
                        event(buffer)
                        buffer = b""
                    elif not streaming and body:
                        try:
                            capture(json.loads(body.decode("utf-8", "replace")))
                        except ValueError:
                            pass
                        body = b""
                    await send(message)
                    completed = True
                    return
            await send(message)

        try:
            await self.app(scope, observed_receive, observed_send)
        except BaseException:
            # 流式已到达结束标记之后，客户端断开导致写回抛异常是正常收尾，不算失败。
            if not (streaming and terminal):
                failed = True
            raise
        finally:
            http_ok = status is not None and 200 <= status < 300
            if streaming:
                # 流式：语义结束以结束标记为准，而非「是否发完最后一个 body / 客户端是否断开」。
                # 客户端在结束标记之后断开（例如收到 finish_reason 就执行工具）是正常的。
                ok = http_ok and not failed and terminal
                outcome = "success" if ok else "stream_error" if failed else "interrupted"
            else:
                ok = http_ok and completed and not disconnected and not failed
                outcome = "success" if ok else "interrupted" if not completed or disconnected else "http_error"
            # 账号 / 模型由内层 PoolMiddleware 写在 scope 上：外层读 ContextVar 是拿不到的
            # （内层在 finally 里已经 reset 过）。认证失败等路径允许为空。
            self.metrics.finish(path, self.source, status, ok, (time.monotonic()-start)*1000, outcome,
                                usage=usage,
                                account=scope.get("wb_account_id"),
                                model=scope.get("wb_model"))
