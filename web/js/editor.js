/* ===========================================================================
   editor.js —— 轻量代码编辑器（零依赖）
   textarea 负责输入与滚动，底层 <pre> 负责语法高亮，二者使用完全相同的
   字体/行高/内边距，因此逐行像素对齐；行号槽单独一列，仅跟随纵向滚动。
   =========================================================================== */

import { el, clear } from './core.js';
import { offsetToPos, lineStarts } from './parser.js';

const KEYWORDS = new Set(['true', 'false', 'null']);

export class CodeEditor {
  constructor(host, options = {}) {
    this.host = host;
    this.onChange = options.onChange || (() => {});
    this.onCursor = options.onCursor || (() => {});
    this.onSave = options.onSave || (() => {});
    this.indentUnit = options.indentUnit || '  ';
    this.readonly = false;
    this.errors = [];
    this.value = '';
    this.starts = [0];
    this._silent = false;

    this.textarea = el('textarea', {
      class: 'ce-input',
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      'aria-label': 'JSON 源码',
      wrap: 'off',
    });
    this.code = el('code');
    this.highlight = el('pre', { class: 'ce-hl', 'aria-hidden': 'true' }, [this.code]);
    this.main = el('div', { class: 'ce-main' }, [this.highlight, this.textarea]);
    this.gutterInner = el('div', { class: 'ce-gutter-inner' });
    this.gutter = el('div', { class: 'ce-gutter' }, [this.gutterInner]);
    this.currentLineBar = el('div', { class: 'ce-current-bar' });
    this.main.insertBefore(this.currentLineBar, this.highlight);
    this.root = el('div', { class: 'ce' }, [this.gutter, this.main]);
    clear(host).appendChild(this.root);

    this._bind();
    this._observe();
  }

  /* ------------------------------------------------------------ 事件 */
  _bind() {
    const ta = this.textarea;
    ta.addEventListener('input', () => {
      if (this._silent) return;
      this.value = ta.value;
      this._refresh(true);
      this.onChange(this.value);
    });
    ta.addEventListener('scroll', () => this._syncScroll(), { passive: true });
    ta.addEventListener('keydown', (event) => this._onKeyDown(event));
    for (const name of ['click', 'keyup', 'select']) {
      ta.addEventListener(name, () => this._refreshCursorOnly());
    }
    ta.addEventListener('blur', () => this._refreshCursorOnly());
  }

  _observe() {
    if (typeof ResizeObserver === 'undefined') return;
    this._resizeObserver = new ResizeObserver(() => {
      this._lineHeight = null;
      this._measure();
      this._renderGutter();
      this._renderHighlight();
      this._syncScroll();
    });
    this._resizeObserver.observe(this.host);
  }

  _measure() {
    if (this._lineHeight) return;
    const style = getComputedStyle(this.textarea);
    const parsed = parseFloat(style.lineHeight);
    this._lineHeight = Number.isFinite(parsed) ? parsed : parseFloat(style.fontSize) * 1.6;
    this._paddingTop = parseFloat(style.paddingTop) || 0;
    this.currentLineBar.style.height = `${this._lineHeight}px`;
    this.currentLineBar.style.top = `${this._paddingTop}px`;
  }

  _onKeyDown(event) {
    const ta = this.textarea;
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const { selectionStart: start, selectionEnd: end } = ta;
      if (start !== end && ta.value.slice(start, end).includes('\n')) {
        this._indentBlock(event.shiftKey);
        return;
      }
      if (event.shiftKey) {
        const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
        const line = ta.value.slice(lineStart, start);
        const removed = line.endsWith(this.indentUnit) ? this.indentUnit.length
          : (line.match(/[ \t]+$/)?.[0].length || 0);
        if (removed) {
          ta.setSelectionRange(start - removed, end);
          this.replaceRange(start - removed, start, '');
        }
        return;
      }
      this.replaceRange(start, end, this.indentUnit);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      this._insertNewline();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.onSave();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      // 交给浏览器原生撤销栈（结构视图的修改也走 execCommand，可被撤销）
      return;
    }
    if (event.key === 'Escape') {
      ta.blur();
    }
  }

  _indentBlock(dedent) {
    const ta = this.textarea;
    const { selectionStart: start, selectionEnd: end } = ta;
    const text = ta.value;
    const blockStart = text.lastIndexOf('\n', start - 1) + 1;
    let blockEnd = text.indexOf('\n', end);
    if (blockEnd < 0) blockEnd = text.length;
    const block = text.slice(blockStart, blockEnd);
    const lines = block.split('\n');
    const changed = lines.map((line) => {
      if (dedent) {
        if (line.startsWith(this.indentUnit)) return line.slice(this.indentUnit.length);
        return line.replace(/^[ \t]+/, (m) => m.slice(0, Math.min(m.length, this.indentUnit.length)));
      }
      return line ? this.indentUnit + line : line;
    }).join('\n');
    this.replaceRange(blockStart, blockEnd, changed);
    ta.setSelectionRange(blockStart, blockStart + changed.length);
  }

  _insertNewline() {
    const ta = this.textarea;
    const start = ta.selectionStart;
    const value = ta.value;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const line = value.slice(lineStart, start);
    const indent = (line.match(/^[ \t]*/) || [''])[0];
    const trimmed = line.replace(/[ \t]+$/, '');
    const opens = /[{[]$/.test(trimmed);
    const nextChar = value[start] || '';
    const closes = nextChar === '}' || nextChar === ']';
    let insert = `\n${indent}`;
    if (opens) insert += this.indentUnit;
    if (opens && closes) {
      insert += `\n${indent}`;
      this.replaceRange(start, start, insert);
      ta.setSelectionRange(start + insert.length - 1 - indent.length, start + insert.length - 1 - indent.length);
      return;
    }
    this.replaceRange(start, start, insert);
  }

  /* ------------------------------------------------------------ 值 */
  setValue(text, { silent = false } = {}) {
    this._silent = true;
    this.value = text;
    this.textarea.value = text;
    this.textarea.setSelectionRange(0, 0);
    this.textarea.scrollTop = 0;
    this.textarea.scrollLeft = 0;
    this._silent = false;
    this.starts = lineStarts(text);
    this._refresh(true);
    if (!silent) this.onChange(text);
  }

  getValue() { return this.textarea.value; }

  focus() { this.textarea.focus(); }

  setReadOnly(flag) {
    this.readonly = flag;
    this.textarea.readOnly = flag;
    this.textarea.classList.toggle('readonly', flag);
  }

  setIndentUnit(unit) {
    if (unit) this.indentUnit = unit;
  }

  /* ------------------------------------------------------------ 光标 */
  getCursor() {
    const pos = offsetToPos(this.starts, this.textarea.selectionStart);
    return { ...pos, offset: this.textarea.selectionStart };
  }

  goToOffset(offset, { select = false, focus = true } = {}) {
    const clamped = Math.max(0, Math.min(offset, this.textarea.value.length));
    if (select) this.textarea.setSelectionRange(clamped, clamped + 1);
    else this.textarea.setSelectionRange(clamped, clamped);
    this._revealOffset(clamped);
    this._refreshCursorOnly();
    if (focus) this.textarea.focus();
  }

  goToLine(line, col = 1) {
    const target = Math.min(line - 1, this.starts.length - 1);
    const offset = this.starts[target] + Math.max(0, col - 1);
    this.goToOffset(offset, { select: true });
  }

  _revealOffset(offset) {
    this._measure();
    const ta = this.textarea;
    const { line } = offsetToPos(this.starts, offset);
    const top = (line - 1) * this._lineHeight + this._paddingTop;
    const viewTop = ta.scrollTop;
    const viewBottom = viewTop + ta.clientHeight;
    if (top < viewTop + this._lineHeight * 2) {
      ta.scrollTop = Math.max(0, top - this._lineHeight * 2);
    } else if (top > viewBottom - this._lineHeight * 3) {
      ta.scrollTop = top - ta.clientHeight / 2;
    }
    this._syncScroll();
  }

  /* ------------------------------------------------------------ 修改 */
  /** 用 execCommand 写入，保留浏览器原生撤销历史。 */
  replaceRange(start, end, insert) {
    const ta = this.textarea;
    if (this.readonly) return;
    ta.focus();
    ta.setSelectionRange(start, end);
    let done = false;
    try {
      done = document.execCommand('insertText', false, insert);
    } catch { done = false; }
    if (!done) {
      const next = ta.value.slice(0, start) + insert + ta.value.slice(end);
      ta.value = next;
      ta.setSelectionRange(start + insert.length, start + insert.length);
      this.value = next;
      this.starts = lineStarts(next);
      this._refresh(true);
      this.onChange(next);
      return;
    }
    ta.setSelectionRange(start + insert.length, start + insert.length);
    this.value = ta.value;
    this.starts = lineStarts(ta.value);
    this._refresh(true);
    this.onChange(ta.value);
  }

  /* ------------------------------------------------------------ 渲染 */
  setErrors(errors) {
    this.errors = errors || [];
    this.errorLines = new Set(this.errors.filter((e) => e.line).map((e) => e.line));
    this._renderGutter();
    this._renderHighlight();
  }

  _refresh(full = false) {
    this.starts = lineStarts(this.value);
    if (full) {
      this._renderGutter();
      this._renderHighlight();
    }
    this._refreshCursorOnly();
    this._syncScroll();
  }

  _refreshCursorOnly() {
    this._measure();
    const { line, col, offset } = this.getCursor();
    this._cursor = { line, col, offset };
    if (this._lastLine !== line) {
      this._lastLine = line;
      this.currentLineBar.style.transform = `translateY(${(line - 1) * this._lineHeight}px)`;
      const nodes = this.gutterInner.children;
      for (let i = 0; i < nodes.length; i += 1) {
        nodes[i].classList.toggle('current', i + 1 === line);
      }
    }
    this.onCursor(this._cursor);
  }

  _syncScroll() {
    const ta = this.textarea;
    this.code.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    this.gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
  }

  _renderGutter() {
    const count = this.starts.length;
    const frag = document.createDocumentFragment();
    const errorLines = this.errorLines || new Set();
    for (let i = 1; i <= count; i += 1) {
      const line = el('div', { class: 'gl', dataset: { line: String(i) } }, [String(i)]);
      if (errorLines.has(i)) line.classList.add('error');
      frag.appendChild(line);
    }
    clear(this.gutterInner).appendChild(frag);
    this._lastLine = null;
    this.gutterInner.style.width = `${Math.max(String(count).length, 2)}ch`;
  }

  _renderHighlight() {
    const text = this.value;
    const lines = text.split('\n');
    const errorLines = this.errorLines || new Set();
    const match = this._bracketPair();
    const html = lines.map((line, index) => {
      const lineNo = index + 1;
      const classes = ['ce-line'];
      if (errorLines.has(lineNo)) classes.push('error');
      const lineStart = this.starts[index] || 0;
      return `<div class="${classes.join(' ')}"><span class="ce-line-inner">${this._highlightLine(line, lineStart, match)}</span></div>`;
    }).join('');
    this.code.innerHTML = html || '<div class="ce-line"></div>';
    this._refreshCursorOnly();
  }

  _highlightLine(line, lineStart, match) {
    let out = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      const ch = line[i];
      if (ch === '"') {
        let j = i + 1;
        let closed = false;
        while (j < n) {
          if (line[j] === '\\') { j += 2; continue; }
          if (line[j] === '"') { closed = true; j += 1; break; }
          j += 1;
        }
        const token = line.slice(i, j);
        let k = j;
        while (k < n && (line[k] === ' ' || line[k] === '\t')) k += 1;
        const isKey = line[k] === ':';
        out += `<span class="${isKey ? 'tok-key' : 'tok-str'}${closed ? '' : ' tok-bad'}">${escapeHtml(token)}</span>`;
        i = j;
        continue;
      }
      if (ch === '/' && (line[i + 1] === '/' || line[i + 1] === '*')) {
        out += `<span class="tok-bad">${escapeHtml(line.slice(i))}</span>`;
        break;
      }
      if (ch === '-' || (ch >= '0' && ch <= '9')) {
        const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(line.slice(i));
        if (m) {
          out += `<span class="tok-num">${escapeHtml(m[0])}</span>`;
          i += m[0].length;
          continue;
        }
      }
      if (/[A-Za-z_]/.test(ch)) {
        const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i))[0];
        if (KEYWORDS.has(word)) {
          out += `<span class="tok-${word === 'null' ? 'null' : 'bool'}">${word}</span>`;
        } else {
          out += `<span class="tok-bad">${escapeHtml(word)}</span>`;
        }
        i += word.length;
        continue;
      }
      if ('{}[],:'.includes(ch)) {
        const abs = lineStart + i;
        const cls = match && (match.a === abs || match.b === abs) ? 'tok-punct tok-match' : 'tok-punct';
        out += `<span class="${cls}">${escapeHtml(ch)}</span>`;
        i += 1;
        continue;
      }
      out += escapeHtml(ch);
      i += 1;
    }
    return out || '&nbsp;';
  }

  /** 当前光标处括号配对（用于高亮，纯视觉）。 */
  _bracketPair() {
    if (!this._cursor) return null;
    const text = this.value;
    const pos = this._cursor.offset;
    const candidates = [pos, pos - 1];
    for (const at of candidates) {
      const ch = text[at];
      if (!ch || !'{}[]'.includes(ch)) continue;
      const isOpen = ch === '{' || ch === '[';
      const pairs = { '{': '}', '[': ']', '}': '{', ']': '[' };
      const want = pairs[ch];
      const step = isOpen ? 1 : -1;
      let depth = 0;
      for (let i = at; i >= 0 && i < text.length; i += step) {
        const c = text[i];
        if (c === ch) depth += 1;
        else if (c === want) {
          depth -= 1;
          if (depth === 0) return { a: at, b: i };
        }
      }
    }
    return null;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
