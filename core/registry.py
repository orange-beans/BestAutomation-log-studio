"""插件注册表。

扩展方式（见 plugins/README.md）：
在 plugins/ 下新增一个 .py 文件，定义 setup(registry) 即可：
    def setup(registry):
        registry.add_api("GET", "/api/demo/ping", lambda q, body: {"pong": True})
        registry.add_view(id="demo", title="演示", script="plugin-demo.js")

前端会自动多出一个页签，后端自动多出一个接口，无需改动 app.py。
"""

from __future__ import annotations

import importlib.util
import traceback
from pathlib import Path

STUDIO_DIR = Path(__file__).resolve().parent.parent
PLUGIN_DIR = STUDIO_DIR / "plugins"


class Registry:
    def __init__(self):
        self.apis: dict[tuple[str, str], callable] = {}
        self.views: list[dict] = []
        self.errors: list[dict] = []

    def add_api(self, method: str, path: str, handler):
        self.apis[(method.upper(), path)] = handler

    def add_view(self, *, id: str, title: str, script: str = "", icon: str = "",
                 description: str = ""):
        self.views.append({
            "id": id, "title": title, "script": script, "icon": icon,
            "description": description,
        })

    def dispatch(self, method: str, path: str, query: dict, body: dict):
        handler = self.apis.get((method.upper(), path))
        if handler is None:
            return None
        return handler(query, body)


def load_plugins() -> Registry:
    registry = Registry()
    if not PLUGIN_DIR.is_dir():
        return registry
    for item in sorted(PLUGIN_DIR.glob("*.py")):
        if item.name.startswith("_"):
            continue
        try:
            spec = importlib.util.spec_from_file_location(f"studio_plugin_{item.stem}", item)
            module = importlib.util.module_from_spec(spec)
            assert spec.loader is not None
            spec.loader.exec_module(module)
            setup = getattr(module, "setup", None)
            if callable(setup):
                setup(registry)
        except Exception as exc:
            registry.errors.append({
                "file": item.name,
                "error": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc(limit=3),
            })
    return registry
