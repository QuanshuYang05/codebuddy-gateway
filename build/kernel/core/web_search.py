"""web_search.py — 网关侧的联网搜索（Anthropic `web_search_20250305` 服务端工具）。

DSH / Claude Code 把联网搜索当作 **服务端工具** 交给 API 提供方执行：请求里带
`{"type": "web_search_20250305", "name": "web_search"}`，并期望响应里出现
`web_search_tool_result` 内容块。OpenAI Chat 协议没有对应概念，所以这个工具
**不能** 转发给 CodeBuddy 后端（会被转成一个无参数的假 function tool），
必须由网关自己执行搜索并合成 Anthropic 响应。

默认无需 API Key：抓取 Bing 搜索结果页（中文优先），Baidu 兜底。
若配置了 TAVILY_API_KEY / SERPER_API_KEY，则优先走对应的搜索 API。

可通过环境变量调整：
  WB_WEB_SEARCH=0                关闭该能力（服务端工具被忽略，退化为普通请求）
  WB_WEB_SEARCH_PROVIDERS=bing,baidu
  WB_WEB_SEARCH_MAX_RESULTS=8
"""

from __future__ import annotations

import asyncio
import base64
import html as _html
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse

import httpx

from .anthropic_adapter import is_server_tool

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
)

BROWSER_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

DEFAULT_MAX_RESULTS = 8
MAX_QUERY_CHARS = 400

#: DSH 搜索插件固定使用的提示前缀，取查询词时剥掉。
QUERY_PREFIX = "perform a web search for the query:"

#: Bing 结果里 "2 days ago · xxx" / "2025年5月9日 · xxx" 形式的时间前缀。
_AGE_PREFIX = re.compile(
    r"^(?:"
    r"(?P<ymd>\d{4})\s*[年/.\-]\s*(?P<mon>\d{1,2})\s*[月/.\-]\s*(?P<day>\d{1,2})\s*日?"
    r"|(?P<num>\d+)\s*(?P<unit>day|days|hour|hours|minute|minutes|month|months|year|years)\s+ago"
    r"|(?P<cnum>\d+)\s*(?P<cunit>天|小时|分钟|个月|年)前"
    r")\s*[·•\-–—|]\s*",
    re.IGNORECASE,
)

#: 被搜索引擎反爬拦截时的页面特征。
_BLOCK_MARKERS = (
    "anomaly",
    "captcha",
    "verify you are human",
    "unusual traffic",
    "请完成安全验证",
    "安全验证",
)

#: 拦截页/验证页都很小（几 KB）；真实结果页通常几百 KB。
#: 必须同时满足「含标记」+「页面小」才算被拦截 —— 否则真实结果页里
#: 内联 JS 出现的 "安全验证" 字样会让我们丢弃一整页好结果。
_BLOCK_MAX_BYTES = 50_000


def web_search_enabled() -> bool:
    """服务端工具开关；显式设为 0/false 时关闭。"""
    return os.environ.get("WB_WEB_SEARCH", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def _max_results_default() -> int:
    try:
        n = int(os.environ.get("WB_WEB_SEARCH_MAX_RESULTS", DEFAULT_MAX_RESULTS))
    except (TypeError, ValueError):
        return DEFAULT_MAX_RESULTS
    return max(1, min(20, n))


def _providers() -> list[str]:
    raw = os.environ.get("WB_WEB_SEARCH_PROVIDERS", "").strip()
    if raw:
        return [p.strip().lower() for p in raw.split(",") if p.strip()]
    out: list[str] = []
    if os.environ.get("TAVILY_API_KEY", "").strip():
        out.append("tavily")
    if os.environ.get("SERPER_API_KEY", "").strip():
        out.append("serper")
    # 中文查询用百度、英文查询用 Bing：实测百度对中文长尾/技术词明显更准，
    # 而 cn.bing.com 对中文查询会给出日历、百科这类泛化结果。
    out.extend(["bing", "baidu"])
    return out


#: 出现 CJK 字符即视为中文查询。
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")


def _is_cjk_query(query: str) -> bool:
    return bool(_CJK.search(query or ""))


def _order_for_query(providers: list[str], query: str) -> list[str]:
    """按查询语言给搜索引擎排序；API 类提供方（tavily/serper）始终优先。"""
    api = [p for p in providers if p in ("tavily", "serper")]
    engines = [p for p in providers if p in ("bing", "baidu")]
    if _is_cjk_query(query):
        engines.sort(key=lambda p: 0 if p == "baidu" else 1)
    else:
        engines.sort(key=lambda p: 0 if p == "bing" else 1)
    return api + engines


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------


@dataclass
class SearchResult:
    """一条归一化的搜索结果。`page_age` 可能为空。"""

    url: str
    title: str = ""
    snippet: str = ""
    page_age: str = ""


# ---------------------------------------------------------------------------
# 文本工具
# ---------------------------------------------------------------------------


def _clean(text: str) -> str:
    """去标签、解实体、压空白。"""
    text = re.sub(r"(?s)<[^>]+>", " ", text or "")
    text = _html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _split_age(text: str) -> tuple[str, str]:
    """把 `2 days ago · 正文` 拆成 (page_age, 正文)。"""
    m = _AGE_PREFIX.match(text or "")
    if not m:
        return "", (text or "").strip()
    return m.group(0).rstrip(" ·•-–—|").strip(), text[m.end():].strip()


def _unwrap_bing(href: str) -> str:
    """还原 Bing 的 /ck/a 跳转链接（其 u=a1<base64> 参数携带真实地址）。"""
    if "bing.com/ck/a" not in href:
        return href
    try:
        raw = (parse_qs(urlparse(href).query).get("u") or [""])[0]
    except ValueError:
        return href
    if not raw.startswith("a1"):
        return href
    payload = raw[2:]
    payload += "=" * (-len(payload) % 4)
    try:
        return base64.urlsafe_b64decode(payload).decode("utf-8", "replace") or href
    except Exception:  # noqa: BLE001 - 解码失败就保留原链接
        return href


def _blocked(text: str) -> bool:
    """是否为反爬拦截页。

    判据是「含拦截标记」且「页面异常小」：真实结果页体积很大，且内联 JS/CSS
    里常出现「安全验证」「captcha」等字样，只看关键字会把好结果误判成拦截。
    """
    body = text or ""
    if len(body.encode("utf-8", "ignore")) > _BLOCK_MAX_BYTES:
        return False
    low = body.lower()
    return any(marker in low for marker in _BLOCK_MARKERS)


# ---------------------------------------------------------------------------
# 各搜索提供方：均返回 list[SearchResult]
# ---------------------------------------------------------------------------


def _parse_bing(html: str) -> list[SearchResult]:
    """解析 Bing 结果页。每条结果是 <li class="b_algo">，标题在 h2>a，摘要在 p。"""
    out: list[SearchResult] = []
    blocks = re.finditer(
        r'(?s)<li class="b_algo".*?(?=<li class="b_algo"|</ol>)', html or ""
    )
    for m in blocks:
        blk = m.group(0)
        a = re.search(
            r'<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', blk, re.S
        )
        if not a:
            continue
        url = _unwrap_bing(_html.unescape(a.group(1)).strip())
        title = _clean(a.group(2))
        if not url.startswith("http"):
            continue
        p = re.search(r"(?s)<p[^>]*>(.*?)</p>", blk)
        snippet = _clean(p.group(1)) if p else ""
        age, snippet = _split_age(snippet)
        out.append(SearchResult(url=url, title=title, snippet=snippet, page_age=age))
    return out


def _parse_baidu(html: str) -> list[SearchResult]:
    """解析 Baidu 结果页（链接是 /link?url= 跳转，直接保留）。"""
    out: list[SearchResult] = []
    for m in re.finditer(r'(?s)<div[^>]+class="result[^"]*".*?</h3>', html or ""):
        blk = m.group(0)
        a = re.search(
            r'<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', blk, re.S
        )
        if not a:
            continue
        url = _html.unescape(a.group(1)).strip()
        title = _clean(a.group(2))
        if not url.startswith("http"):
            continue
        out.append(SearchResult(url=url, title=title))
    return out


async def _search_bing(
    query: str, limit: int, client: httpx.AsyncClient
) -> list[SearchResult]:
    # cn.bing.com 对中文更友好，失败再试国际站
    for host in ("https://cn.bing.com/search", "https://www.bing.com/search"):
        r = await client.get(host, params={"q": query}, headers=BROWSER_HEADERS)
        if r.status_code != 200:
            continue
        if _blocked(r.text):
            continue
        rows = _parse_bing(r.text)
        if rows:
            return rows[:limit]
    return []


async def _resolve_baidu_redirect(
    url: str, client: httpx.AsyncClient
) -> str:
    """百度结果链接是 /link?url= 跳转，解出真实地址（失败就保留原链接）。"""
    if "baidu.com/link?" not in url:
        return url
    try:
        r = await client.get(url, headers=BROWSER_HEADERS, follow_redirects=False)
        loc = r.headers.get("location") or ""
        if loc.startswith("http"):
            return loc
    except Exception:  # noqa: BLE001 - 解不出就用原链接
        pass
    return url


async def _search_baidu(
    query: str, limit: int, client: httpx.AsyncClient
) -> list[SearchResult]:
    # 先访问首页拿 BAIDUID 等 cookie 再搜索：直接打 /s 会被判定为机器人，
    # 返回一个 1.4KB 的验证页（表现为 0 结果）。同一次请求内按 client 缓存。
    if not getattr(client, "_wb_baidu_warmed", False):
        try:
            await client.get("https://www.baidu.com/", headers=BROWSER_HEADERS)
        except Exception:  # noqa: BLE001 - 预热失败也继续尝试搜索
            pass
        try:
            client._wb_baidu_warmed = True  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass

    headers = dict(BROWSER_HEADERS)
    headers["Referer"] = "https://www.baidu.com/"
    r = await client.get(
        "https://www.baidu.com/s", params={"wd": query}, headers=headers
    )
    if r.status_code != 200 or _blocked(r.text):
        return []
    rows = _parse_baidu(r.text)[:limit]
    # 解析真实地址（并发，单条失败不影响整体）
    resolved = await asyncio.gather(
        *(_resolve_baidu_redirect(row.url, client) for row in rows),
        return_exceptions=True,
    )
    for row, real in zip(rows, resolved):
        if isinstance(real, str) and real.startswith("http"):
            row.url = real
    return rows


async def _search_tavily(
    query: str, limit: int, client: httpx.AsyncClient
) -> list[SearchResult]:
    key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not key:
        return []
    r = await client.post(
        "https://api.tavily.com/search",
        json={"api_key": key, "query": query, "max_results": limit},
    )
    if r.status_code != 200:
        return []
    data = r.json()
    return [
        SearchResult(
            url=str(item.get("url", "")),
            title=str(item.get("title", "")),
            snippet=_clean(str(item.get("content", ""))),
        )
        for item in (data.get("results") or [])
        if item.get("url")
    ]


async def _search_serper(
    query: str, limit: int, client: httpx.AsyncClient
) -> list[SearchResult]:
    key = os.environ.get("SERPER_API_KEY", "").strip()
    if not key:
        return []
    r = await client.post(
        "https://google.serper.dev/search",
        headers={"X-API-KEY": key, "Content-Type": "application/json"},
        json={"q": query, "num": limit},
    )
    if r.status_code != 200:
        return []
    data = r.json()
    return [
        SearchResult(
            url=str(item.get("link", "")),
            title=str(item.get("title", "")),
            snippet=_clean(str(item.get("snippet", ""))),
        )
        for item in (data.get("organic") or [])
        if item.get("link")
    ]


_PROVIDER_FUNCS = {
    "bing": _search_bing,
    "baidu": _search_baidu,
    "tavily": _search_tavily,
    "serper": _search_serper,
}


async def search(query: str, limit: int | None = None) -> list[SearchResult]:
    """按查询语言排序逐个提供方尝试，凑够 limit 条即停，按 url 去重。"""
    query = (query or "").strip()[:MAX_QUERY_CHARS]
    if not query:
        return []
    limit = limit or _max_results_default()

    out: list[SearchResult] = []
    seen: set[str] = set()
    order = _order_for_query(_providers(), query)
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        for name in order:
            fn = _PROVIDER_FUNCS.get(name)
            if fn is None:
                continue
            try:
                rows = await fn(query, limit, client)
            except Exception:  # noqa: BLE001 - 单个提供方失败不影响其它
                continue
            for row in rows:
                if not row.url or row.url in seen:
                    continue
                seen.add(row.url)
                out.append(row)
            if len(out) >= limit:
                break
    return out[:limit]


# ---------------------------------------------------------------------------
# Anthropic 服务端工具协议：请求侧
# ---------------------------------------------------------------------------


def find_web_search_tool(payload: dict) -> dict | None:
    """请求体里是否声明了 web_search 服务端工具。"""
    for tool in payload.get("tools") or []:
        if not is_server_tool(tool):
            continue
        if str(tool.get("type", "")).startswith("web_search"):
            return tool
    return None


def extract_search_query(payload: dict) -> str:
    """取搜索词：优先剥掉插件的固定前缀，否则用最后一条 user 文本。"""
    text = _last_user_text(payload.get("messages") or [])
    stripped = text.strip()
    if stripped.lower().startswith(QUERY_PREFIX):
        stripped = stripped[len(QUERY_PREFIX):].strip()
    return stripped[:MAX_QUERY_CHARS]


def _last_user_text(messages: list) -> str:
    for m in reversed(messages):
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        content = m.get("content", "")
        if isinstance(content, list):
            parts = [
                str(blk.get("text", ""))
                for blk in content
                if isinstance(blk, dict) and blk.get("type") == "text"
            ]
            return "".join(parts)
        return str(content)
    return ""


# ---------------------------------------------------------------------------
# Anthropic 服务端工具协议：响应侧
# ---------------------------------------------------------------------------


def _results_block(results: list[SearchResult], tool_use_id: str) -> dict:
    """`web_search_tool_result` 块；客户端据此拿到结构化来源列表。"""
    items: list[dict] = []
    for r in results:
        item: dict[str, Any] = {
            "type": "web_search_result",
            "url": r.url,
            "title": r.title,
            "encrypted_content": "",
        }
        if r.page_age:
            item["page_age"] = r.page_age
        items.append(item)
    return {"type": "web_search_tool_result", "tool_use_id": tool_use_id, "content": items}


def _summary_block(query: str, results: list[SearchResult]) -> dict:
    """文本块；每个结果附带一条 citation，客户端从 citation 取摘要片段。"""
    if not results:
        return {"type": "text", "text": f'No web search results for "{query}".', "citations": []}

    lines = [f'Web search results for "{query}" ({len(results)} sources):', ""]
    citations: list[dict] = []
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r.title or r.url}")
        lines.append(f"   {r.url}")
        if r.snippet:
            lines.append(f"   {r.snippet}")
        citations.append(
            {
                "type": "web_search_result_location",
                "url": r.url,
                "title": r.title,
                "cited_text": r.snippet or r.title or r.url,
            }
        )
    return {"type": "text", "text": "\n".join(lines), "citations": citations}


def build_message(
    query: str, results: list[SearchResult], model: str
) -> dict:
    """合成一条 Anthropic Message，含 `web_search_tool_result` + 带 citation 的文本。"""
    tool_use_id = "srvtoolu_" + os.urandom(12).hex()
    blocks = [_results_block(results, tool_use_id), _summary_block(query, results)]
    return {
        "id": "msg_" + os.urandom(12).hex(),
        "type": "message",
        "role": "assistant",
        "model": model or "unknown",
        "content": blocks,
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {
            "input_tokens": max(1, len(query) // 4),
            "output_tokens": max(1, len(str(blocks)) // 4),
        },
    }


async def run_web_search(payload: dict, *, limit: int | None = None) -> dict:
    """执行一次搜索并返回完整的 Anthropic Message。"""
    query = extract_search_query(payload)
    results = await search(query, limit=limit) if query else []
    return build_message(query, results, str(payload.get("model") or "unknown"))


def sse_events(message: dict) -> Iterator[str]:
    """把合成好的 Message 渲染成 Anthropic SSE 事件流（供 stream=true 客户端）。"""
    import json as _json

    def evt(event_type: str, data: dict) -> str:
        return f"event: {event_type}\ndata: {_json.dumps({'type': event_type, **data}, ensure_ascii=False)}\n\n"

    start = dict(message)
    start["content"] = []
    start["usage"] = {"input_tokens": message["usage"]["input_tokens"], "output_tokens": 0}
    yield evt("message_start", {"message": start})

    for idx, block in enumerate(message.get("content") or []):
        if block.get("type") == "text":
            yield evt("content_block_start", {"index": idx, "content_block": {"type": "text", "text": ""}})
            yield evt(
                "content_block_delta",
                {"index": idx, "delta": {"type": "text_delta", "text": block.get("text", "")}},
            )
            if block.get("citations"):
                yield evt(
                    "content_block_delta",
                    {"index": idx, "delta": {"type": "citations_delta", "citations": block["citations"]}},
                )
        else:
            # 服务端工具结果整块下发
            yield evt("content_block_start", {"index": idx, "content_block": block})
        yield evt("content_block_stop", {"index": idx})

    yield evt(
        "message_delta",
        {"delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": message["usage"]},
    )
    yield evt("message_stop", {})
