"""配置加载与路径解析。

设计要点（可移植性）：
- 配置里所有路径都相对于 studio 目录，不含任何绝对路径；
- studio 目录整体拷贝到另一台电脑的同名位置后，`..` 仍指向 BestAutomation；
- 若配置的相对路径不存在，会依次尝试若干候选路径，找到含有目标文件的目录；
- 找不到时不崩溃，而是把 exists=False 抛给前端，由前端给出友好提示。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

STUDIO_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = STUDIO_DIR / "studio.config.json"

DEFAULTS = {
    "server": {"host": "127.0.0.1", "port": 8765, "portSearchRange": 20, "openBrowser": True},
    "roots": {
        "json": [
            {"id": "main", "label": "配置根目录", "path": "..", "pattern": "*.json"},
            {"id": "backup", "label": "backup 备份", "path": "../backup", "pattern": "*.json"},
        ],
        "logs": [
            {"id": "logs", "label": "运行日志", "path": "../logs", "pattern": "*.log"},
            {"id": "experiment", "label": "实验日志", "path": "../logs/experiment", "pattern": "*.log"},
        ],
    },
    "limits": {"maxJsonBytes": 5 * 1024 * 1024, "maxLogBytes": 5 * 1024 * 1024, "maxListFiles": 2000},
    "backup": {"keep": 30},
    "ui": {"theme": "auto", "fontSize": 14, "lineHeight": 1.7, "wrapLongLines": True},
}


def deep_merge(base, override):
    """把 override 合并进 base（只覆盖出现的键），返回新 dict。"""
    if not isinstance(base, dict) or not isinstance(override, dict):
        return override if override is not None else base
    out = dict(base)
    for key, value in override.items():
        if key.startswith("_"):
            continue
        if key in out and isinstance(out[key], dict) and isinstance(value, dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULTS))
    if CONFIG_PATH.is_file():
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
            cfg = deep_merge(cfg, raw)
        except Exception as exc:  # 配置坏了也要能起来，用默认值 + 提示
            cfg["_config_error"] = f"studio.config.json 解析失败：{exc}"
    return cfg


CONFIG = load_config()


def _num(value, fallback, low=None, high=None):
    try:
        out = int(value)
    except (TypeError, ValueError):
        return fallback
    if low is not None:
        out = max(low, out)
    if high is not None:
        out = min(high, out)
    return out


def _candidate_paths(rel: str, root_id: str) -> list[Path]:
    """按优先级给出候选目录，用于换电脑后路径不一致时的兜底。"""
    cands = [STUDIO_DIR / rel]
    if root_id == "main":
        cands += [STUDIO_DIR.parent, STUDIO_DIR.parent.parent]
    elif root_id == "backup":
        cands += [STUDIO_DIR.parent / "backup", STUDIO_DIR.parent.parent / "backup"]
    elif root_id == "logs":
        cands += [STUDIO_DIR.parent / "logs", STUDIO_DIR.parent.parent / "logs"]
    elif root_id == "experiment":
        cands += [
            STUDIO_DIR.parent / "logs" / "experiment",
            STUDIO_DIR.parent.parent / "logs" / "experiment",
        ]
    return cands


RESOLVED_DEMO: dict[str, Path] = {
    "main": STUDIO_DIR / "demo",
    "backup": STUDIO_DIR / "demo" / "backup",
    "logs": STUDIO_DIR / "demo" / "logs",
    "experiment": STUDIO_DIR / "demo" / "logs" / "experiment",
}


def _resolve_root(kind: str, item: dict) -> dict:
    root_id = str(item.get("id") or kind)
    label = str(item.get("label") or root_id)
    pattern = str(item.get("pattern") or ("*.json" if kind == "json" else "*.log"))
    rel = str(item.get("path") or ".")

    # 部署级覆盖：数据放在别处时，无需改配置文件
    #   set STUDIO_ROOT_MAIN=D:\Data\BestAutomation
    override = os.environ.get("STUDIO_ROOT_" + root_id.upper())
    if override:
        path = Path(override)
        return {
            "id": root_id, "kind": kind, "label": label,
            "desc": str(item.get("desc") or ""),
            "path": str(path), "relPath": rel, "pattern": pattern,
            "exists": path.is_dir(), "readonly": bool(item.get("readonly", False)),
            "fromEnv": True,
        }

    # 从 GitHub 克隆、或只把 studio 拷到别的文件夹时，上一层并没有
    # BestAutomation 的 settings.json。此时自动使用仓库内的 demo 数据，
    # 保证“克隆后直接双击就能看到界面”；接真实数据时把 studio 放回
    # BestAutomation 目录，或用 STUDIO_ROOT_* 覆盖即可。
    if not (STUDIO_DIR.parent / "settings.json").is_file():
        demo = RESOLVED_DEMO.get(root_id)
        if demo is not None and demo.is_dir():
            try:
                demo = demo.resolve()
            except OSError:
                demo = Path(os.path.abspath(demo))
            return {
                "id": root_id, "kind": kind, "label": label,
                "desc": str(item.get("desc") or ""),
                "path": str(demo), "relPath": rel, "pattern": pattern,
                "exists": True, "readonly": bool(item.get("readonly", False)),
                "fromDemo": True,
            }

    resolved = None
    for cand in _candidate_paths(rel, root_id):
        try:
            if cand.is_dir():
                resolved = cand
                if cand == STUDIO_DIR / rel:
                    break
                # 候选目录必须真的含有目标文件，避免误判
                if any(cand.glob(pattern)):
                    break
        except OSError:
            continue
    if resolved is None:
        resolved = STUDIO_DIR / rel
    try:
        resolved = resolved.resolve()
    except OSError:
        resolved = Path(os.path.abspath(resolved))
    exists = False
    try:
        exists = resolved.is_dir()
    except OSError:
        exists = False
    return {
        "id": root_id,
        "kind": kind,
        "label": label,
        "desc": str(item.get("desc") or ""),
        "path": str(resolved),
        "relPath": rel,
        "pattern": pattern,
        "exists": exists,
        "readonly": bool(item.get("readonly", False)),
    }


ROOTS: dict[str, dict] = {}
for _kind in ("json", "logs"):
    for _item in CONFIG["roots"].get(_kind, []):
        _root = _resolve_root(_kind, _item)
        ROOTS[_root["id"]] = _root


def root_by_id(root_id: str) -> dict | None:
    return ROOTS.get(root_id)


def roots_of(kind: str) -> list[dict]:
    return [r for r in ROOTS.values() if r["kind"] == kind]


def server_settings() -> dict:
    srv = CONFIG.get("server", {})
    return {
        "host": str(srv.get("host") or "127.0.0.1"),
        "port": _num(srv.get("port"), 8765, 1024, 65535),
        "portSearchRange": _num(srv.get("portSearchRange"), 20, 1, 200),
        "openBrowser": bool(srv.get("openBrowser", True)),
    }


def limits() -> dict:
    lim = CONFIG.get("limits", {})
    return {
        "maxJsonBytes": _num(lim.get("maxJsonBytes"), 5 * 1024 * 1024, 1024),
        "maxLogBytes": _num(lim.get("maxLogBytes"), 5 * 1024 * 1024, 1024),
        "maxListFiles": _num(lim.get("maxListFiles"), 2000, 10),
    }


def backup_settings() -> dict:
    bak = CONFIG.get("backup", {})
    return {"keep": _num(bak.get("keep"), 30, 1, 500)}


def ui_settings() -> dict:
    ui = CONFIG.get("ui", {})
    return {
        "theme": str(ui.get("theme") or "auto"),
        "fontSize": _num(ui.get("fontSize"), 14, 11, 24),
        "lineHeight": float(ui.get("lineHeight") or 1.7),
        "wrapLongLines": bool(ui.get("wrapLongLines", True)),
    }


def backup_dir() -> Path:
    """工具自己的备份目录，放在 studio 内，不污染用户数据目录。"""
    path = STUDIO_DIR / ".tool-backups"
    path.mkdir(parents=True, exist_ok=True)
    return path


def environment_info() -> dict:
    """给"关于/诊断"面板用的环境信息。"""
    return {
        "studioDir": str(STUDIO_DIR),
        "configPath": str(CONFIG_PATH),
        "configExists": CONFIG_PATH.is_file(),
        "python": os.sys.version.split()[0],
        "platform": os.name,
        "cwd": os.getcwd(),
        "configError": CONFIG.get("_config_error", ""),
    }
