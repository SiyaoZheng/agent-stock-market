"""Read-only SocialDataX search through its authenticated platform MCP services."""

import asyncio
import html
import json
import os
import re
import tomllib
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


PLATFORMS = {
    "weibo": ("Weibo", "weibo_search_posts"),
    "xhs": ("Xiaohongshu", "xhs_search_notes"),
    "douyin": ("Douyin", "douyin_search_videos"),
    "kuaishou": ("Kuaishou", "kuaishou_search_videos"),
    "bilibili": ("Bilibili", "bilibili_search_videos"),
    "zhihu": ("Zhihu", "zhihu_search_content"),
    "wechat": ("WeChat Channels", "wechat_search_videos"),
    "toutiao": ("Toutiao", "toutiao_search_posts"),
    "baidu-tieba": ("Baidu Tieba", "baidu_tieba_search_posts"),
    "x": ("X / Twitter", "x_search_posts"),
    "youtube": ("YouTube", "youtube_search_videos"),
    "instagram": ("Instagram", "instagram_search_posts"),
    "tiktok": ("TikTok", "tiktok_search_posts"),
}


def text_only(value, limit=900):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", "", str(value or "")))).strip()[:limit]


def normalize(item):
    body = next((item.get(key) for key in ("content", "text", "description", "caption", "summary")
                 if item.get(key)), "")
    title = item.get("title") or text_only(body, 100) or "Social media post"
    author = item.get("author") or {}
    url = next((item.get(key) for key in ("note_url", "post_url", "content_url", "share_url")
                if item.get(key)), None)
    # Preserve returned source URLs exactly, including XHS access parameters.
    published = item.get("publish_time")
    if isinstance(published, (int, float)):
        try:
            published = datetime.fromtimestamp(published, timezone.utc).isoformat()
        except (ValueError, OSError, OverflowError):
            published = None
    return {
        "id": next((str(item[key]) for key in ("note_id", "post_id", "content_id", "aweme_id",
                     "photo_id", "video_id", "thread_id", "encrypted_object_id") if item.get(key)), ""),
        "title": text_only(title, 180), "text": text_only(body), "url": url,
        "author": text_only(author.get("name") if isinstance(author, dict) else author, 100),
        "published_at": published or item.get("publish_time_text"),
        "metrics": {key: item[key] for key in ("like_count", "comment_count", "reply_count",
                    "repost_count", "share_count", "view_count", "read_count", "upvote_count")
                    if item.get(key) is not None},
    }


class SocialSearchClient:
    def __init__(self):
        self.headers = {}
        key = os.getenv("SOCIALDATAX_API_KEY", "").strip()
        if key:
            self.headers = {platform: {"Authorization": f"Bearer {key}"} for platform in PLATFORMS}
        else:
            try:
                config = tomllib.loads((Path.home() / ".codex" / "config.toml").read_text())
                for platform in PLATFORMS:
                    server = config.get("mcp_servers", {}).get(f"socialdatax-{platform}", {})
                    auth = server.get("http_headers", {}).get("Authorization")
                    if auth and server.get("url") == self.endpoint(platform):
                        self.headers[platform] = {"Authorization": auth}
            except (OSError, ValueError):
                pass

    @staticmethod
    def endpoint(platform):
        return f"https://mcp.socialdatax.com/{platform}/mcp"

    def platforms(self):
        return [{"id": platform, "name": name, "available": platform in self.headers}
                for platform, (name, _) in PLATFORMS.items()]

    def error_text(self, exc):
        if isinstance(exc, BaseExceptionGroup):
            message = "; ".join(self.error_text(item) for item in exc.exceptions)
        else:
            message = str(exc) or type(exc).__name__
        for headers in self.headers.values():
            secret = headers["Authorization"]
            message = message.replace(secret, "[credential]").replace(secret.removeprefix("Bearer "), "[credential]")
        return message[:900]

    async def search(self, platform, query, limit=5):
        if platform not in PLATFORMS:
            raise ValueError("Choose one of the supported social media channels")
        if platform not in self.headers:
            raise ValueError("No SocialDataX API key is configured for this channel")
        query = query.strip()
        if not query or len(query) > 160:
            raise ValueError("Search query must contain 1–160 characters")
        if type(limit) is not int or not 1 <= limit <= 10:
            raise ValueError("Request 1–10 results at a time")
        async with asyncio.timeout(45):
            async with httpx.AsyncClient(headers=self.headers[platform], timeout=40) as http:
                async with streamable_http_client(self.endpoint(platform), http_client=http) as (read, write, _):
                    async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=40)) as session:
                        await session.initialize()
                        response = await session.call_tool(PLATFORMS[platform][1], {"keyword": query})
        payload = response.structuredContent
        if payload is None:
            text = "\n".join(block.text for block in response.content if block.type == "text")
            try:
                payload = json.loads(text)
            except (ValueError, TypeError):
                payload = {"message": text}
        if response.isError or payload.get("error"):
            error = payload.get("error") or payload
            message = error if isinstance(error, str) else json.dumps(error, ensure_ascii=False)
            if "insufficient" in message.lower() or "\u4f59\u989d\u4e0d\u8db3" in message or "\u79ef\u5206\u4e0d\u8db3" in message:
                message += " Top up credits: https://socialdatax.com/dashboard/billing"
            raise ValueError(message)
        items = payload.get("items")
        if not isinstance(items, list):
            raise ValueError("SocialDataX did not return usable search results: " + text_only(payload.get("message"), 500))
        return {"results": [normalize(item) for item in items[:limit]],
                "page_result_count": len(items), "has_more": bool(payload.get("next_page_token")),
                "points": payload.get("points")}
