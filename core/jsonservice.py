"""JSON 文件服务：列表、读取、校验、保存、备份与还原。"""

from __future__ import annotations

import json
from pathlib import Path

from . import config, fsutil, jsonlint


class ConflictError(Exception):
    """磁盘上的文件已被其它程序改动。"""


class InvalidJson(Exception):
    def __init__(self, result: dict):
        super().__init__("JSON 校验未通过")
        self.result = result


def _quick_lint(path: Path) -> dict:
    """列表页用的轻量校验：小文件才做完整解析。"""
    try:
        if path.stat().st_size > 512 * 1024:
            return {"valid": None, "keys": 0, "depth": 0}
        text = path.read_text(encoding="utf-8-sig", errors="replace")
        result = jsonlint.validate(text)
        return {"valid": result["valid"], "keys": result["stats"]["keys"],
                "depth": result["stats"]["depth"],
                "error": result["errors"][0]["msg"] if result["errors"] else ""}
    except Exception as exc:
        return {"valid": False, "keys": 0, "depth": 0, "error": str(exc)}


def list_files(root_id: str) -> list[dict]:
    limit = config.limits()["maxListFiles"]
    items = fsutil.list_dir(root_id, limit)
    for item in items:
        try:
            item.update(_quick_lint(Path(config.root_by_id(root_id)["path"]) / item["name"]))
        except OSError:
            item.update({"valid": None, "keys": 0, "depth": 0})
        item["backups"] = len(fsutil.list_backups(root_id, item["name"]))
    return items


def get_file(root_id: str, name: str) -> dict:
    path = fsutil.resolve_file(root_id, name)
    payload = fsutil.read_text_file(path, config.limits()["maxJsonBytes"])
    result = jsonlint.validate(payload["text"])
    payload["lint"] = result
    payload["backups"] = fsutil.list_backups(root_id, name)
    return payload


def validate_text(text: str) -> dict:
    return jsonlint.validate(text)


def save_file(root_id: str, name: str, text: str, expected_mtime: float | None = None,
              force: bool = False) -> dict:
    path = fsutil.resolve_file(root_id, name)
    existed = path.exists()
    if existed and expected_mtime and not force:
        current = path.stat().st_mtime
        if abs(current - float(expected_mtime)) > 0.5:
            raise ConflictError("文件已被其它程序修改，请重新加载后再保存")

    result = jsonlint.validate(text)
    if not result["valid"]:
        raise InvalidJson(result)

    # 用磁盘上的真实编码 / 换行 / BOM / 结尾换行来落盘
    if existed:
        meta = fsutil.read_text_file(path, config.limits()["maxJsonBytes"])
        encoding, eol = meta["encoding"], meta["eol"]
        has_bom, trailing = meta["hasBom"], meta["trailingNewline"]
        backup = fsutil.backup_file(path, root_id, config.backup_settings()["keep"])
    else:
        encoding, eol, has_bom, trailing = "utf-8", "\n", False, True
        backup = None

    fsutil.atomic_write_text(path, text, encoding=encoding, eol=eol,
                             has_bom=has_bom, trailing_newline=trailing)
    meta = fsutil.read_text_file(path, config.limits()["maxJsonBytes"])
    return {
        "ok": True,
        "mtime": meta["mtime"],
        "size": meta["size"],
        "sizeText": meta["sizeText"],
        "encoding": meta["encoding"],
        "eol": meta["eol"],
        "backup": backup.name if backup else "",
        "lint": jsonlint.validate(meta["text"]),
        "backups": fsutil.list_backups(root_id, name),
    }


def restore_backup(root_id: str, name: str, backup_id: str) -> dict:
    path = fsutil.resolve_file(root_id, name)
    data = fsutil.read_backup(root_id, name, backup_id)
    if path.exists():
        fsutil.backup_file(path, root_id, config.backup_settings()["keep"])
        meta = fsutil.read_text_file(path, config.limits()["maxJsonBytes"])
        encoding, eol, has_bom, trailing = meta["encoding"], meta["eol"], meta["hasBom"], meta["trailingNewline"]
    else:
        encoding, eol, has_bom, trailing = "utf-8", "\n", False, True
    fsutil.atomic_write_text(path, data["text"], encoding=encoding, eol=eol,
                             has_bom=has_bom, trailing_newline=trailing)
    return get_file(root_id, name)


def diff_with_backup(root_id: str, name: str, backup_id: str) -> dict:
    path = fsutil.resolve_file(root_id, name)
    current = fsutil.read_text_file(path, config.limits()["maxJsonBytes"])
    data = fsutil.read_backup(root_id, name, backup_id)
    return {
        "name": name,
        "left": {"text": data["text"], "label": f"备份 {backup_id}"},
        "right": {"text": current["text"], "label": "磁盘当前内容"},
        "leftLabel": f"备份 {backup_id}",
        "rightLabel": "磁盘当前内容",
    }


def pretty(text: str) -> str:
    """标准库格式化（前端的格式化优先，此接口作为兜底）。"""
    value = json.loads(text)
    return json.dumps(value, ensure_ascii=False, indent=2)
