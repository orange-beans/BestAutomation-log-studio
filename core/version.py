"""版本号单一来源：读取 studio/VERSION。

代码里不要再散落版本字符串；`app.py` 的 bootstrap 与启动横幅都用这里。
文件缺失时回退到 FALLBACK，保证旧副本仍能启动。
"""

from pathlib import Path

FALLBACK = "1.3.0"
_VERSION_FILE = Path(__file__).resolve().parent.parent / "VERSION"


def _read_version() -> str:
    try:
        text = _VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return FALLBACK
    return text or FALLBACK


__version__ = _read_version()
