"""Tests for the gateway's web_search server-tool implementation.

Run from the kernel directory with the kernel venv:
    .venv/Scripts/python.exe tests/test_web_search.py

No network required: the HTML parsers and the Anthropic protocol shape are tested
against fixtures; one live end-to-end search runs only when WB_LIVE_SEARCH=1.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import web_search  # noqa: E402
from core.anthropic_adapter import (  # noqa: E402
    anthropic_request_to_chat,
    is_server_tool,
)

# ---------------------------------------------------------------------------
# Fixtures: realistic search-engine HTML
# ---------------------------------------------------------------------------

BING_HTML = """
<ol id="b_results">
<li class="b_algo"><h2><a href="https://www.deepseek.com/">DeepSeek | Into the Unknown</a></h2>
<div><p class="b_lineclamp4">2 days ago &middot; DeepSeek is an AI research company.</p></div></li>
<li class="b_algo"><h2><a href="https://github.com/deepseek-ai">DeepSeek &#x5728; GitHub</a></h2>
<div><p>2025&#24180;5&#26376;9&#26085; &middot; Type Language Sort deepseek-harness Public.</p></div></li>
<li class="b_algo"><h2><a href="https://cn.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdl">Redirected</a></h2>
<div><p>3 hours ago &middot; via redirect.</p></div></li>
</ol>
"""

BAIDU_HTML = """
<div class="result c-container"><h3 class="t"><a href="http://www.baidu.com/link?url=AAA">Deepseek v3 正式发布</a></h3></div>
<div class="result c-container"><h3 class="t"><a href="http://www.baidu.com/link?url=BBB">DeepSeek-V3 技术报告</a></h3></div>
"""

BLOCKED_HTML = "<html><body><div class='anomaly-modal'>Unfortunately, bots use DuckDuckGo too.</div></body></html>"

PASSED: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        PASSED.append(name)
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        raise AssertionError(name + " " + detail)


# ---------------------------------------------------------------------------
# 1. Bing / Baidu parsing
# ---------------------------------------------------------------------------


def test_parse_bing():
    print("\n[1] Bing parser")
    rows = web_search._parse_bing(BING_HTML)
    check("bing returns 3 results", len(rows) == 3, f"got {len(rows)}")
    check("bing title", rows[0].title == "DeepSeek | Into the Unknown", rows[0].title)
    check("bing url", rows[0].url == "https://www.deepseek.com/", rows[0].url)
    check("bing snippet strips age", rows[0].snippet == "DeepSeek is an AI research company.", rows[0].snippet)
    check("bing page_age english", rows[0].page_age == "2 days ago", rows[0].page_age)
    check("bing unescapes entity in title", "GitHub" in rows[1].title, rows[1].title)
    check("bing page_age chinese date", rows[1].page_age.startswith("2025"), rows[1].page_age)
    check(
        "bing unwraps ck/a redirect",
        rows[2].url == "https://example.com/page",
        rows[2].url,
    )


def test_parse_baidu():
    print("\n[2] Baidu parser")
    rows = web_search._parse_baidu(BAIDU_HTML)
    check("baidu returns 2 results", len(rows) == 2, f"got {len(rows)}")
    check("baidu title", rows[0].title == "Deepseek v3 正式发布", rows[0].title)
    check("baidu url", rows[0].url.startswith("http://www.baidu.com/link"), rows[0].url)


def test_blocked_detection():
    print("\n[3] Anti-bot detection")
    check("detects small anomaly page", web_search._blocked(BLOCKED_HTML) is True)
    check("normal page not blocked", web_search._blocked(BING_HTML) is False)
    # Regression: a real result page is large and its inlined JS mentions
    # "安全验证"/"captcha"; that must NOT be treated as a blocked page, or we
    # would throw away an entire page of good results.
    big_legit = (
        '<div class="result"><h3><a href="https://x.example">t</a></h3></div>'
        + ("安全验证 captcha " * 4000)
    )
    check(
        "large page with marker is NOT blocked",
        web_search._blocked(big_legit) is False,
        f"len={len(big_legit.encode())}",
    )


# ---------------------------------------------------------------------------
# 2. Server-tool classification and request conversion
# ---------------------------------------------------------------------------


def test_server_tool_detection():
    print("\n[4] Server-tool classification")
    ws = {"type": "web_search_20250305", "name": "web_search", "max_uses": 5}
    fn = {"name": "read", "description": "d", "input_schema": {"type": "object"}}
    chat_fn = {"type": "function", "function": {"name": "read"}}
    check("web_search is a server tool", is_server_tool(ws) is True)
    check("input_schema tool is not a server tool", is_server_tool(fn) is False)
    check("chat-format tool is not a server tool", is_server_tool(chat_fn) is False)
    check("custom type is not a server tool", is_server_tool({"type": "custom", "name": "x"}) is False)


def test_request_conversion_drops_server_tool():
    print("\n[5] Request conversion drops server tools")
    payload = {
        "model": "m",
        "max_tokens": 100,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "tools": [
            {"type": "web_search_20250305", "name": "web_search", "max_uses": 5},
            {"name": "read", "input_schema": {"type": "object", "properties": {}}},
        ],
    }
    chat = anthropic_request_to_chat(payload)
    names = [t["function"]["name"] for t in chat.get("tools", [])]
    check("web_search not forwarded", "web_search" not in names, str(names))
    check("real function tool forwarded", names == ["read"], str(names))


def test_request_conversion_no_empty_tools():
    print("\n[6] All-server-tool request omits tools key")
    payload = {
        "model": "m",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}],
    }
    chat = anthropic_request_to_chat(payload)
    check("tools key omitted entirely", "tools" not in chat, str(chat.get("tools")))
    check("tool_choice dropped too", "tool_choice" not in chat)


def test_query_extraction():
    print("\n[7] Query extraction")
    payload = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Perform a web search for the query: DeepSeek V3 发布",
                    }
                ],
            }
        ]
    }
    check(
        "strips plugin prefix",
        web_search.extract_search_query(payload) == "DeepSeek V3 发布",
        web_search.extract_search_query(payload),
    )
    plain = {"messages": [{"role": "user", "content": "plain question"}]}
    check("plain text passes through", web_search.extract_search_query(plain) == "plain question")


# ---------------------------------------------------------------------------
# 3. Response shape — the exact contract the DSH plugin reads
# ---------------------------------------------------------------------------


def test_response_shape_matches_plugin():
    """Mirror the DSH plugin's mapAnthropicResponse(): it filters blocks by
    type == 'web_search_tool_result', reads item.url/title/page_age, and joins
    snippets from text-block citations keyed by url."""
    print("\n[8] Response shape vs DSH plugin contract")
    results = [
        web_search.SearchResult(
            url="https://a.example/1", title="A", snippet="snippet A", page_age="2 days ago"
        ),
        web_search.SearchResult(url="https://b.example/2", title="B", snippet="snippet B"),
    ]
    msg = web_search.build_message("q", results, "m")
    blocks = msg["content"]

    result_blocks = [b for b in blocks if b["type"] == "web_search_tool_result"]
    check("has web_search_tool_result block", len(result_blocks) == 1, str(len(result_blocks)))
    check("result block has tool_use_id", bool(result_blocks[0].get("tool_use_id")))

    items = result_blocks[0]["content"]
    check("two web_search_result items", len(items) == 2, str(len(items)))
    check("items typed web_search_result", all(i["type"] == "web_search_result" for i in items))
    check("item url present", items[0]["url"] == "https://a.example/1")
    check("item title present", items[0]["title"] == "A")
    check("item page_age present", items[0].get("page_age") == "2 days ago")
    check("item without age omits page_age", "page_age" not in items[1])

    # replicate the plugin's citationSnippets()
    snippets = {}
    for b in blocks:
        if b["type"] != "text":
            continue
        for c in b.get("citations") or []:
            if c.get("url") and c.get("cited_text") and c["url"] not in snippets:
                snippets[c["url"]] = c["cited_text"]
    check("citation maps url->snippet", snippets.get("https://a.example/1") == "snippet A", str(snippets))
    check("second citation mapped", snippets.get("https://b.example/2") == "snippet B")

    check("model echoed", msg["model"] == "m")
    check("stop_reason end_turn", msg["stop_reason"] == "end_turn")
    check("usage present", "input_tokens" in msg["usage"])


def test_empty_results_still_emit_result_block():
    """The plugin errors when no web_search_tool_result block exists, so an
    empty result set must still produce the block (with empty content)."""
    print("\n[9] Empty results still emit the result block")
    msg = web_search.build_message("nothing", [], "m")
    result_blocks = [b for b in msg["content"] if b["type"] == "web_search_tool_result"]
    check("result block present even when empty", len(result_blocks) == 1)
    check("content is empty list", result_blocks[0]["content"] == [])


def test_sse_events_wellformed():
    print("\n[10] SSE rendering")
    msg = web_search.build_message(
        "q", [web_search.SearchResult(url="https://a.example", title="A", snippet="s")], "m"
    )
    raw = "".join(web_search.sse_events(msg))
    check("starts with message_start", "event: message_start" in raw)
    check("has content_block_start", "event: content_block_start" in raw)
    check("has message_delta", "event: message_delta" in raw)
    check("ends with message_stop", raw.rstrip().endswith('event: message_stop\ndata: {"type": "message_stop"}'), raw[-120:])

    # every data: line must be valid JSON
    bad = []
    for line in raw.splitlines():
        if line.startswith("data:"):
            try:
                json.loads(line[5:].strip())
            except json.JSONDecodeError:
                bad.append(line[:80])
    check("all SSE data lines are JSON", not bad, str(bad))

    # the result block must appear in the stream without nested delta
    check("result block emitted in stream", '"type": "web_search_tool_result"' in raw)


# ---------------------------------------------------------------------------
# 4. Language-aware provider ordering
# ---------------------------------------------------------------------------


def test_provider_ordering_by_language():
    print("\n[11] Language-aware provider ordering")
    check("CJK detected in chinese query", web_search._is_cjk_query("Python asyncio 教程") is True)
    check("pure english is not cjk", web_search._is_cjk_query("python asyncio tutorial") is False)
    check("japanese kana counted as cjk", web_search._is_cjk_query("テスト") is True)

    zh = web_search._order_for_query(["bing", "baidu"], "Python asyncio 教程")
    check("chinese puts baidu first", zh == ["baidu", "bing"], str(zh))
    en = web_search._order_for_query(["bing", "baidu"], "python asyncio tutorial")
    check("english puts bing first", en == ["bing", "baidu"], str(en))
    api = web_search._order_for_query(["tavily", "bing", "baidu"], "中文查询")
    check("api providers stay first", api == ["tavily", "baidu", "bing"], str(api))


def test_baidu_redirect_noop_for_normal_urls():
    print("\n[12] Baidu redirect resolver is a no-op for normal urls")

    async def run():
        import httpx

        async with httpx.AsyncClient(timeout=5) as c:
            return await web_search._resolve_baidu_redirect("https://example.com/x", c)

    check("normal url untouched", asyncio.run(run()) == "https://example.com/x")


# ---------------------------------------------------------------------------
# 5. Live end-to-end (opt-in)
# ---------------------------------------------------------------------------


def test_live_search():
    if os.environ.get("WB_LIVE_SEARCH") != "1":
        print("\n[13] Live search SKIPPED (set WB_LIVE_SEARCH=1 to enable)")
        return
    print("\n[13] Live search (chinese query should prefer baidu)")

    async def run():
        return await web_search.search("Python asyncio 教程", limit=5)

    rows = asyncio.run(run())
    check("live search returned results", len(rows) > 0, f"got {len(rows)}")
    check(
        "urls are resolved (no baidu /link redirects)",
        all("baidu.com/link?" not in r.url for r in rows),
        str([r.url[:60] for r in rows]),
    )
    for r in rows[:5]:
        print(f"      - {r.title[:60]} | {r.url[:70]}")


def main():
    tests = [
        test_parse_bing,
        test_parse_baidu,
        test_blocked_detection,
        test_server_tool_detection,
        test_request_conversion_drops_server_tool,
        test_request_conversion_no_empty_tools,
        test_query_extraction,
        test_response_shape_matches_plugin,
        test_empty_results_still_emit_result_block,
        test_sse_events_wellformed,
        test_provider_ordering_by_language,
        test_baidu_redirect_noop_for_normal_urls,
        test_live_search,
    ]
    for t in tests:
        t()
    print(f"\n=== {len(PASSED)} checks passed across {len(tests)} test groups ===")


if __name__ == "__main__":
    main()
