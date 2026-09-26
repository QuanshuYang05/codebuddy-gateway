"""Full-stack regression: a client aborting after finish_reason (but before [DONE])
must be recorded as success, not interrupted.

This is the exact production symptom: status=200 + outcome=interrupted for chat
completions whose clients stop reading the SSE stream once they see finish_reason.
"""
import asyncio
import json
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import uvicorn

import core.converter as converter
from admin.server import create_app

# 真实上游：OpenAI chat SSE，最后一条 data 行带 finish_reason=stop，再接 [DONE]。
CHAT_SSE = (
    b'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n'
    b'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n'
    b'data: [DONE]\n\n'
)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        self.rfile.read(n)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        # 与真实网络一致：分片写出，且 [DONE] 前的 finish_reason 已完整到达。
        self.wfile.write(CHAT_SSE[:40]); self.wfile.flush(); time.sleep(0.01)
        self.wfile.write(CHAT_SSE[40:]); self.wfile.flush(); time.sleep(0.01)
        self.wfile.write(CHAT_SSE[-6:]); self.wfile.flush()

    def log_message(self, *a):
        pass


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    converter.BACKEND = f"http://127.0.0.1:{port}"

    # 用一个真实账号凭据目录初始化账号池，避免 503「暂无可用账号」。
    tmp = tempfile.TemporaryDirectory()
    root = Path(tmp.name)
    auth = root / "auth"
    auth.mkdir()
    cred = {
        "account": {"uid": "one", "nickname": "测试", "enterpriseId": "test"},
        "auth": {"accessToken": "private-access-token", "refreshToken": "private-refresh-token",
                 "expiresAt": int(time.time() * 1000) + 3600000},
    }
    (auth / "session.info").write_text(json.dumps(cred), encoding="utf-8")

    app = create_app(root / "management", auth, "k", "x" * 32, secure_cookie=False)
    converter.CONFIG["api_key"] = ""

    class FakeCred:
        def get_headers(self):
            return {"Content-Type": "application/json"}

    converter.CONFIG["cred"] = FakeCred()

    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)
    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()
    while not server.started:
        time.sleep(0.01)
    url = f"http://127.0.0.1:{server.servers[0].sockets[0].getsockname()[1]}"

    async def full_read():
        async with httpx.AsyncClient(timeout=30) as c:
            async with c.stream("POST", url + "/v1/chat/completions",
                                json={"model": "auto", "messages": [{"role": "user", "content": "hi"}], "stream": True},
                                headers={"Authorization": "Bearer k"}) as r:
                body = await r.aread()
        print("full_read status:", r.status_code, "body:", body[:200])
        return app.state.metrics.snapshot()

    async def abort_after_finish_reason():
        async with httpx.AsyncClient(timeout=30) as c:
            async with c.stream("POST", url + "/v1/chat/completions",
                                json={"model": "auto", "messages": [{"role": "user", "content": "hi"}], "stream": True},
                                headers={"Authorization": "Bearer k"}) as r:
                it = r.aiter_lines()
                # 读到带 finish_reason 的那一行后立刻断开，不再读 [DONE]。
                async for line in it:
                    if 'finish_reason":"stop"' in line:
                        break
        return app.state.metrics.snapshot()

    s1 = asyncio.run(full_read())
    def wait_metrics(n=1, timeout=5):
        deadline = time.time() + timeout
        while time.time() < deadline:
            s = app.state.metrics.snapshot()
            if s["completed"] >= n and s["in_flight"] == 0:
                return s
            time.sleep(0.02)
        return app.state.metrics.snapshot()
    s1 = wait_metrics(1)
    print("full_read recent[0]:", s1["recent"][0] if s1["recent"] else None, "success_rate:", s1["success_rate"])

    s2 = asyncio.run(abort_after_finish_reason())
    s2 = wait_metrics(2)
    print("abort recent[0]:", s2["recent"][0], "success_rate:", s2["success_rate"])
    assert s2["recent"][0]["ok"] is True, s2["recent"][0]
    assert s2["recent"][0]["outcome"] == "success", s2["recent"][0]
    print("PASS")

    server.should_exit = True
    srv.shutdown()
    # 优雅关闭后台线程并释放临时目录，避免 Windows 下退出时的文件占用报错。
    server_thread.join(timeout=5)
    srv.server_close()
    tmp.cleanup()


if __name__ == "__main__":
    main()
