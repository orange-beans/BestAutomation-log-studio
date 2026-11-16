"""自研 JSON 校验器。

相比标准库 json 的优势：
- 报错带精确的 行/列 偏移，并给出中文原因与修复建议；
- 能识别"尾随逗号""缺少逗号""字符串未闭合""注释""全角标点"
  "NaN / Infinity""前导零"等常见手写错误，并指出期望内容；
- 重复键作为**警告**（不阻止保存）单独返回，附键路径。

返回值结构（前后端一致）：
{
  "valid": bool,
  "errors":  [{line, col, offset, msg, code, hint, snippet}],
  "warnings":[{line, col, offset, msg, code, hint, path}],
  "stats":   {type, keys, depth, lines, chars}
}
"""

from __future__ import annotations

import json

WHITESPACE = " \t\n\r"
PUNCT = "{}[],:"


class LintError(Exception):
    def __init__(self, offset: int, msg: str, code: str, hint: str = ""):
        super().__init__(msg)
        self.offset = offset
        self.msg = msg
        self.code = code
        self.hint = hint


def _line_index(text: str) -> list[int]:
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)
    return starts


def _pos(text: str, offset: int, starts: list[int]) -> tuple[int, int]:
    offset = max(0, min(offset, len(text)))
    lo, hi = 0, len(starts) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if starts[mid] <= offset:
            lo = mid
        else:
            hi = mid - 1
    return lo + 1, offset - starts[lo] + 1


def _snippet(text: str, offset: int, starts: list[int], radius: int = 1) -> str:
    line_no, _ = _pos(text, offset, starts)
    lines = text.split("\n")
    lo = max(0, line_no - 1 - radius)
    hi = min(len(lines), line_no + radius)
    return "\n".join(lines[lo:hi])


class Parser:
    def __init__(self, text: str):
        self.text = text
        self.i = 0
        self.n = len(text)
        self.starts = _line_index(text)
        self.keys = 0
        self.depth = 0
        self.max_depth = 0
        self.warnings: list[dict] = []

    # ---------- 基础工具 ----------
    def error(self, offset: int, msg: str, code: str, hint: str = "") -> LintError:
        return LintError(offset, msg, code, hint)

    def peek(self) -> str:
        return self.text[self.i] if self.i < self.n else ""

    def skip_ws(self) -> None:
        while self.i < self.n and self.text[self.i] in WHITESPACE:
            self.i += 1

    def warn(self, offset: int, msg: str, code: str, hint: str = "", path: str = "") -> None:
        line, col = _pos(self.text, offset, self.starts)
        self.warnings.append({
            "line": line, "col": col, "offset": offset,
            "msg": msg, "code": code, "hint": hint, "path": path,
        })

    # ---------- 主入口 ----------
    def parse(self):
        if self.text.startswith("\ufeff"):
            self.warn(0, "文件开头存在 BOM 标记", "bom", "保存时会自动移除，不影响设备读取")
            self.i = 1
        self.skip_ws()
        if self.i >= self.n:
            raise self.error(0, "文件内容为空", "empty", "至少需要包含 {} 或 []")
        value = self.parse_value("$")
        self.skip_ws()
        if self.i < self.n:
            ch = self.text[self.i]
            if ch == ",":
                raise self.error(self.i, "根节点之后出现多余的逗号", "extra-comma", "删除该逗号")
            if ch in "]}":
                raise self.error(self.i, f"多余的闭合符号 “{ch}”", "extra-bracket", "检查括号是否配对")
            raise self.error(self.i, f"根节点之后出现无法识别的内容 “{self.char_desc(ch)}”", "trailing-content",
                             "一个 JSON 文件只能有一个顶层值")
        return value

    # ---------- 值 ----------
    def parse_value(self, path: str):
        self.skip_ws()
        if self.i >= self.n:
            raise self.error(self.n, "内容意外结束", "unexpected-eof",
                             "缺少一个值，或括号没有闭合")
        ch = self.text[self.i]
        if ch == "{":
            return self.parse_object(path)
        if ch == "[":
            return self.parse_array(path)
        if ch == '"':
            return self.parse_string()
        if ch == "'":
            raise self.error(self.i, "JSON 不支持单引号字符串", "single-quote",
                             "把 'text' 改成 \"text\"")
        if ch == "/":
            self.check_comment()
            raise self.error(self.i, "JSON 不支持注释", "comment", "删除 // 或 /* */ 注释")
        if ch in "-0123456789":
            return self.parse_number()
        if self.text.startswith("true", self.i):
            self.i += 4
            return True
        if self.text.startswith("false", self.i):
            self.i += 5
            return False
        if self.text.startswith("null", self.i):
            self.i += 4
            return None
        if self.text.startswith(("NaN", "Infinity", "-Infinity"), self.i):
            raise self.error(self.i, "JSON 不支持 NaN / Infinity", "non-finite",
                             "改用字符串表示，或写成具体数值")
        if ch in "，：；":
            raise self.error(self.i, f"出现全角标点 “{ch}”", "fullwidth",
                             "请使用半角 , : ;")
        raise self.error(self.i, f"无法识别的字符 “{self.char_desc(ch)}”", "unexpected-char",
                         "检查是否缺少引号或逗号")

    def char_desc(self, ch: str) -> str:
        code = ord(ch)
        if code < 32:
            return f"\\u{code:04x}"
        return ch

    def parse_object(self, path: str):
        self.i += 1  # {
        self.depth += 1
        self.max_depth = max(self.max_depth, self.depth)
        result: dict = {}
        seen: dict[str, int] = {}
        self.skip_ws()
        if self.peek() == "}":
            self.i += 1
            self.depth -= 1
            return result
        while True:
            self.skip_ws()
            if self.i >= self.n:
                raise self.error(self.i, "对象没有闭合", "unclosed-object",
                                 "缺少 }，或某个成员的值不完整")
            ch = self.peek()
            if ch == "}":
                raise self.error(self.i, "对象中出现多余的逗号", "trailing-comma",
                                 "删除最后一个成员后面的逗号")
            if ch != '"':
                if ch == "'":
                    raise self.error(self.i, "键名必须使用双引号", "single-quote",
                                     "把键名的单引号改成双引号")
                if ch == "/" and (self.text.startswith("//", self.i) or self.text.startswith("/*", self.i)):
                    raise self.error(self.i, "JSON 不支持注释", "comment", "删除 // 或 /* */ 注释")
                if ch in "}]":
                    raise self.error(self.i, "这里应当是一个用双引号包裹的键名", "expected-key",
                                     "删除多余的符号，或补上键名")
                raise self.error(self.i, f"键名必须用双引号包裹，这里是 “{self.char_desc(ch)}”", "expected-key",
                                 '例如 "name": "value"')
            key_start = self.i
            key = self.parse_string()
            key_line = _pos(self.text, key_start, self.starts)[0]
            if key in seen:
                self.warn(key_start, f"重复的键 “{key}”（第 {seen[key]} 行已出现）",
                          "duplicate-key", "后出现的值会覆盖前一个，建议删除其中一个",
                          path=path + "." + key)
            seen[key] = key_line
            self.keys += 1
            self.skip_ws()
            if self.i >= self.n:
                raise self.error(self.i, "键名之后缺少冒号与值", "unexpected-eof", "补上 : 值")
            if self.peek() != ":":
                ch = self.peek()
                if ch in "，；：":
                    raise self.error(self.i, f"使用了全角符号 “{ch}”", "fullwidth", "改成半角 :")
                raise self.error(self.i, f"键名之后应当是冒号，实际是 “{self.char_desc(ch)}”", "expected-colon",
                                 '格式为 "键": 值')
            self.i += 1
            result[key] = self.parse_value(path + "." + key)
            self.skip_ws()
            if self.i >= self.n:
                raise self.error(self.i, "对象没有闭合", "unclosed-object", "缺少 }")
            ch = self.peek()
            if ch == ",":
                self.i += 1
                continue
            if ch == "}":
                self.i += 1
                self.depth -= 1
                return result
            if ch == '"':
                raise self.error(self.i, "两个成员之间缺少逗号", "missing-comma",
                                 "在上一个成员的右引号后加 ,")
            if ch in "]}":
                raise self.error(self.i, f"成员之间出现多余的符号 “{ch}”", "unexpected-bracket",
                                 "检查逗号与括号是否配对")
            raise self.error(self.i, f"成员之间缺少逗号，这里是 “{self.char_desc(ch)}”", "missing-comma",
                             "成员之间用 , 分隔")

    def parse_array(self, path: str):
        self.i += 1  # [
        self.depth += 1
        self.max_depth = max(self.max_depth, self.depth)
        result: list = []
        self.skip_ws()
        if self.peek() == "]":
            self.i += 1
            self.depth -= 1
            return result
        index = 0
        while True:
            self.skip_ws()
            if self.i >= self.n:
                raise self.error(self.i, "数组没有闭合", "unclosed-array", "缺少 ]")
            if self.peek() == "]":
                raise self.error(self.i, "数组中出现多余的逗号", "trailing-comma",
                                 "删除最后一个元素后面的逗号")
            result.append(self.parse_value(f"{path}[{index}]"))
            index += 1
            self.skip_ws()
            if self.i >= self.n:
                raise self.error(self.i, "数组没有闭合", "unclosed-array", "缺少 ]")
            ch = self.peek()
            if ch == ",":
                self.i += 1
                continue
            if ch == "]":
                self.i += 1
                self.depth -= 1
                return result
            if ch in "{[\"'":
                raise self.error(self.i, "两个元素之间缺少逗号", "missing-comma",
                                 "在上一个元素之后加 ,")
            raise self.error(self.i, f"数组元素之间缺少逗号，这里是 “{self.char_desc(ch)}”", "missing-comma",
                             "元素之间用 , 分隔")

    def parse_string(self) -> str:
        start = self.i
        self.i += 1
        buf: list[str] = []
        while self.i < self.n:
            ch = self.text[self.i]
            if ch == '"':
                self.i += 1
                return "".join(buf)
            if ch == "\\":
                self.i += 1
                if self.i >= self.n:
                    break
                esc = self.text[self.i]
                mapping = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f",
                           "n": "\n", "r": "\r", "t": "\t"}
                if esc == "u":
                    hexpart = self.text[self.i + 1: self.i + 5]
                    if len(hexpart) < 4 or any(c not in "0123456789abcdefABCDEF" for c in hexpart):
                        raise self.error(self.i, "\\u 转义后面必须是 4 位十六进制数", "bad-escape",
                                         "例如 \\u4e2d")
                    buf.append(chr(int(hexpart, 16)))
                    self.i += 5
                    continue
                if esc not in mapping:
                    raise self.error(self.i, f"不支持的转义符 “\\{esc}”", "bad-escape",
                                     "合法的转义只有 \\\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX")
                buf.append(mapping[esc])
                self.i += 1
                continue
            if ch == "\n":
                raise self.error(start, "字符串未闭合", "unclosed-string",
                                 "字符串中不能直接换行；如需换行请写 \\n")
            if ord(ch) < 0x20:
                raise self.error(self.i, "字符串中包含未转义的控制字符", "control-char",
                                 "请写成 \\n、\\t 或 \\u00XX")
            buf.append(ch)
            self.i += 1
        raise self.error(start, "字符串未闭合", "unclosed-string", "缺少结尾的双引号")

    def parse_number(self):
        start = self.i
        if self.text[self.i] == "-":
            self.i += 1
        if self.i < self.n and self.text[self.i] == "0":
            self.i += 1
            if self.i < self.n and self.text[self.i].isdigit():
                raise self.error(start, "数字不能有多余的前导零", "leading-zero",
                                 "把 0123 改成 123 或字符串 \"0123\"")
        else:
            digits_start = self.i
            while self.i < self.n and self.text[self.i].isdigit():
                self.i += 1
            if self.i == digits_start:
                raise self.error(start, "数字格式不正确", "bad-number", "例如 0、12、-3.5、1e-6")
        if self.i < self.n and self.text[self.i] == ".":
            self.i += 1
            frac = self.i
            while self.i < self.n and self.text[self.i].isdigit():
                self.i += 1
            if self.i == frac:
                raise self.error(start, "小数点后缺少数字", "bad-number", "例如 3.0")
        if self.i < self.n and self.text[self.i] in "eE":
            self.i += 1
            if self.i < self.n and self.text[self.i] in "+-":
                self.i += 1
            exp = self.i
            while self.i < self.n and self.text[self.i].isdigit():
                self.i += 1
            if self.i == exp:
                raise self.error(start, "指数部分缺少数字", "bad-number", "例如 1e-6")
        raw = self.text[start:self.i]
        try:
            return int(raw)
        except ValueError:
            try:
                return float(raw)
            except ValueError:
                raise self.error(start, "数字格式不正确", "bad-number", "") from None

    def check_comment(self) -> None:
        if self.text.startswith("//", self.i) or self.text.startswith("/*", self.i):
            return


def validate(text: str) -> dict:
    """校验 JSON 文本，永远返回结构，不抛异常。"""
    parser = Parser(text)
    errors: list[dict] = []
    warnings: list[dict] = []
    stats = {
        "type": "",
        "keys": 0,
        "depth": 0,
        "lines": text.count("\n") + (0 if text.endswith("\n") else 1),
        "chars": len(text),
    }
    try:
        value = parser.parse()
        if isinstance(value, dict):
            stats["type"] = "object"
        elif isinstance(value, list):
            stats["type"] = "array"
        elif isinstance(value, str):
            stats["type"] = "string"
        elif isinstance(value, bool):
            stats["type"] = "boolean"
        elif value is None:
            stats["type"] = "null"
        else:
            stats["type"] = "number"
    except LintError as exc:
        line, col = _pos(text, exc.offset, parser.starts)
        errors.append({
            "line": line,
            "col": col,
            "offset": exc.offset,
            "msg": exc.msg,
            "code": exc.code,
            "hint": exc.hint,
            "snippet": _snippet(text, exc.offset, parser.starts),
        })
    except RecursionError:
        errors.append({
            "line": 1, "col": 1, "offset": 0,
            "msg": "嵌套层级过深", "code": "too-deep", "hint": "请简化结构", "snippet": "",
        })
    warnings.extend(parser.warnings)
    stats["keys"] = parser.keys
    stats["depth"] = parser.max_depth
    # 二次兜底：标准库确认（防止自研解析器漏判）
    if not errors:
        try:
            json.loads(text)
        except json.JSONDecodeError as exc:
            errors.append({
                "line": exc.lineno, "col": exc.colno, "offset": exc.pos,
                "msg": exc.msg, "code": "stdlib", "hint": "", "snippet": "",
            })
    return {"valid": not errors, "errors": errors, "warnings": warnings, "stats": stats}
