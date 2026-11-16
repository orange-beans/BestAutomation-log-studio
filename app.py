#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""JSON & 日志工作台 —— 单进程本地服务（仅标准库，零第三方依赖）。

启动：
    py app.py                 # 使用 studio.config.json 中的端口
    py app.py --port 9000     # 指定端口
    py app.py --no-browser    # 不自动打开浏览器

只绑定 127.0.0.1，不对外网开放。
"""

from __future__ import annotations

import argparse
import getpass
import json
import mimetypes
import os
import socket
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STUDIO_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(STUDIO_DIR))

from core import auth, config, fsutil, jsonservice, logservice, registry as registry_mod  # noqa: E402
from core.version import __version__ as STUDIO_VERSION  # noqa: E402

WEB_DIR = STUDIO_DIR / "web"
MAX_BODY = 12 * 1024 * 1024
SESSION_COOKIE = "studio_session"
PUBLIC_API = {
    "/api/health",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/me",
}
_current_user = threading.local()
STATIC_PREFIXES = {
    "/css/": WEB_DIR / "css",
    "/js/": WEB_DIR / "js",
    "/img/": WEB_DIR / "img",
}

REGISTRY = registry_mod.load_plugins()


class ApiResult:
    """接口返回值 + 需要额外设置的响应头（例如登录时的 Set-Cookie）。"""

    __slots__ = ("data", "headers", "status")

    def __init__(self, data, headers=None, status: int = 200):
        self.data = data
        self.headers = headers or {}
        self.status = status


# --------------------------------------------------------------------------- #
# 接口实现
# --------------------------------------------------------------------------- #
def api_bootstrap(query, body):
    return {
        "roots": {
            "json": config.roots_of("json"),
            "logs": config.roots_of("logs"),
        },
        "limits": config.limits(),
        "ui": config.ui_settings(),
        "env": config.environment_info(),
        "plugins": {"views": REGISTRY.views, "errors": REGISTRY.errors},
        "version": STUDIO_VERSION,
    }


def api_json_list(query, body):
    root_id = query.get("root", "main")
    return {"root": root_id, "files": jsonservice.list_files(root_id)}


def api_json_get(query, body):
    return jsonservice.get_file(query.get("root", "main"), query.get("name", ""))


def api_json_validate(query, body):
    return jsonservice.validate_text((body or {}).get("text", ""))


def api_json_save(query, body):
    body = body or {}
    return jsonservice.save_file(
        body.get("root", "main"),
        body.get("name", ""),
        body.get("text", ""),
        body.get("expectedMtime"),
        bool(body.get("force")),
    )


def api_json_restore(query, body):
    body = body or {}
    return jsonservice.restore_backup(body.get("root", "main"), body.get("name", ""),
                                      body.get("backupId", ""))


def api_json_diff(query, body):
    return jsonservice.diff_with_backup(query.get("root", "main"), query.get("name", ""),
                                        query.get("backup", ""))


def api_log_list(query, body):
    root_id = query.get("root", "logs")
    return {"root": root_id, "files": logservice.list_files(root_id)}


def api_log_get(query, body):
    return logservice.get_file(query.get("root", "logs"), query.get("name", ""))


def api_log_summary(query, body):
    root_id = query.get("root", "logs")
    return {"root": root_id, "summary": logservice.summarize(root_id)}


def api_health(query, body):
    return {"ok": True, "time": time.time(), "pid": os.getpid()}


# --------------------------------------------------------------------------- #
# 登录相关
# --------------------------------------------------------------------------- #
def _cookie_value(header: str, name: str) -> str:
    for part in (header or "").split(";"):
        key, _, value = part.strip().partition("=")
        if key == name:
            return value
    return ""


def _session_cookie(token: str, max_age: int | None = None) -> str:
    """会话 Cookie：不设 Max-Age，关闭浏览器即失效。"""
    base = f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict"
    return base if max_age is None else f"{base}; Max-Age={max_age}"


def api_auth_me(query, body):
    username = getattr(_current_user, "user", None)
    initial = auth.is_initial_password()
    if not username:
        return {"authenticated": False, "initialPassword": initial}
    return {"authenticated": True, "user": auth.user_info(username), "initialPassword": initial}


def api_auth_login(query, body):
    body = body or {}
    info = auth.authenticate(body.get("username", ""), body.get("password", ""))
    token = auth.create_session(info["username"])
    return ApiResult(
        {"authenticated": True, "user": info, "initialPassword": auth.is_initial_password()},
        headers={"Set-Cookie": _session_cookie(token)},
    )


def api_auth_logout(query, body):
    auth.drop_session(getattr(_current_user, "token", ""))
    return ApiResult({"authenticated": False}, headers={"Set-Cookie": _session_cookie("", 0)})


def api_auth_password(query, body):
    body = body or {}
    username = getattr(_current_user, "user", None)
    if not username:
        raise auth.AuthError("请先登录", 401)
    auth.change_password(username, body.get("oldPassword", ""), body.get("newPassword", ""))
    auth.drop_user_sessions(username, keep_token=getattr(_current_user, "token", ""))
    return {"ok": True, "user": auth.user_info(username)}


GET_ROUTES = {
    "/api/health": api_health,
    "/api/auth/me": api_auth_me,
    "/api/bootstrap": api_bootstrap,
    "/api/json/list": api_json_list,
    "/api/json/get": api_json_get,
    "/api/json/diff": api_json_diff,
    "/api/log/list": api_log_list,
    "/api/log/get": api_log_get,
    "/api/log/summary": api_log_summary,
}
POST_ROUTES = {
    "/api/auth/login": api_auth_login,
    "/api/auth/logout": api_auth_logout,
    "/api/auth/password": api_auth_password,
    "/api/json/save": api_json_save,
    "/api/json/validate": api_json_validate,
    "/api/json/restore": api_json_restore,
}


# --------------------------------------------------------------------------- #
# HTTP 层
# --------------------------------------------------------------------------- #
class StudioServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        """浏览器刷新、预连接被重置属于正常现象，不要把 traceback 打到控制台吓人。"""
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError, TimeoutError, socket.timeout)):
            return
        super().handle_error(request, client_address)


class StudioHandler(BaseHTTPRequestHandler):
    server_version = "Studio/1.0"
    protocol_version = "HTTP/1.1"

    # 让控制台安静一点，只保留错误
    def log_message(self, fmt, *args):  # noqa: A003
        if self.command in ("GET", "POST") and str(args[1] if len(args) > 1 else "") == "200":
            return
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---------------- 工具方法 ----------------
    def _send(self, status: int, payload: bytes, content_type: str, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_json(self, status: int, data, extra_headers=None):
        body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", extra_headers)

    def send_error_json(self, status: int, message: str, detail=None):
        payload = {"ok": False, "error": message}
        if detail is not None:
            payload["detail"] = detail
        self.send_json(status, payload)

    def _host_allowed(self) -> bool:
        host = (self.headers.get("Host") or "").strip().lower()
        if not host:
            return True
        name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
        return name in {"127.0.0.1", "localhost", "[::1]"}

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        if not raw.strip():
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"请求体不是合法 JSON：{exc.msg}") from exc

    # ---------------- 路由 ----------------
    def do_GET(self):  # noqa: N802
        self._handle("GET")

    def do_HEAD(self):  # noqa: N802
        self._handle("GET")

    def do_POST(self):  # noqa: N802
        self._handle("POST")

    def do_OPTIONS(self):  # noqa: N802
        self._send(204, b"", "text/plain", {"Allow": "GET, POST, HEAD, OPTIONS"})

    def _handle(self, method: str):
        started = time.time()
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        try:
            if not self._host_allowed():
                self.send_error_json(403, "仅允许通过本机地址访问")
                return
            if path.startswith("/api/"):
                self._handle_api(method, path, query)
            elif method == "GET":
                self._handle_static(path)
            else:
                self.send_error_json(405, "方法不允许")
        except BrokenPipeError:
            pass
        except Exception:  # 兜底，避免单个请求把进程带崩
            traceback.print_exc()
            try:
                self.send_error_json(500, "服务内部错误，详见控制台日志")
            except Exception:
                pass
        finally:
            duration = (time.time() - started) * 1000
            if os.environ.get("STUDIO_VERBOSE"):
                sys.stderr.write(f"{method} {path} {duration:.0f}ms\n")

    def _handle_api(self, method: str, path: str, query: dict):
        handler = None
        body = {}
        if method == "POST":
            try:
                body = self._read_body()
            except ValueError as exc:
                self.send_error_json(400, str(exc))
                return
            handler = POST_ROUTES.get(path)
        else:
            handler = GET_ROUTES.get(path)

        if handler is None and REGISTRY.apis:
            handler = REGISTRY.apis.get((method, path))

        if handler is None:
            self.send_error_json(404, f"接口不存在：{path}")
            return

        # -------- 登录态 --------
        token = _cookie_value(self.headers.get("Cookie"), SESSION_COOKIE)
        session = auth.get_session(token) if token else None
        _current_user.token = token
        _current_user.user = session["username"] if session else None
        if path not in PUBLIC_API and not session:
            self.send_error_json(401, "请先登录后再使用", {"code": "unauthorized"})
            return

        try:
            data = handler(query, body) if method == "POST" else handler(query, {})
        except auth.AuthError as exc:
            self.send_error_json(exc.status, str(exc), {"code": "auth"})
        except jsonservice.ConflictError as exc:
            self.send_error_json(409, str(exc))
        except jsonservice.InvalidJson as exc:
            self.send_json(422, {"ok": False, "error": "JSON 语法不合法，已阻止保存",
                                 "detail": exc.result})
        except fsutil.PathRejected as exc:
            self.send_error_json(403, str(exc))
        except FileNotFoundError as exc:
            self.send_error_json(404, str(exc))
        except PermissionError as exc:
            self.send_error_json(403, f"没有读写权限：{exc}")
        except ValueError as exc:
            self.send_error_json(400, str(exc))
        else:
            if isinstance(data, ApiResult):
                self.send_json(data.status, {"ok": True, "data": data.data}, data.headers)
            else:
                self.send_json(200, {"ok": True, "data": data})

    def _handle_static(self, path: str):
        if path in ("/", "/index.html"):
            target = WEB_DIR / "index.html"
        elif path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
            return
        else:
            target = None
            for prefix, directory in STATIC_PREFIXES.items():
                if path.startswith(prefix):
                    rel = path[len(prefix):]
                    candidate = (directory / rel).resolve()
                    try:
                        candidate.relative_to(directory.resolve())
                    except ValueError:
                        self.send_error_json(403, "路径越权")
                        return
                    target = candidate
                    break
            if target is None:
                self.send_error_json(404, "文件不存在")
                return
        if not target.is_file():
            self.send_error_json(404, f"文件不存在：{path}")
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith(("text/", "application/javascript", "application/json")):
            ctype += "; charset=utf-8"
        data = target.read_bytes()
        cache = "no-cache" if target.name.endswith(".html") else "public, max-age=60"
        self._send(200, data, ctype, {"Cache-Control": cache})


# --------------------------------------------------------------------------- #
# 启动
# --------------------------------------------------------------------------- #
def pick_port(host: str, preferred: int, span: int) -> int:
    for offset in range(span):
        port = preferred + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise SystemExit(f"端口 {preferred}~{preferred + span - 1} 均被占用，请修改 studio.config.json")


def main(argv=None) -> int:
    # 控制台编码兜底：老式 cmd 代码页下也不至于因为个别字符直接崩掉
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass

    srv = config.server_settings()
    parser = argparse.ArgumentParser(description="JSON & 日志工作台")
    parser.add_argument("--port", type=int, default=srv["port"])
    parser.add_argument("--host", default=srv["host"])
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--reset-password", action="store_true",
                        help="重置管理员 admin 的登录密码后退出")
    args = parser.parse_args(argv)

    if args.reset_password:
        print("\n  重置管理员密码（账号 admin）")
        first = getpass.getpass("  新密码: ")
        second = getpass.getpass("  再输一次: ")
        if first != second:
            print("  两次输入不一致，未做修改。")
            return 1
        try:
            auth.reset_password(first)
        except auth.AuthError as exc:
            print(f"  失败：{exc}")
            return 1
        print("  已重置，请用新密码登录。\n")
        return 0

    port = pick_port(args.host, args.port, srv["portSearchRange"])
    url = f"http://{args.host}:{port}/"

    httpd = StudioServer((args.host, port), StudioHandler)

    json_roots = config.roots_of("json")
    log_roots = config.roots_of("logs")
    line = "=" * 62
    banner = [
        "",
        f"  +{line}+",
        f"  |            JSON & 日志工作台   Studio {STUDIO_VERSION}                  |",
        f"  +{line}+",
        f"   访问地址 : {url}",
        f"   工作目录 : {STUDIO_DIR}",
        f"   登录账号 : {auth.DEFAULT_USER}"
        + ("   （初始密码 Admin12345，建议登录后修改）" if auth.is_initial_password() else ""),
    ]
    for root in json_roots:
        flag = "OK " if root["exists"] else "缺失"
        banner.append(f"   [{flag}] JSON  {root['label']}  →  {root['path']}")
    for root in log_roots:
        flag = "OK " if root["exists"] else "缺失"
        banner.append(f"   [{flag}] 日志  {root['label']}  →  {root['path']}")
    for err in REGISTRY.errors:
        banner.append(f"   [插件失败] {err['file']}: {err['error']}")
    banner += ["", "   关闭此窗口即停止服务（或按 Ctrl+C）", ""]
    print("\n".join(banner), flush=True)

    if srv["openBrowser"] and not args.no_browser:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止服务。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
