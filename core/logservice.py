"""日志服务（严格只读）。

- 只提供 list / read 两类操作，没有任何写入、删除、改名接口；
- 文件名同样走白名单校验，杜绝通过日志接口读到其它目录；
- 解析（分列、统计）放在前端做，后端只负责可靠地读出文本 + 元信息，
  这样以后想加统计维度不需要改后端。
"""

from __future__ import annotations

import re
from pathlib import Path

from . import config, fsutil

LEVEL_RE = re.compile(r"^\d{2}:\d{2}:\d{2}\.\d{3}\s+\[([A-Za-z]+)\]")
CACHE: dict[str, dict] = {}


def _scan_meta(path: Path) -> dict:
    """统计行数与级别分布；按 mtime+size 缓存，避免每次刷新都重读 598 个文件。"""
    stat = path.stat()
    key = f"{path}|{stat.st_mtime_ns}|{stat.st_size}"
    cached = CACHE.get(key)
    if cached:
        return cached
    lines = 0
    levels: dict[str, int] = {}
    first_line = ""
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            for raw in fh:
                lines += 1
                if lines == 1:
                    first_line = raw.rstrip("\r\n")[:160]
                match = LEVEL_RE.match(raw)
                if match:
                    level = match.group(1).upper()
                    levels[level] = levels.get(level, 0) + 1
    except OSError:
        pass
    meta = {"lines": lines, "levels": levels, "firstLine": first_line,
            "hasError": levels.get("ERROR", 0) > 0}
    CACHE[key] = meta
    if len(CACHE) > 4000:
        CACHE.clear()
    return meta


def list_files(root_id: str) -> list[dict]:
    limit = config.limits()["maxListFiles"]
    items = fsutil.list_dir(root_id, limit)
    root = config.root_by_id(root_id) or {}
    for item in items:
        path = Path(root.get("path", "")) / item["name"]
        try:
            item.update(_scan_meta(path))
        except OSError:
            item.update({"lines": 0, "levels": {}, "hasError": False, "firstLine": ""})
    return items


def get_file(root_id: str, name: str) -> dict:
    path = fsutil.resolve_file(root_id, name)
    payload = fsutil.read_text_file(path, config.limits()["maxLogBytes"])
    payload["lines"] = payload["text"].count("\n") + (0 if payload["text"].endswith("\n") else 1)
    return payload


def summarize(root_id: str) -> dict:
    """整个日志根目录的概览，用于首页卡片与未来扩展。"""
    items = list_files(root_id)
    total_lines = sum(i.get("lines", 0) for i in items)
    levels: dict[str, int] = {}
    errors = 0
    for item in items:
        for level, count in (item.get("levels") or {}).items():
            levels[level] = levels.get(level, 0) + count
        if item.get("hasError"):
            errors += 1
    return {
        "files": len(items),
        "lines": total_lines,
        "levels": levels,
        "filesWithError": errors,
        "latest": items[0] if items else None,
    }
