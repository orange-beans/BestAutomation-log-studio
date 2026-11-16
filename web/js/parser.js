/* ===========================================================================
   parser.js —— 带位置信息的 JSON 解析器
   与后端 jsonlint 保持同样的错误语义，但在浏览器里实时运行（无需请求）。
   产出 AST 保留每个节点的字符区间，供"结构视图直接改源码"使用。
   =========================================================================== */

const WS = new Set([' ', '\t', '\n', '\r']);

export class JsonError extends Error {
  constructor(offset, msg, code, hint = '') {
    super(msg);
    this.offset = offset;
    this.msg = msg;
    this.code = code;
    this.hint = hint;
  }
}

export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

export function offsetToPos(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo] + 1 };
}

class Parser {
  constructor(text) {
    this.text = text;
    this.n = text.length;
    this.i = 0;
    this.keys = 0;
    this.depth = 0;
    this.maxDepth = 0;
    this.warnings = [];
    this.starts = lineStarts(text);
  }

  parse() {
    if (this.text.charCodeAt(0) === 0xfeff) {
      this.warn(0, '文件开头存在 BOM 标记', 'bom', '保存时会自动移除，不影响设备读取');
      this.i = 1;
    }
    this.skipWs();
    if (this.i >= this.n) throw new JsonError(0, '文件内容为空', 'empty', '至少需要包含 {} 或 []');
    const root = this.parseValue(null, '$');
    this.skipWs();
    if (this.i < this.n) {
      const ch = this.text[this.i];
      if (ch === ',') throw new JsonError(this.i, '根节点之后出现多余的逗号', 'extra-comma', '删除该逗号');
      if (ch === ']' || ch === '}') throw new JsonError(this.i, `多余的闭合符号 “${ch}”`, 'extra-bracket', '检查括号是否配对');
      throw new JsonError(this.i, `根节点之后出现无法识别的内容 “${ch}”`, 'trailing-content', '一个 JSON 文件只能有一个顶层值');
    }
    return root;
  }

  peek() { return this.i < this.n ? this.text[this.i] : ''; }

  skipWs() { while (this.i < this.n && WS.has(this.text[this.i])) this.i += 1; }

  warn(offset, msg, code, hint = '', path = '') {
    const { line, col } = offsetToPos(this.starts, offset);
    this.warnings.push({ line, col, offset, msg, code, hint, path });
  }

  parseValue(parent, path) {
    this.skipWs();
    if (this.i >= this.n) throw new JsonError(this.n, '内容意外结束', 'unexpected-eof', '缺少一个值，或括号没有闭合');
    const ch = this.text[this.i];
    if (ch === '{') return this.parseObject(parent, path);
    if (ch === '[') return this.parseArray(parent, path);
    if (ch === '"') return this.parseStringNode(parent, path);
    if (ch === "'") throw new JsonError(this.i, 'JSON 不支持单引号字符串', 'single-quote', "把 'text' 改成 \"text\"");
    if (ch === '/') throw new JsonError(this.i, 'JSON 不支持注释', 'comment', '删除 // 或 /* */ 注释');
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.parseNumberNode(parent, path);
    if (this.text.startsWith('true', this.i)) {
      const node = { type: 'boolean', value: true, start: this.i, end: this.i + 4, raw: 'true', parent, path };
      this.i += 4;
      return node;
    }
    if (this.text.startsWith('false', this.i)) {
      const node = { type: 'boolean', value: false, start: this.i, end: this.i + 5, raw: 'false', parent, path };
      this.i += 5;
      return node;
    }
    if (this.text.startsWith('null', this.i)) {
      const node = { type: 'null', value: null, start: this.i, end: this.i + 4, raw: 'null', parent, path };
      this.i += 4;
      return node;
    }
    if (this.text.startsWith('NaN', this.i) || this.text.startsWith('Infinity', this.i)) {
      throw new JsonError(this.i, 'JSON 不支持 NaN / Infinity', 'non-finite', '改用字符串表示，或写成具体数值');
    }
    if ('，：；'.includes(ch)) throw new JsonError(this.i, `出现全角标点 “${ch}”`, 'fullwidth', '请使用半角 , : ;');
    throw new JsonError(this.i, `无法识别的字符 “${ch}”`, 'unexpected-char', '检查是否缺少引号或逗号');
  }

  parseObject(parent, path) {
    const start = this.i;
    this.i += 1;
    this.depth += 1;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    const node = { type: 'object', value: {}, start, end: start, children: [], parent, path };
    const seen = new Map();
    this.skipWs();
    if (this.peek() === '}') {
      this.i += 1;
      node.end = this.i;
      this.depth -= 1;
      return node;
    }
    for (;;) {
      this.skipWs();
      if (this.i >= this.n) throw new JsonError(this.i, '对象没有闭合', 'unclosed-object', '缺少 }，或某个成员的值不完整');
      const ch = this.peek();
      if (ch === '}') throw new JsonError(this.i, '对象中出现多余的逗号', 'trailing-comma', '删除最后一个成员后面的逗号');
      if (ch !== '"') {
        if (ch === "'") throw new JsonError(this.i, '键名必须使用双引号', 'single-quote', '把键名的单引号改成双引号');
        if (ch === '/' && (this.text.startsWith('//', this.i) || this.text.startsWith('/*', this.i))) {
          throw new JsonError(this.i, 'JSON 不支持注释', 'comment', '删除 // 或 /* */ 注释');
        }
        if (ch === ']' || ch === '}') throw new JsonError(this.i, '这里应当是一个用双引号包裹的键名', 'expected-key', '删除多余的符号，或补上键名');
        throw new JsonError(this.i, `键名必须用双引号包裹，这里是 “${ch}”`, 'expected-key', '例如 "name": "value"');
      }
      const keyStart = this.i;
      const key = this.parseString();
      const keyEnd = this.i;
      const keyLine = offsetToPos(this.starts, keyStart).line;
      if (seen.has(key)) {
        this.warn(keyStart, `重复的键 “${key}”（第 ${seen.get(key)} 行已出现）`, 'duplicate-key',
          '后出现的值会覆盖前一个，建议删除其中一个', `${path}.${key}`);
      }
      seen.set(key, keyLine);
      this.keys += 1;
      this.skipWs();
      if (this.i >= this.n) throw new JsonError(this.i, '键名之后缺少冒号与值', 'unexpected-eof', '补上 : 值');
      if (this.peek() !== ':') {
        const bad = this.peek();
        if ('，；：'.includes(bad)) throw new JsonError(this.i, `使用了全角符号 “${bad}”`, 'fullwidth', '改成半角 :');
        throw new JsonError(this.i, `键名之后应当是冒号，实际是 “${bad}”`, 'expected-colon', '格式为 "键": 值');
      }
      this.i += 1;
      const child = this.parseValue(node, `${path}.${key}`);
      child.key = key;
      child.keyStart = keyStart;
      child.keyEnd = keyEnd;
      node.children.push(child);
      this.skipWs();
      if (this.i >= this.n) throw new JsonError(this.i, '对象没有闭合', 'unclosed-object', '缺少 }');
      const next = this.peek();
      if (next === ',') { this.i += 1; continue; }
      if (next === '}') {
        this.i += 1;
        node.end = this.i;
        this.depth -= 1;
        return node;
      }
      if (next === '"') throw new JsonError(this.i, '两个成员之间缺少逗号', 'missing-comma', '在上一个成员的右引号后加 ,');
      if (next === ']' || next === '}') throw new JsonError(this.i, `成员之间出现多余的符号 “${next}”`, 'unexpected-bracket', '检查逗号与括号是否配对');
      throw new JsonError(this.i, `成员之间缺少逗号，这里是 “${next}”`, 'missing-comma', '成员之间用 , 分隔');
    }
  }

  parseArray(parent, path) {
    const start = this.i;
    this.i += 1;
    this.depth += 1;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    const node = { type: 'array', value: [], start, end: start, children: [], parent, path };
    this.skipWs();
    if (this.peek() === ']') {
      this.i += 1;
      node.end = this.i;
      this.depth -= 1;
      return node;
    }
    let index = 0;
    for (;;) {
      this.skipWs();
      if (this.i >= this.n) throw new JsonError(this.i, '数组没有闭合', 'unclosed-array', '缺少 ]');
      if (this.peek() === ']') throw new JsonError(this.i, '数组中出现多余的逗号', 'trailing-comma', '删除最后一个元素后面的逗号');
      const child = this.parseValue(node, `${path}[${index}]`);
      child.index = index;
      node.children.push(child);
      index += 1;
      this.skipWs();
      if (this.i >= this.n) throw new JsonError(this.i, '数组没有闭合', 'unclosed-array', '缺少 ]');
      const next = this.peek();
      if (next === ',') { this.i += 1; continue; }
      if (next === ']') {
        this.i += 1;
        node.end = this.i;
        this.depth -= 1;
        return node;
      }
      if ('{["\''.includes(next)) throw new JsonError(this.i, '两个元素之间缺少逗号', 'missing-comma', '在上一个元素之后加 ,');
      throw new JsonError(this.i, `数组元素之间缺少逗号，这里是 “${next}”`, 'missing-comma', '元素之间用 , 分隔');
    }
  }

  parseString() {
    const start = this.i;
    this.i += 1;
    let out = '';
    while (this.i < this.n) {
      const ch = this.text[this.i];
      if (ch === '"') { this.i += 1; return out; }
      if (ch === '\\') {
        this.i += 1;
        if (this.i >= this.n) break;
        const esc = this.text[this.i];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (esc === 'u') {
          const hex = this.text.slice(this.i + 1, this.i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new JsonError(this.i, '\\u 转义后面必须是 4 位十六进制数', 'bad-escape', '例如 \\u4e2d');
          }
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 5;
          continue;
        }
        if (!(esc in map)) {
          throw new JsonError(this.i, `不支持的转义符 “\\${esc}”`, 'bad-escape',
            '合法转义只有 \\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX');
        }
        out += map[esc];
        this.i += 1;
        continue;
      }
      if (ch === '\n') throw new JsonError(start, '字符串未闭合', 'unclosed-string', '字符串中不能直接换行；如需换行请写 \\n');
      if (ch.charCodeAt(0) < 0x20) {
        throw new JsonError(this.i, '字符串中包含未转义的控制字符', 'control-char', '请写成 \\n、\\t 或 \\u00XX');
      }
      out += ch;
      this.i += 1;
    }
    throw new JsonError(start, '字符串未闭合', 'unclosed-string', '缺少结尾的双引号');
  }

  parseStringNode(parent, path) {
    const start = this.i;
    const value = this.parseString();
    return { type: 'string', value, start, end: this.i, raw: this.text.slice(start, this.i), parent, path };
  }

  parseNumberNode(parent, path) {
    const start = this.i;
    if (this.text[this.i] === '-') this.i += 1;
    if (this.text[this.i] === '0') {
      this.i += 1;
      if (/\d/.test(this.text[this.i] || '')) {
        throw new JsonError(start, '数字不能有多余的前导零', 'leading-zero', '把 0123 改成 123 或字符串 "0123"');
      }
    } else {
      const digits = this.i;
      while (this.i < this.n && /\d/.test(this.text[this.i])) this.i += 1;
      if (this.i === digits) throw new JsonError(start, '数字格式不正确', 'bad-number', '例如 0、12、-3.5、1e-6');
    }
    if (this.text[this.i] === '.') {
      this.i += 1;
      const frac = this.i;
      while (this.i < this.n && /\d/.test(this.text[this.i])) this.i += 1;
      if (this.i === frac) throw new JsonError(start, '小数点后缺少数字', 'bad-number', '例如 3.0');
    }
    if (this.text[this.i] === 'e' || this.text[this.i] === 'E') {
      this.i += 1;
      if (this.text[this.i] === '+' || this.text[this.i] === '-') this.i += 1;
      const exp = this.i;
      while (this.i < this.n && /\d/.test(this.text[this.i])) this.i += 1;
      if (this.i === exp) throw new JsonError(start, '指数部分缺少数字', 'bad-number', '例如 1e-6');
    }
    const raw = this.text.slice(start, this.i);
    const value = Number(raw);
    return { type: 'number', value, start, end: this.i, raw, parent, path };
  }
}

/** 解析 JSON，永不抛异常。 */
export function parseJson(text) {
  const parser = new Parser(text);
  const result = {
    ok: false, errors: [], warnings: [], root: null,
    stats: { type: '', keys: 0, depth: 0, lines: text.split('\n').length, chars: text.length },
  };
  try {
    result.root = parser.parse();
    result.ok = true;
    result.stats.type = result.root.type;
  } catch (err) {
    const offset = err instanceof JsonError ? err.offset : 0;
    const { line, col } = offsetToPos(parser.starts, offset);
    result.errors.push({
      line, col, offset,
      msg: err.message,
      code: err.code || 'parse',
      hint: err.hint || '',
      snippet: snippetAt(text, line),
    });
  }
  result.warnings = parser.warnings;
  result.stats.keys = parser.keys;
  result.stats.depth = parser.maxDepth;
  return result;
}

function snippetAt(text, line, radius = 1) {
  const lines = text.split('\n');
  const from = Math.max(0, line - 1 - radius);
  const to = Math.min(lines.length, line + radius);
  return lines.slice(from, to).join('\n');
}

/** 按路径查找节点，例如 $.a[2].b */
export function nodeAtPath(root, path) {
  if (!root) return null;
  if (path === '$') return root;
  let node = root;
  const parts = path.replace(/^\$/, '').match(/\.([^.[\]]+)|\[(\d+)\]/g) || [];
  for (const part of parts) {
    if (part.startsWith('.')) {
      const key = part.slice(1);
      node = node.children.find((child) => child.key === key);
    } else {
      const index = Number(part.slice(1, -1));
      node = node.children[index];
    }
    if (!node) return null;
  }
  return node;
}

/** 统一缩进风格的格式化，标量保留原始写法（不丢精度、不改引号）。 */
export function formatJson(root, unit = '  ') {
  const pad = (depth) => unit.repeat(depth);
  const walk = (node, depth) => {
    if (node.type === 'object') {
      if (!node.children.length) return '{}';
      const inner = node.children.map((child) => {
        const key = JSON.stringify(child.key);
        return `${pad(depth + 1)}${key}: ${walk(child, depth + 1)}`;
      }).join(',\n');
      return `{\n${inner}\n${pad(depth)}}`;
    }
    if (node.type === 'array') {
      if (!node.children.length) return '[]';
      const inner = node.children.map((child) => `${pad(depth + 1)}${walk(child, depth + 1)}`).join(',\n');
      return `[\n${inner}\n${pad(depth)}]`;
    }
    return node.raw;
  };
  return walk(root, 0);
}

/** 把任意值转成 JSON 字面量（用于结构视图改值）。 */
export function valueToLiteral(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '0';
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value, null, 2);
}

/** 检测文本使用的缩进单位。 */
export function detectIndentUnit(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^([ \t]+)/);
    if (!m) break;
    if (m[1].startsWith('\t')) return '\t';
    if (m[1].length) return ' '.repeat(m[1].length);
    break;
  }
  return '  ';
}

/** 行级 diff（LCS），用于"与备份/磁盘对比"。 */
export function diffLines(leftText, rightText) {
  const left = leftText.split('\n');
  const right = rightText.split('\n');
  const maxCells = 4000000;
  if (left.length * right.length > maxCells) {
    return {
      tooLarge: true,
      ops: left.map((line, i) => ({ type: 'del', text: line, leftNo: i + 1, rightNo: null }))
        .concat(right.map((line, i) => ({ type: 'add', text: line, leftNo: null, rightNo: i + 1 }))),
    };
  }
  const dp = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      ops.push({ type: 'eq', text: left[i], leftNo: i + 1, rightNo: j + 1 });
      i += 1; j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: left[i], leftNo: i + 1, rightNo: null });
      i += 1;
    } else {
      ops.push({ type: 'add', text: right[j], leftNo: null, rightNo: j + 1 });
      j += 1;
    }
  }
  while (i < left.length) { ops.push({ type: 'del', text: left[i], leftNo: i + 1, rightNo: null }); i += 1; }
  while (j < right.length) { ops.push({ type: 'add', text: right[j], leftNo: null, rightNo: j + 1 }); j += 1; }

  // 折叠连续相同变更块，附上简短摘要
  return { ops, stats: summarizeDiff(ops) };
}

function summarizeDiff(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added += 1;
    else if (op.type === 'del') removed += 1;
  }
  return { added, removed };
}
