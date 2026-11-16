"""文件系统工具：安全路径解析、编码识别、原子写入、时间戳备份。

此处是所有磁盘读写的唯一入口：
- 任何用户传来的文件名都必须通过 `resolve_file`，杜绝路径穿越；
- 编辑保存一律"先备份、写临时文件、再原子替换"，断电或占用都不会写坏原文件；
- 读取时记录原文件的编码 / 换行 / BOM / 结尾换行，保存时原样还原，避免设备软件读不出差异。
"""

from __future__ import annotations

import fnmatch
import os
import shutil
import time
from datetime import datetime
from pathlib import Path

from . import config

BOM_UTF8 = b"\xef\xbb\xbf"
_INVALID_CHARS = set('<>:"/\\|?*\0')


class PathRejected(Exception):
    """路径不合法（越权、不符合白名单）。"""


def human_size(num: int) -> str:
    step = 1024.0
    value = float(num)
    for unit in ("B", "KB", "MB", "GB"):
        if value < step or unit == "GB":
            if unit == "B":
                return f"{int(value)} B"
            return f"{value:.1f} {unit}"
        value /= step
    return f"{value:.1f} GB"


def resolve_file(root_id: str, name: str) -> Path:
    """把前端传来的文件名解析为根目录下的真实文件路径。"""
    root = config.root_by_id(root_id)
    if not root:
        raise PathRejected(f"未知的文件根目录：{root_id}")
    if not root["exists"]:
        raise PathRejected(f"目录不存在：{root['path']}")
    raw = (name or "").strip()
    if not raw or len(raw) > 255:
        raise PathRejected("文件名为空或过长")
    if any(ch in _INVALID_CHARS for ch in raw):
        raise PathRejected("文件名包含非法字符")
    if raw in (".", "..") or ".." in raw.split("."):
        raise PathRejected("文件名不合法")
    if not fnmatch.fnmatch(raw.lower(), root["pattern"].lower()):
        raise PathRejected(f"文件名不符合白名单规则：{root['pattern']}")
    base = Path(root["path"]).resolve()
    target = (base / raw).resolve()
    if base != target.parent:
        raise PathRejected("路径越权，已拒绝")
    return target


def ensure_file(path: Path, limit: int) -> None:
    if not path.exists():
        raise FileNotFoundError(f"文件不存在：{path.name}")
    if not path.is_file():
        raise PathRejected(f"不是普通文件：{path.name}")
    size = path.stat().st_size
    if size > limit:
        raise PathRejected(f"文件 {path.name} 为 {human_size(size)}，超过读取上限 {human_size(limit)}")


def detect_encoding(raw: bytes) -> tuple[str, bool]:
    """返回 (encoding, has_bom)。Windows 环境下优先 utf-8，其次 gbk。"""
    if raw.startswith(BOM_UTF8):
        return "utf-8-sig", True
    try:
        raw.decode("utf-8")
        return "utf-8", False
    except UnicodeDecodeError:
        pass
    for candidate in ("gbk", "gb18030"):
        try:
            raw.decode(candidate)
            return candidate, False
        except UnicodeDecodeError:
            continue
    return "latin-1", False


def detect_eol(text: str) -> str:
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    if crlf and lf:
        return "\r\n" if crlf >= lf else "\n"
    return "\r\n" if crlf else "\n"


def normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def detect_indent(text: str) -> tuple[str, int]:
    """从文本推断缩进风格，返回 (unit, width)。"""
    for line in text.split("\n")[:400]:
        if not line.strip():
            continue
        stripped = line.lstrip(" \t")
        prefix = line[: len(line) - len(stripped)]
        if prefix.startswith("\t"):
            return "\t", 1
        if prefix:
            return " " * len(prefix), len(prefix)
        break
    if any(line.startswith("\t") for line in text.split("\n")[:400]):
        return "\t", 1
    return "  ", 2


def read_text_file(path: Path, limit: int) -> dict:
    ensure_file(path, limit)
    raw = path.read_bytes()
    encoding, has_bom = detect_encoding(raw)
    text = raw.decode(encoding)
    eol = detect_eol(text)
    trailing_newline = text.endswith("\n")
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "sizeText": human_size(stat.st_size),
        "mtime": stat.st_mtime,
        "mtimeText": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "encoding": encoding,
        "hasBom": has_bom,
        "eol": eol,
        "trailingNewline": trailing_newline,
        "indentUnit": detect_indent(text)[0],
        "indentWidth": detect_indent(text)[1],
        "text": normalize_newlines(text),
    }


def atomic_write_text(path: Path, text: str, *, encoding: str = "utf-8", eol: str = "\n",
                      has_bom: bool = False, trailing_newline: bool = True) -> None:
    """原子写入：保留编码 / 换行 / BOM / 结尾换行。"""
    body = normalize_newlines(text)
    if trailing_newline and not body.endswith("\n"):
        body += "\n"
    if not trailing_newline:
        body = body.rstrip("\n")
    if eol != "\n":
        body = body.replace("\n", eol)
    if encoding == "utf-8-sig" or has_bom:
        data = BOM_UTF8 + body.encode("utf-8")
    else:
        data = body.encode(encoding, errors="strict")

    directory = path.parent
    tmp = directory / f".{path.name}.studio-tmp-{int(time.time() * 1000)}"
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def backup_file(path: Path, root_id: str, keep: int) -> Path | None:
    """保存前把当前内容备份到 studio/.tool-backups/<root>/，并做轮转。"""
    if not path.exists():
        return None
    directory = config.backup_dir() / root_id
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
    target = directory / f"{path.name}.{stamp}.bak"
    shutil.copy2(path, target)
    prune_backups(directory, path.name, keep)
    return target


def prune_backups(directory: Path, name: str, keep: int) -> None:
    try:
        files = sorted(
            (p for p in directory.iterdir() if p.is_file() and p.name.startswith(name + ".")),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return
    for old in files[keep:]:
        try:
            old.unlink()
        except OSError:
            pass


def list_backups(root_id: str, name: str) -> list[dict]:
    directory = config.backup_dir() / root_id
    if not directory.is_dir():
        return []
    items = []
    for p in directory.iterdir():
        if not p.is_file() or not p.name.startswith(name + ".") or not p.name.endswith(".bak"):
            continue
        stamp = p.name[len(name) + 1 : -4]
        stat = p.stat()
        items.append({
            "id": p.name,
            "stamp": stamp,
            "size": stat.st_size,
            "sizeText": human_size(stat.st_size),
            "mtime": stat.st_mtime,
            "mtimeText": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        })
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items


def read_backup(root_id: str, name: str, backup_id: str) -> dict:
    directory = (config.backup_dir() / root_id).resolve()
    if not backup_id.startswith(name + ".") or "/" in backup_id or "\\" in backup_id:
        raise PathRejected("备份文件名不合法")
    target = (directory / backup_id).resolve()
    if target.parent != directory or not target.is_file():
        raise PathRejected("备份文件不存在")
    raw = target.read_bytes()
    encoding, _ = detect_encoding(raw)
    text = normalize_newlines(raw.decode(encoding))
    return {"text": text, "size": len(raw), "sizeText": human_size(len(raw))}


def list_dir(root_id: str, limit: int) -> list[dict]:
    root = config.root_by_id(root_id)
    if not root:
        raise PathRejected(f"未知的文件根目录：{root_id}")
    base = Path(root["path"])
    if not base.is_dir():
        raise PathRejected(f"目录不存在：{base}")
    pattern = root["pattern"].lower()
    out = []
    try:
        entries = sorted(base.iterdir(), key=lambda p: p.name.lower())
    except OSError as exc:
        raise PathRejected(f"目录不可读：{exc}") from exc
    for entry in entries:
        if len(out) >= limit:
            break
        try:
            if not entry.is_file() or not fnmatch.fnmatch(entry.name.lower(), pattern):
                continue
            stat = entry.stat()
        except OSError:
            continue
        out.append({
            "name": entry.name,
            "size": stat.st_size,
            "sizeText": human_size(stat.st_size),
            "mtime": stat.st_mtime,
            "mtimeText": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        })
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def file_signature(path: Path) -> dict:
    stat = path.stat()
    return {"mtime": stat.st_mtime, "size": stat.st_size, "mtimeNs": stat.st_mtime_ns}
