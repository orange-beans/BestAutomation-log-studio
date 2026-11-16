"""自测脚本：不依赖网络，直接调用后端服务层。

用法（在 studio 目录下）：
    py tests/selftest.py
退出码 0 表示全部通过。
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# 控制台是 GBK 时，个别符号（如 ✓）会让 print 抛 UnicodeEncodeError；
# 统一用替换模式，保证测试结果能正常打印、退出码正确。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:
        pass

STUDIO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(STUDIO_DIR))

# 认证测试用独立的账号文件，避免弄脏真实配置（必须在导入 core.auth 之前设置）
_AUTH_TMP = STUDIO_DIR / "tests" / "tmp"
_AUTH_TMP.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("STUDIO_AUTH_FILE", str(_AUTH_TMP / "auth-test.json"))

FAILED = []
PASSED = 0


def check(name: str, condition: bool, detail: str = ""):
    global PASSED
    if condition:
        PASSED += 1
        print(f"  [ok]   {name}")
    else:
        FAILED.append(name)
        print(f"  [FAIL] {name}  {detail}")


def test_linter():
    from core import jsonlint
    cases = [
        ("合法对象", '{"a": 1, "b": [1, 2, {}]}', True, ""),
        ("合法数组", '[1, "x", true, null]', True, ""),
        ("尾随逗号", '{"a": 1,}', False, "trailing-comma"),
        ("数组尾随逗号", '[1, 2,]', False, "trailing-comma"),
        ("缺少逗号", '{"a": 1 "b": 2}', False, "missing-comma"),
        ("字符串未闭合", '{"a": "abc}', False, "unclosed-string"),
        ("注释", '{ // hi\n "a": 1}', False, "comment"),
        ("单引号", "{'a': 1}", False, "single-quote"),
        ("键名无引号", "{a: 1}", False, "expected-key"),
        ("前导零", '{"a": 01}', False, "leading-zero"),
        ("空文件", "", False, "empty"),
        ("全角冒号", '{"a"：1}', False, "fullwidth"),
        ("NaN", '{"a": NaN}', False, "non-finite"),
        ("缺少闭合括号", '{"a": 1', False, "unclosed-object"),
        ("多余闭合", '{"a": 1}}', False, "extra-bracket"),
        ("重复键(仅警告)", '{"a":1,"a":2}', True, ""),
        ("嵌套合法", '{"a":{"b":[{"c":1}]}}', True, ""),
        ("转义合法", '{"a": "line\\nbreak \\u4e2d"}', True, ""),
        ("错误转义", '{"a": "\\q"}', False, "bad-escape"),
    ]
    print("\n[lint] 语法校验")
    for name, text, expect_valid, expect_code in cases:
        result = jsonlint.validate(text)
        check(name, result["valid"] is expect_valid,
              f"期望 valid={expect_valid}，实际 {result['valid']}，错误 {result['errors']}")
        if expect_code and not expect_valid:
            code = result["errors"][0]["code"] if result["errors"] else ""
            check(f"{name} · 错误码 {expect_code}", code == expect_code, f"实际 {code}")
    dup = jsonlint.validate('{"a":1,"a":2}')
    check("重复键给出警告", len(dup["warnings"]) == 1 and dup["warnings"][0]["code"] == "duplicate-key")
    err = jsonlint.validate('{\n  "a": 1\n  "b": 2\n}')["errors"][0]
    check("错误定位到第 3 行", err["line"] == 3, f"实际 {err['line']}")
    check("错误列号合理", err["col"] >= 2, f"实际 {err['col']}")


def test_roundtrip():
    """保存必须保留编码 / 换行 / BOM / 结尾换行。"""
    from core import config, fsutil, jsonservice

    print("\n[save] 编码与换行保真")
    tmp = Path(__file__).resolve().parent / "tmp"
    tmp.mkdir(exist_ok=True)
    backup_root = STUDIO_DIR / ".tool-backups" / "test"
    backup_root.mkdir(parents=True, exist_ok=True)
    for old in backup_root.glob("*.bak"):
        old.unlink(missing_ok=True)
    os.environ["STUDIO_ROOT_TEST"] = str(tmp)
    config.ROOTS["test"] = {
        "id": "test", "kind": "json", "label": "test", "desc": "",
        "path": str(tmp), "relPath": ".", "pattern": "*.json",
        "exists": True, "readonly": False,
    }
    samples = {
        "crlf.json": b'{\r\n  "a": 1\r\n}\r\n',
        "lf.json": b'{\n\t"a": 1\n}\n',
        "bom.json": b'\xef\xbb\xbf{\n  "a": 1\n}\n',
        "noeol.json": b'{\n  "a": 1\n}',
    }
    for name, data in samples.items():
        (tmp / name).write_bytes(data)

    for name, data in samples.items():
        cfg = config.root_by_id("test")
        payload = fsutil.read_text_file(Path(cfg["path"]) / name, 1 << 20)
        text = payload["text"].replace('"a": 1', '"a": 2')
        jsonservice.save_file("test", name, text)
        after = (tmp / name).read_bytes()
        if name == "crlf.json":
            check("CRLF 保留", b"\r\n" in after and b"\n" not in after.replace(b"\r\n", b""),
                  repr(after))
        elif name == "lf.json":
            check("LF 保留 + Tab 缩进", after == b'{\n\t"a": 2\n}\n', repr(after))
        elif name == "bom.json":
            check("BOM 保留", after.startswith(b"\xef\xbb\xbf"), repr(after[:10]))
        elif name == "noeol.json":
            check("结尾无换行保留", not after.endswith(b"\n"), repr(after))
        check(f"{name} 内容已更新", b'"a": 2' in after)

    backups = fsutil.list_backups("test", "lf.json")
    check("保存前自动备份", len(backups) == 1, f"实际 {len(backups)}")
    if backups:
        original = fsutil.read_backup("test", "lf.json", backups[0]["id"])
        check("备份内容为修改前原文", '"a": 1' in original["text"], original["text"])

    print("\n[save] 非法内容拦截")
    try:
        jsonservice.save_file("test", "lf.json", '{"a": 1,}')
        check("非法 JSON 被拒绝", False, "竟然保存成功了")
    except jsonservice.InvalidJson as exc:
        check("非法 JSON 被拒绝", True)
        check("拒绝时返回错误位置", exc.result["errors"][0]["line"] > 0)

    print("\n[path] 安全边界")
    from core.fsutil import PathRejected
    for bad in ("../settings.json", "sub/x.json", "C:\\Windows\\x.json", "..\\a.json"):
        try:
            fsutil.resolve_file("test", bad)
            check(f"拒绝越权路径 {bad}", False)
        except PathRejected:
            check(f"拒绝越权路径 {bad}", True)


def test_auth():
    """登录模块：哈希、校验、锁定、会话、改密。"""
    print("\n[auth] 登录与账号")
    from core import auth

    path = auth.auth_file()
    if path.exists():
        path.unlink()

    store = auth.load_store()
    check("首次运行自动创建账号文件", path.is_file())
    check("默认账号为 admin", "admin" in store["users"])
    check("文件里不存明文密码", "Admin12345" not in path.read_text(encoding="utf-8"))
    check("初始密码标记为 true", auth.is_initial_password() is True)
    check("默认密码可登录", auth.verify("admin", "Admin12345"))
    check("错误密码被拒绝", not auth.verify("admin", "wrong"))
    check("不存在的用户被拒绝", not auth.verify("nobody", "Admin12345"))

    info = auth.authenticate("admin", "Admin12345")
    check("登录返回用户信息", info["username"] == "admin")

    token = auth.create_session("admin")
    session = auth.get_session(token)
    check("会话可查询", session and session["username"] == "admin")
    check("伪造令牌无效", auth.get_session("bogus") is None)
    auth.drop_session(token)
    check("退出后会话失效", auth.get_session(token) is None)

    # 改密码
    bad = None
    try:
        auth.change_password("admin", "wrong-old", "NewPass123")
    except auth.AuthError as exc:
        bad = exc
    check("原密码错误时拒绝改密", bad is not None)

    short = None
    try:
        auth.set_password("admin", "123")
    except auth.AuthError as exc:
        short = exc
    check("过短密码被拒绝", short is not None)

    digits = None
    try:
        auth.set_password("admin", "12345678")
    except auth.AuthError as exc:
        digits = exc
    check("纯数字密码被拒绝", digits is not None)

    auth.change_password("admin", "Admin12345", "NewPass123")
    check("新密码可登录", auth.verify("admin", "NewPass123"))
    check("旧密码已失效", not auth.verify("admin", "Admin12345"))
    check("改密后清除初始标记", auth.is_initial_password() is False)

    # 连续失败锁定（放在最后，避免影响前面的用例）
    auth._failures["count"] = 0
    auth._failures["locked_until"] = 0.0
    locked = False
    for _ in range(5):
        try:
            auth.authenticate("admin", "bad-password")
        except auth.AuthError as exc:
            if exc.status == 429:
                locked = True
    check("连续 5 次失败后锁定", locked)
    check("锁定时剩余秒数为正", auth.locked_seconds() > 0)

    # 解锁并恢复默认密码，方便后续用例
    auth._failures["count"] = 0
    auth._failures["locked_until"] = 0.0
    auth.reset_password("Admin12345")
    check("重置后可用新密码登录", auth.verify("admin", "Admin12345"))


def test_real_data():
    """真实目录的读取回归（只读，不写任何文件）。"""
    print("\n[real] 真实数据读取")
    from core import config, jsonservice, logservice

    roots = [r for r in config.roots_of("json") if r["exists"]]
    if not roots:
        print("  [skip] 未找到真实 JSON 目录（可设置 STUDIO_ROOT_MAIN 环境变量）")
        return
    for root in roots:
        files = jsonservice.list_files(root["id"])
        if not files:
            print(f"  [skip] {root['label']} 目录里没有 JSON 文件：{root['path']}")
            continue
        bad = [f for f in files if f.get("valid") is False]
        check(f"{root['label']} 列出 {len(files)} 个文件", len(files) > 0)
        check(f"{root['label']} 全部语法合法", not bad, str(bad))
        for f in files[:3]:
            payload = jsonservice.get_file(root["id"], f["name"])
            check(f"读取 {f['name']}", payload["lint"]["valid"],
                  str(payload["lint"]["errors"]))

    log_roots = [r for r in config.roots_of("logs") if r["exists"]]
    if not log_roots:
        print("  [skip] 未找到真实日志目录（可设置 STUDIO_ROOT_LOGS 环境变量）")
        return
    for root in log_roots:
        files = logservice.list_files(root["id"])
        if not files:
            print(f"  [skip] {root['label']} 目录里没有日志文件：{root['path']}")
            continue
        check(f"{root['label']} 列出 {len(files)} 个日志", len(files) > 0)
        if files:
            payload = logservice.get_file(root["id"], files[0]["name"])
            check(f"读取日志 {files[0]['name']}", len(payload["text"]) > 0)
            check("日志行数统计", payload["lines"] >= 1, f"实际 {payload['lines']}")


def main() -> int:
    print("=" * 62)
    print("  Studio 自测")
    print("=" * 62)
    test_linter()
    test_roundtrip()
    test_auth()
    test_real_data()
    print("\n" + "=" * 62)
    print(f"  通过 {PASSED} 项，失败 {len(FAILED)} 项")
    if FAILED:
        for name in FAILED:
            print(f"   - {name}")
        return 1
    print("  全部通过 [OK]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
