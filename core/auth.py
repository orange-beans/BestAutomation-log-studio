"""登录与账号管理（单机、单管理员）。

设计要点：
- 密码用 PBKDF2-HMAC-SHA256 + 随机盐 + 20 万次迭代存储，不存明文；
- 会话令牌只存在服务端内存，浏览器拿到的是 HttpOnly + SameSite=Strict 的**会话 Cookie**
  （不设 Max-Age，关掉浏览器即失效）；
- 默认账号 admin / Admin12345，首次运行自动写入 studio.auth.json，
  文件里带 initial 标记，改过密码后清除（界面据此提示"仍在用初始密码"）；
- 连续 5 次密码错误锁定 60 秒，避免被乱试。

边界说明：服务只监听 127.0.0.1，这层认证用于"防误入、防随手改"，
挡不住拥有本机管理员权限的人（他们可以直接读文件、改配置）。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime
from pathlib import Path

from . import config

DEFAULT_USER = "admin"
DEFAULT_PASSWORD = "Admin12345"
ITERATIONS = 200_000
SESSION_IDLE_SECONDS = 2 * 60 * 60
SESSION_MAX_SECONDS = 12 * 60 * 60
LOCK_AFTER_FAILURES = 5
LOCK_SECONDS = 60
MIN_PASSWORD_LENGTH = 6

_AUTH_FILE = Path(os.environ.get("STUDIO_AUTH_FILE") or (config.STUDIO_DIR / "studio.auth.json"))

_sessions: dict[str, dict] = {}
_failures = {"count": 0, "locked_until": 0.0}


class AuthError(Exception):
    """登录失败一类的问题，带 HTTP 语义。"""

    def __init__(self, message: str, status: int = 401):
        super().__init__(message)
        self.status = status


def auth_file() -> Path:
    return _AUTH_FILE


# --------------------------------------------------------------------------- #
# 存储
# --------------------------------------------------------------------------- #
def _hash_password(password: str, salt: str, iterations: int = ITERATIONS) -> str:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations)
    return digest.hex()


def _new_salt() -> str:
    return secrets.token_hex(16)


def _write_store(store: dict) -> None:
    path = auth_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _default_store() -> dict:
    salt = _new_salt()
    return {
        "version": 1,
        "initial": True,
        "users": {
            DEFAULT_USER: {
                "salt": salt,
                "hash": _hash_password(DEFAULT_PASSWORD, salt),
                "iterations": ITERATIONS,
                "updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
        },
    }


def load_store() -> dict:
    """读取账号文件；不存在就按默认账号生成一份。"""
    path = auth_file()
    if not path.is_file():
        store = _default_store()
        _write_store(store)
        return store
    try:
        store = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return _default_store()
    if not isinstance(store, dict) or not isinstance(store.get("users"), dict) or not store["users"]:
        return _default_store()
    return store


def _user_record(username: str):
    store = load_store()
    return store["users"].get((username or "").strip().lower())


# --------------------------------------------------------------------------- #
# 校验
# --------------------------------------------------------------------------- #
def is_initial_password() -> bool:
    return bool(load_store().get("initial"))


def verify(username: str, password: str) -> bool:
    record = _user_record(username)
    if not record:
        return False
    try:
        expected = record["hash"]
        iterations = int(record.get("iterations") or ITERATIONS)
        actual = _hash_password(password or "", record["salt"], iterations)
    except Exception:
        return False
    return hmac.compare_digest(actual, expected)


def locked_seconds() -> int:
    remain = _failures["locked_until"] - time.time()
    return max(0, int(round(remain)))


def authenticate(username: str, password: str) -> dict:
    """成功返回用户信息，失败抛 AuthError（带中文原因）。"""
    remain = locked_seconds()
    if remain > 0:
        raise AuthError(f"密码错误次数过多，请 {remain} 秒后再试", 429)

    if not (username or "").strip() or not (password or ""):
        raise AuthError("请输入用户名和密码", 400)

    if verify(username, password):
        _failures["count"] = 0
        _failures["locked_until"] = 0.0
        return user_info(username)

    _failures["count"] += 1
    if _failures["count"] >= LOCK_AFTER_FAILURES:
        _failures["locked_until"] = time.time() + LOCK_SECONDS
        _failures["count"] = 0
        raise AuthError(f"密码错误次数过多，请 {LOCK_SECONDS} 秒后再试", 429)
    raise AuthError("用户名或密码不正确", 401)


def user_info(username: str) -> dict:
    record = _user_record(username) or {}
    return {
        "username": (username or "").strip(),
        "updated": record.get("updated", ""),
        "initial": bool(load_store().get("initial")),
    }


# --------------------------------------------------------------------------- #
# 会话
# --------------------------------------------------------------------------- #
def create_session(username: str) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    _sessions[token] = {
        "username": (username or "").strip(),
        "created": now,
        "seen": now,
    }
    _prune_sessions()
    return token


def _prune_sessions() -> None:
    now = time.time()
    for token, item in list(_sessions.items()):
        if now - item["seen"] > SESSION_IDLE_SECONDS or now - item["created"] > SESSION_MAX_SECONDS:
            _sessions.pop(token, None)


def get_session(token: str) -> dict | None:
    if not token:
        return None
    item = _sessions.get(token)
    if not item:
        return None
    now = time.time()
    if now - item["seen"] > SESSION_IDLE_SECONDS or now - item["created"] > SESSION_MAX_SECONDS:
        _sessions.pop(token, None)
        return None
    item["seen"] = now
    return item


def drop_session(token: str) -> None:
    _sessions.pop(token or "", None)


def drop_user_sessions(username: str, keep_token: str = "") -> None:
    for token, item in list(_sessions.items()):
        if item["username"].lower() == (username or "").strip().lower() and token != keep_token:
            _sessions.pop(token, None)


# --------------------------------------------------------------------------- #
# 改密码 / 重置
# --------------------------------------------------------------------------- #
def set_password(username: str, new_password: str) -> None:
    validate_password(new_password)
    store = load_store()
    key = (username or "").strip().lower()
    if key not in store["users"]:
        raise AuthError(f"账号不存在：{username}", 404)
    salt = _new_salt()
    store["users"][key] = {
        "salt": salt,
        "hash": _hash_password(new_password, salt),
        "iterations": ITERATIONS,
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    store["initial"] = False
    _write_store(store)


def change_password(username: str, old_password: str, new_password: str) -> None:
    if not verify(username, old_password):
        raise AuthError("原密码不正确", 400)
    if old_password == new_password:
        raise AuthError("新密码不能与原密码相同", 400)
    set_password(username, new_password)


def validate_password(password: str) -> None:
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        raise AuthError(f"密码至少 {MIN_PASSWORD_LENGTH} 位", 400)
    if password.isdigit():
        raise AuthError("密码不能是纯数字", 400)


def reset_password(new_password: str) -> None:
    """命令行重置（忘记密码时用）。"""
    set_password(DEFAULT_USER, new_password)
    _sessions.clear()
