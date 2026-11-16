/* ===========================================================================
   jsonview.js —— 配置编辑模块
   · 结构视图：树形展开、行内改值、增删键、数组排序、复制路径
   · 源码视图：语法高亮、行号、错误行标记
   · 差异视图：与磁盘 / 历史备份逐行对比
   · 保存：语法不合法一律拦截；保存前自动备份；保留编码、换行与缩进
   结构视图的每次修改都以"文本区间替换"实现，因此不会重排整份文件。
   =========================================================================== */

import {
  api, el, clear, $, toast, toastOk, toastErr, toastWarn, confirmDialog, promptDialog,
  formatBytes, formatTime, relativeTime, emptyState, copyText, debounce,
} from './core.js';
import {
  parseJson, formatJson, nodeAtPath, valueToLiteral, detectIndentUnit, diffLines,
} from './parser.js';
import { CodeEditor } from './editor.js';

const MAX_UNDO = 80;

export async function mount(root) {
  const view = new JsonView(root);
  await view.init();
  return view;
}

class JsonView {
  constructor(root) {
    this.root = root;
    this.state = {
      roots: [],
      rootId: 'main',
      files: [],
      filter: '',
      name: null,
      meta: null,
      baseline: '',
      text: '',
      lint: null,
      ast: null,
      dirty: false,
      readonly: false,
      mode: 'tree',
      selectedPath: null,
      collapsed: new Set(),
      treeFilter: '',
      editor: null,
      backups: [],
      diff: null,
      undo: [],
      redo: [],
      savedAt: 0,
    };
    this.el = {};
    this.hidden = false;
  }

  /* ------------------------------------------------------------ 初始化 */
  async init() {
    const boot = await api.get('/bootstrap');
    this.state.roots = boot.roots.json;
    const usable = this.state.roots.filter((r) => r.exists);
    if (usable.length) this.state.rootId = usable[0].id;

    this.buildLayout();
    this.bindKeys();
    this.renderChrome();
    const params = new URLSearchParams(location.search);
    if (['tree', 'code', 'diff'].includes(params.get('mode'))) this.state.mode = params.get('mode');
    await this.loadFiles();
    const wanted = params.get('file');
    const first = (wanted && this.state.files.find((f) => f.name === wanted))
      || this.state.files.find((f) => f.valid !== false)
      || this.state.files[0];
    if (first) await this.openFile(first.name);
    else this.showEmpty();
  }

  buildLayout() {
    const s = this.state;

    this.el.rootSelect = el('select', { class: 'select', style: 'max-width:120px' });
    this.el.rootSelect.addEventListener('change', async () => {
      s.rootId = this.el.rootSelect.value;
      s.name = null;
      await this.loadFiles();
      const first = s.files[0];
      if (first) await this.openFile(first.name); else this.showEmpty();
    });

    this.el.refresh = el('button', {
      class: 'icon-btn', title: '刷新文件列表 (F5)', text: '⟳',
      onclick: () => this.loadFiles(),
    });

    this.el.search = el('input', {
      class: 'input', type: 'search', placeholder: '过滤文件名…',
      oninput: (event) => {
        s.filter = event.target.value.trim().toLowerCase();
        this.renderFileList({ keepScroll: false });
      },
    });

    this.el.fileList = el('div', { class: 'file-list' });
    this.el.fileScroll = el('div', { class: 'panel-body' }, [this.el.fileList]);
    this.el.fileFoot = el('div', { class: 'panel-foot' });

    this.el.filesPanel = el('aside', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('span', { class: 'title', text: '配置文件' }),
        el('span', { class: 'spacer' }),
        this.el.rootSelect,
        this.el.refresh,
      ]),
      el('div', { style: 'padding:8px 8px 0' }, [this.el.search]),
      this.el.fileScroll,
      this.el.fileFoot,
    ]);

    this.el.title = el('span', { class: 'title' });
    this.el.badges = el('span', { class: 'row', style: 'gap:6px' });

    this.el.btnSave = el('button', { class: 'btn primary sm', text: '保存', title: '保存 (Ctrl+S)', onclick: () => this.save() });
    this.el.btnFormat = el('button', { class: 'btn sm', text: '格式化', title: '统一缩进格式', onclick: () => this.format() });
    this.el.btnReload = el('button', { class: 'btn sm', text: '重新载入', title: '放弃修改，从磁盘重读', onclick: () => this.reload() });
    this.el.btnBackup = el('button', { class: 'btn sm', text: '备份', title: '历史备份与还原', onclick: () => this.showBackups() });
    this.el.btnDiff = el('button', { class: 'btn sm', text: '对比', title: '与磁盘 / 备份对比', onclick: () => this.showDiffChooser() });
    this.el.btnReadonly = el('button', { class: 'btn sm', text: '只读', title: '锁定当前文件防误改', onclick: () => this.toggleReadonly() });

    this.el.modeBar = el('div', { class: 'segmented', role: 'tablist' });
    for (const [id, label] of [['tree', '结构'], ['code', '源码'], ['diff', '差异']]) {
      this.el.modeBar.appendChild(el('button', {
        class: 'seg', dataset: { mode: id }, text: label,
        onclick: () => this.setMode(id),
      }));
    }

    this.el.treeHost = el('div', { class: 'panel-body' });
    this.el.codeHost = el('div', { class: 'editor-wrap hidden' });
    this.el.diffHost = el('div', { class: 'panel-body hidden' });

    this.el.status = el('div', { class: 'panel-foot' });
    this.el.fileInfo = el('span', { class: 'muted' });

    this.el.mainPanel = el('section', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        this.el.title, this.el.badges, el('span', { class: 'spacer' }),
        this.el.btnDiff, this.el.btnBackup, this.el.btnReload,
        this.el.btnFormat, this.el.btnReadonly, this.el.btnSave,
      ]),
      el('div', { class: 'panel-subhead' }, [this.el.modeBar, el('span', { class: 'spacer' }), this.el.fileInfo]),
      this.el.treeHost, this.el.codeHost, this.el.diffHost,
      this.el.status,
    ]);

    this.el.lintPanel = el('div', { class: 'panel-body' });
    this.el.inspector = el('aside', { class: 'panel inspector' }, [
      el('div', { class: 'panel-head' }, [
        el('span', { class: 'title', text: '校验与信息' }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'icon-btn', title: '收起', text: '»', onclick: () => this.toggleInspector() }),
      ]),
      this.el.lintPanel,
    ]);

    this.el.workspace = el('div', { class: 'workspace' }, [
      this.el.filesPanel, this.el.mainPanel, this.el.inspector,
    ]);
    clear(this.root).appendChild(this.el.workspace);
  }

  toggleInspector() {
    this.el.inspector.classList.toggle('hidden');
    this.el.workspace.classList.toggle('no-inspector', this.el.inspector.classList.contains('hidden'));
  }

  showEmpty() {
    const host = this.state.mode === 'code' ? this.el.codeHost : this.el.treeHost;
    clear(host).appendChild(emptyState('尚未选择文件', '在左侧选择一个 JSON 文件开始编辑（↑↓ 可切换）', '❏'));
  }

  /* ------------------------------------------------------------ 文件列表 */
  async loadFiles() {
    const s = this.state;
    try {
      const data = await api.get('/json/list', { root: s.rootId });
      s.files = data.files || [];
    } catch (err) {
      s.files = [];
      toastErr(err.message);
    }
    this.renderFileList();
    this.renderRootSelect();
    this.el.fileFoot.textContent = `${s.files.length} 个文件 · ${this.currentRoot()?.label || ''}`;
  }

  renderRootSelect() {
    const s = this.state;
    clear(this.el.rootSelect);
    for (const root of s.roots) {
      this.el.rootSelect.appendChild(el('option', {
        value: root.id,
        text: root.exists ? root.label : `${root.label}（缺失）`,
        disabled: !root.exists,
        selected: root.id === s.rootId,
      }));
    }
    this.el.rootSelect.value = s.rootId;
  }

  currentRoot() {
    return this.state.roots.find((r) => r.id === this.state.rootId);
  }

  renderFileList({ keepScroll = true } = {}) {
    const s = this.state;
    const scroller = this.el.fileScroll;
    const scrollTop = keepScroll && scroller ? scroller.scrollTop : 0;
    const list = clear(this.el.fileList);
    const files = s.files.filter((f) => !s.filter || f.name.toLowerCase().includes(s.filter));
    if (!files.length) {
      list.appendChild(el('div', { class: 'muted small', style: 'padding:10px' },
        [s.files.length ? '没有匹配的文件' : '目录中没有匹配的文件']));
      return;
    }
    for (const file of files) {
      const dotClass = file.valid === false ? 'bad' : file.valid === null ? 'unknown' : '';
      const item = el('button', {
        class: `file-item${file.name === s.name ? ' active' : ''}`,
        dataset: { name: file.name },
        title: `${file.name}\n${formatBytes(file.size)} · 修改于 ${formatTime(file.mtime)}\n${file.keys || 0} 个键`,
        onclick: () => this.openFile(file.name),
      }, [
        el('div', { class: 'fi-top' }, [
          el('span', { class: `file-dot ${dotClass}` }),
          el('span', { class: 'fi-name', text: file.name }),
          el('span', { class: `chip warn${file.name === s.name && s.dirty ? '' : ' hidden'}`, text: '未保存' }),
        ]),
        el('div', { class: 'fi-meta' }, [
          el('span', { text: formatBytes(file.size) }),
          el('span', { text: relativeTime(file.mtime) }),
          el('span', { text: `${file.keys || 0} 键` }),
        ]),
      ]);
      list.appendChild(item);
    }
    if (scroller) scroller.scrollTop = scrollTop;
  }

  /** 文件列表只更新选中与"未保存"标记，不重建 DOM（保持滚动位置与悬停状态）。 */
  syncFileState() {
    const s = this.state;
    for (const item of this.el.fileList.children) {
      if (!item.dataset || !item.dataset.name) continue;
      const active = item.dataset.name === s.name;
      item.classList.toggle('active', active);
      const chip = item.querySelector('.chip.warn');
      if (chip) chip.classList.toggle('hidden', !(active && s.dirty));
    }
  }

  /* ------------------------------------------------------------ 打开文件 */
  async openFile(name) {
    const s = this.state;
    if (s.dirty && s.name && s.name !== name) {
      const ok = await confirmDialog({
        title: '有未保存的修改',
        message: `“${s.name}”还有未保存的修改，切换文件将丢弃这些修改。是否继续？`,
        okText: '丢弃并切换', danger: true,
      });
      if (!ok) return;
    }
    try {
      const data = await api.get('/json/get', { root: s.rootId, name });
      s.name = name;
      s.meta = data;
      s.baseline = data.text;
      s.text = data.text;
      s.backups = data.backups || [];
      s.dirty = false;
      s.readonly = Boolean(this.currentRoot()?.readonly);
      s.undo = [];
      s.redo = [];
      s.selectedPath = null;
      s.collapsed = new Set();

      this.buildEditor();
      this.applyText(data.text, { silent: true });
      this.renderChrome();
      this.syncFileState();
      this.renderInspector();
      this.setMode(s.mode === 'diff' ? 'tree' : s.mode);
      this.updateStatus();
    } catch (err) {
      toastErr(`打开失败：${err.message}`);
    }
  }

  buildEditor() {
    const s = this.state;
    if (!s.editor) {
      s.editor = new CodeEditor(this.el.codeHost, {
        indentUnit: '  ',
        onChange: (text) => this.onTextChanged(text),
        onCursor: (cursor) => this.onCursor(cursor),
        onSave: () => this.save(),
      });
    }
    return s.editor;
  }

  /* ------------------------------------------------------------ 文本与校验 */
  applyText(text, { silent = false } = {}) {
    const s = this.state;
    s.text = text;
    const lint = parseJson(text);
    s.lint = lint;
    s.ast = lint.ok ? lint.root : s.ast;
    if (s.editor) s.editor.setValue(text, { silent: true });
    if (s.editor) s.editor.setErrors(lint.errors);
    void silent;
  }

  onTextChanged(text) {
    const s = this.state;
    s.text = text;
    const lint = parseJson(text);
    s.lint = lint;
    if (lint.ok) s.ast = lint.root;
    s.dirty = text !== s.baseline;
    s.editor.setErrors(lint.errors);
    if (s.mode === 'tree') this.renderTree();
    if (s.mode === 'code') s.editor.setErrors(lint.errors);
    this.renderLint();
    this.renderChrome();
    this.updateStatus();
    this.syncFileState();
  }

  onCursor(cursor) {
    const s = this.state;
    s.cursor = cursor;
    this.updateStatus();
  }

  updateStatus() {
    const s = this.state;
    if (!s.meta) { this.el.status.textContent = ''; return; }
    const lint = s.lint;
    const parts = [];
    if (s.cursor) parts.push(`第 ${s.cursor.line} 行，第 ${s.cursor.col} 列`);
    parts.push(s.meta.encoding);
    parts.push(s.meta.eol === '\r\n' ? 'CRLF' : 'LF');
    parts.push(`缩进 ${s.meta.indentUnit === '\t' ? 'Tab' : s.meta.indentWidth}`);
    parts.push(`${lint?.stats?.lines || 0} 行`);
    parts.push(`${lint?.stats?.keys || 0} 键`);
    parts.push(formatBytes(s.meta.size));
    clear(this.el.status);
    this.el.status.appendChild(el('span', { text: parts.join(' · ') }));
    this.el.status.appendChild(el('span', { class: 'spacer' }));
    const state = !lint ? { cls: '', text: '' }
      : lint.ok
        ? { cls: 'ok-text', text: s.dirty ? '● 已修改，未保存' : '✓ 与磁盘一致' }
        : { cls: 'bad-text', text: `✕ 第 ${lint.errors[0].line} 行：${lint.errors[0].msg}` };
    this.el.status.appendChild(el('span', { class: state.cls, text: state.text }));
  }

  renderChrome() {
    const s = this.state;
    this.el.title.textContent = s.name || '未选择文件';
    clear(this.el.badges);
    if (s.name) {
      if (s.readonly) this.el.badges.appendChild(el('span', { class: 'chip warn', text: '只读' }));
      if (s.dirty) this.el.badges.appendChild(el('span', { class: 'chip accent', text: '未保存' }));
      if (s.lint && !s.lint.ok) this.el.badges.appendChild(el('span', { class: 'chip bad', text: '语法错误' }));
      else if (s.lint?.warnings.length) this.el.badges.appendChild(el('span', { class: 'chip warn', text: `${s.lint.warnings.length} 条提示` }));
    }
    this.el.btnSave.disabled = s.readonly || !s.dirty || !s.lint?.ok;
    this.el.btnReadonly.classList.toggle('primary', s.readonly);
    this.el.btnReadonly.textContent = s.readonly ? '只读中' : '只读';
    if (s.editor) s.editor.setReadOnly(s.readonly);
    if (s.meta) this.el.fileInfo.textContent = `${formatBytes(s.meta.size)} · 修改于 ${formatTime(s.meta.mtime)}`;
  }

  /* ------------------------------------------------------------ 模式 */
  setMode(mode) {
    const s = this.state;
    if (mode === 'tree' && !s.ast && !s.lint?.ok) {
      toastWarn('源码存在语法错误，先修复后再用结构视图');
    }
    s.mode = mode;
    for (const btn of this.el.modeBar.children) {
      btn.setAttribute('aria-selected', String(btn.dataset.mode === mode));
    }
    this.el.treeHost.classList.toggle('hidden', mode !== 'tree');
    this.el.codeHost.classList.toggle('hidden', mode !== 'code');
    this.el.diffHost.classList.toggle('hidden', mode !== 'diff');
    if (mode === 'tree') this.renderTree();
    if (mode === 'code' && s.editor) setTimeout(() => s.editor.focus(), 0);
    if (mode === 'diff') this.renderDiff();
  }

  /* ------------------------------------------------------------ 结构树 */
  renderTree() {
    const s = this.state;
    if (!s.name) {
      clear(this.el.treeHost).appendChild(emptyState('尚未选择文件', '在左侧选择一个 JSON 文件', '❏'));
      return;
    }
    if (!this.el.treeBody) {
      this.el.treeSearch = el('input', {
        class: 'input', type: 'search', placeholder: '在结构中搜索键或值…',
        oninput: (event) => { this.state.treeFilter = event.target.value; this.renderTreeBody(); },
      });
      this.el.treeBody = el('div');
      clear(this.el.treeHost).append(
        el('div', { style: 'padding:8px 10px 0' }, [this.el.treeSearch]),
        el('div', { class: 'tree-hint' }, ['单击值编辑 · 双击键改名 · 行尾 ＋/✕ 增删 · Ctrl+Z 撤销']),
        this.el.treeBody,
      );
    }
    this.renderTreeBody();
  }

  renderTreeBody() {
    const s = this.state;
    const host = clear(this.el.treeBody);
    if (!s.ast) {
      host.appendChild(emptyState('结构视图暂不可用',
        '源码当前不是合法 JSON。切换到「源码」视图，按提示修复后即可继续用结构方式编辑。', '⚠'));
      host.appendChild(el('div', { class: 'row', style: 'justify-content:center;margin-top:8px' }, [
        el('button', { class: 'btn primary sm', text: '去源码修复', onclick: () => this.setMode('code') }),
      ]));
      return;
    }
    const filter = s.treeFilter.trim().toLowerCase();
    const container = el('div', { class: 'tree' });
    this.appendTreeRow(container, s.ast, 0, filter, true);
    host.appendChild(container);
  }

  nodeMatches(node, filter) {
    if (!filter) return true;
    const hay = `${node.key ?? ''} ${node.type === 'object' || node.type === 'array' ? '' : (node.raw ?? '')}`.toLowerCase();
    if (hay.includes(filter)) return true;
    return (node.children || []).some((child) => this.nodeMatches(child, filter));
  }

  appendTreeRow(container, node, depth, filter, isRoot = false) {
    const s = this.state;
    if (filter && !this.nodeMatches(node, filter)) return;
    const hasChildren = (node.children || []).length > 0;
    const collapsed = s.collapsed.has(node.path);
    const selected = s.selectedPath === node.path;
    const row = el('div', {
      class: `tree-row${selected ? ' selected' : ''}`,
      dataset: { path: node.path },
      style: `padding-left:${6 + depth * 15}px`,
    });

    const caret = el('span', {
      class: `caret${hasChildren ? '' : ' leaf'}`,
      text: collapsed ? '▸' : '▾',
      onclick: (event) => {
        event.stopPropagation();
        if (!hasChildren) return;
        if (collapsed) s.collapsed.delete(node.path); else s.collapsed.add(node.path);
        this.renderTree();
      },
    });
    row.appendChild(caret);

    if (isRoot) {
      row.appendChild(el('span', { class: 'tree-key', text: node.type === 'array' ? '[根数组]' : '$' }));
      row.appendChild(el('span', { class: 'tree-colon', text: ' ' }));
    } else if (node.parent?.type === 'array') {
      row.appendChild(el('span', { class: 'tree-key', text: `[${node.index}]` }));
      row.appendChild(el('span', { class: 'tree-colon', text: ':' }));
    } else {
      const keyEl = el('span', {
        class: 'tree-key',
        text: `"${node.key}"`,
        title: '双击重命名键名',
        ondblclick: (event) => {
          event.stopPropagation();
          this.startRenameKey(node, row, keyEl);
        },
      });
      row.appendChild(keyEl);
      row.appendChild(el('span', { class: 'tree-colon', text: ':' }));
    }

    const valueHost = el('span');
    row.appendChild(valueHost);
    this.renderValue(node, valueHost, row);

    if (hasChildren) {
      row.appendChild(el('span', {
        class: 'tree-summary',
        text: node.type === 'object' ? `${node.children.length} 项` : `${node.children.length} 项`,
      }));
    }

    const actions = el('span', { class: 'tree-actions' });
    if (node.type === 'object' || node.type === 'array') {
      actions.appendChild(el('button', {
        text: '＋', title: node.type === 'object' ? '添加键' : '添加元素',
        onclick: (event) => { event.stopPropagation(); this.addChild(node); },
      }));
    }
    if (!isRoot) {
      if (node.parent?.type === 'array') {
        actions.appendChild(el('button', {
          text: '↑', title: '上移',
          onclick: (event) => { event.stopPropagation(); this.moveNode(node, -1); },
        }));
        actions.appendChild(el('button', {
          text: '↓', title: '下移',
          onclick: (event) => { event.stopPropagation(); this.moveNode(node, 1); },
        }));
      }
      actions.appendChild(el('button', {
        text: '⧉', title: '复制 JSON 路径与值',
        onclick: (event) => {
          event.stopPropagation();
          copyText(`${node.path}  ${node.raw ?? ''}`.trim());
          toastOk(`已复制：${node.path}`);
        },
      }));
      actions.appendChild(el('button', {
        class: 'del', text: '✕', title: '删除',
        onclick: (event) => { event.stopPropagation(); this.deleteNode(node); },
      }));
    }
    row.appendChild(actions);

    row.addEventListener('click', () => {
      s.selectedPath = node.path;
      for (const other of this.el.treeHost.querySelectorAll('.tree-row.selected')) other.classList.remove('selected');
      row.classList.add('selected');
    });

    container.appendChild(row);

    if (hasChildren && !collapsed) {
      for (const child of node.children) {
        this.appendTreeRow(container, child, depth + 1, filter);
      }
    }
  }

  renderValue(node, host, row) {
    if (node.type === 'object') {
      host.appendChild(el('span', { class: 'tree-val', text: '{' }));
      host.appendChild(el('span', { class: 'tree-colon', text: ' }' }));
      return;
    }
    if (node.type === 'array') {
      host.appendChild(el('span', { class: 'tree-val', text: '[' }));
      host.appendChild(el('span', { class: 'tree-colon', text: ' ]' }));
      return;
    }
    const cls = node.type === 'string' ? 'tree-val'
      : node.type === 'number' ? 'tree-val num'
        : node.type === 'null' ? 'tree-val null' : 'tree-val bool';
    const text = node.type === 'string' ? `"${node.value}"` : node.raw;
    const span = el('span', {
      class: cls,
      title: '单击直接编辑此值',
      text: text.length > 120 ? `${text.slice(0, 120)}…` : text,
    });
    span.style.cursor = 'text';
    span.addEventListener('click', (event) => {
      event.stopPropagation();
      this.startEditValue(node, span);
    });
    host.appendChild(span);
    void row;
  }

  startEditValue(node, span) {
    const s = this.state;
    if (s.readonly) { toastWarn('当前文件处于只读状态'); return; }
    const parent = span.parentElement;
    let editor;
    if (node.type === 'boolean' || node.type === 'null') {
      editor = el('select', { class: 'tree-select' }, [
        el('option', { value: 'true', text: 'true', selected: node.value === true }),
        el('option', { value: 'false', text: 'false', selected: node.value === false }),
        el('option', { value: 'null', text: 'null', selected: node.value === null }),
      ]);
    } else {
      editor = el('input', {
        class: 'tree-input',
        value: node.type === 'string' ? node.value : node.raw,
        style: `width:${Math.min(520, Math.max(90, String(node.raw).length * 8))}px`,
      });
    }
    span.replaceWith(editor);
    editor.focus();
    if (editor.select) editor.select();

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      if (!save) { this.renderTree(); return; }
      let literal;
      if (node.type === 'boolean' || node.type === 'null') {
        literal = editor.value;
      } else if (node.type === 'number') {
        const raw = editor.value.trim();
        if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) {
          toastErr('不是合法数字，已还原');
          this.renderTree();
          return;
        }
        literal = raw;
      } else {
        literal = JSON.stringify(editor.value);
      }
      if (literal === node.raw) { this.renderTree(); return; }
      const before = s.text.slice(0, node.start);
      const after = s.text.slice(node.end);
      this.commitText(`${before}${literal}${after}`, { cursor: node.start + literal.length });
    };
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commit(true); }
      else if (event.key === 'Escape') { event.preventDefault(); commit(false); }
      event.stopPropagation();
    });
    editor.addEventListener('blur', () => commit(true));
  }

  startRenameKey(node, row, keyEl) {
    const s = this.state;
    if (s.readonly) { toastWarn('当前文件处于只读状态'); return; }
    if (!node.keyStart && node.keyStart !== 0) return;
    const input = el('input', { class: 'tree-input', value: node.key, style: 'min-width:80px' });
    keyEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const nextKey = input.value.trim();
      if (!save || !nextKey || nextKey === node.key) { this.renderTree(); return; }
      if (node.parent?.children.some((child) => child !== node && child.key === nextKey)) {
        toastErr(`键 “${nextKey}” 已存在`);
        this.renderTree();
        return;
      }
      const before = s.text.slice(0, node.keyStart);
      const after = s.text.slice(node.keyEnd);
      this.commitText(`${before}${JSON.stringify(nextKey)}${after}`,
        { cursor: node.keyStart + nextKey.length + 2 });
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commit(true); }
      else if (event.key === 'Escape') { event.preventDefault(); commit(false); }
      event.stopPropagation();
    });
    input.addEventListener('blur', () => commit(true));
    void row;
  }

  /* ------------------------------------------------------------ 结构操作 */
  addChild(node) {
    const s = this.state;
    if (s.readonly) { toastWarn('当前文件处于只读状态'); return; }
    const unit = s.meta?.indentUnit === '\t' ? '\t' : (s.meta?.indentUnit || detectIndentUnit(s.text));
    const literalFor = (value) => valueToLiteral(value);

    const doAdd = (key, literal) => {
      const text = s.text;
      if (node.type === 'object') {
        const close = node.end - 1;
        const lineStart = text.lastIndexOf('\n', close - 1) + 1;
        const closeIndent = (text.slice(lineStart, close).match(/^[ \t]*/) || [''])[0];
        const childIndent = `${closeIndent}${unit}`;
        if (!node.children.length) {
          const insert = `\n${childIndent}${JSON.stringify(key)}: ${literal}\n${closeIndent}`;
          this.commitText(text.slice(0, node.start + 1) + insert + text.slice(close));
        } else {
          const last = node.children[node.children.length - 1];
          const insert = `,\n${childIndent}${JSON.stringify(key)}: ${literal}`;
          this.commitText(text.slice(0, last.end) + insert + text.slice(last.end));
        }
      } else {
        const close = node.end - 1;
        const lineStart = text.lastIndexOf('\n', close - 1) + 1;
        const closeIndent = (text.slice(lineStart, close).match(/^[ \t]*/) || [''])[0];
        const childIndent = `${closeIndent}${unit}`;
        if (!node.children.length) {
          const insert = `\n${childIndent}${literal}\n${closeIndent}`;
          this.commitText(text.slice(0, node.start + 1) + insert + text.slice(close));
        } else {
          const last = node.children[node.children.length - 1];
          const insert = `,\n${childIndent}${literal}`;
          this.commitText(text.slice(0, last.end) + insert + text.slice(last.end));
        }
      }
      toastOk(node.type === 'object' ? `已添加键 ${key}` : '已添加元素');
    };

    if (node.type === 'object') {
      promptDialog({
        title: '添加键',
        label: '键名（会自动加双引号）',
        placeholder: '例如 newSetting',
        okText: '添加',
      }).then((key) => {
        if (!key) return;
        if (node.children.some((child) => child.key === key)) {
          toastErr(`键 “${key}” 已存在`);
          return;
        }
        const isStringKey = /name|title|header|message|text|desc|msg/i.test(key);
        doAdd(key, isStringKey ? '""' : 'null');
      });
      return;
    }
    // 数组：沿用最后一个元素的类型
    const lastChild = node.children[node.children.length - 1];
    let literal = 'null';
    if (lastChild) {
      if (lastChild.type === 'string') literal = '""';
      else if (lastChild.type === 'number') literal = '0';
      else if (lastChild.type === 'boolean') literal = 'false';
      else if (lastChild.type === 'object' && lastChild.children.length) {
        const tpl = {};
        for (const child of lastChild.children) {
          if (child.type === 'string') tpl[child.key] = '';
          else if (child.type === 'number') tpl[child.key] = 0;
          else if (child.type === 'boolean') tpl[child.key] = false;
          else tpl[child.key] = null;
        }
        literal = JSON.stringify(tpl);
      }
    }
    doAdd('', literal);
  }

  deleteNode(node) {
    const s = this.state;
    if (s.readonly) { toastWarn('当前文件处于只读状态'); return; }
    const parent = node.parent;
    if (!parent) { toastWarn('根节点不能删除'); return; }
    const text = s.text;
    const siblings = parent.children;
    const index = siblings.indexOf(node);
    const label = parent.type === 'object' ? `键 “${node.key}”` : `第 ${index + 1} 个元素`;
    confirmDialog({
      title: '删除确认',
      message: `确定删除${label}吗？此操作可用 Ctrl+Z 撤销。`,
      okText: '删除', danger: true,
    }).then((ok) => {
      if (!ok) return;
      let start;
      let end;
      if (siblings.length === 1) {
        start = parent.start + 1;
        end = parent.end - 1;
      } else if (index < siblings.length - 1) {
        start = node.keyStart ?? node.start;
        const nextSibling = siblings[index + 1];
        end = nextSibling.keyStart ?? nextSibling.start;
      } else {
        start = siblings[index - 1].end;
        end = node.end;
      }
      this.commitText(text.slice(0, start) + text.slice(end), { cursor: start });
      toastOk('已删除（Ctrl+Z 可撤销）');
    });
  }

  moveNode(node, delta) {
    const s = this.state;
    if (s.readonly) { toastWarn('当前文件处于只读状态'); return; }
    const parent = node.parent;
    if (!parent || parent.type !== 'array') return;
    const index = parent.children.indexOf(node);
    const target = index + delta;
    if (target < 0 || target >= parent.children.length) return;
    const other = parent.children[target];
    const a = index < target ? node : other;
    const b = index < target ? other : node;
    const text = s.text;
    const next = text.slice(0, a.start) + text.slice(b.start, b.end) + text.slice(a.end, b.start)
      + text.slice(a.start, a.end) + text.slice(b.end);
    this.commitText(next, { path: node.path, cursor: a.start });
  }

  /* ------------------------------------------------------------ 文本提交 / 撤销 */
  commitText(nextText, { cursor = null, path = null } = {}) {
    const s = this.state;
    if (nextText === s.text) return;
    s.undo.push({ text: s.text, path: path || s.selectedPath, cursor });
    if (s.undo.length > MAX_UNDO) s.undo.shift();
    s.redo.length = 0;
    s.text = nextText;
    if (s.editor) s.editor.setValue(nextText, { silent: true });
    const lint = parseJson(nextText);
    s.lint = lint;
    if (lint.ok) s.ast = lint.root;
    s.dirty = nextText !== s.baseline;
    if (s.editor) s.editor.setErrors(lint.errors);
    if (cursor != null && s.editor) s.editor.goToOffset(cursor, { focus: false });
    this.renderTree();
    this.renderLint();
    this.renderChrome();
    this.updateStatus();
    this.syncFileState();
  }

  undo() {
    const s = this.state;
    if (!s.undo.length) { toast('没有可撤销的操作', 'info', 1600); return; }
    const snapshot = s.undo.pop();
    s.redo.push({ text: s.text, path: s.selectedPath });
    s.text = snapshot.text;
    if (snapshot.path) s.selectedPath = snapshot.path;
    if (s.editor) s.editor.setValue(snapshot.text, { silent: true });
    const lint = parseJson(snapshot.text);
    s.lint = lint;
    if (lint.ok) s.ast = lint.root;
    s.dirty = snapshot.text !== s.baseline;
    if (s.editor) s.editor.setErrors(lint.errors);
    this.renderTree();
    this.renderLint();
    this.renderChrome();
    this.updateStatus();
    this.syncFileState();
  }

  redo() {
    const s = this.state;
    if (!s.redo.length) { toast('没有可重做的操作', 'info', 1600); return; }
    const snapshot = s.redo.pop();
    s.undo.push({ text: s.text, path: s.selectedPath });
    s.text = snapshot.text;
    if (s.editor) s.editor.setValue(snapshot.text, { silent: true });
    const lint = parseJson(snapshot.text);
    s.lint = lint;
    if (lint.ok) s.ast = lint.root;
    s.dirty = snapshot.text !== s.baseline;
    if (s.editor) s.editor.setErrors(lint.errors);
    this.renderTree();
    this.renderLint();
    this.renderChrome();
    this.updateStatus();
    this.syncFileState();
  }

  /* ------------------------------------------------------------ 校验面板 */
  renderLint() {
    const s = this.state;
    const host = clear(this.el.lintPanel);
    if (!s.name) return;
    const lint = s.lint;

    if (lint?.ok) {
      host.appendChild(el('div', { class: 'lint-card ok' }, [
        el('div', { class: 'lint-head' }, ['✓ 语法合法']),
        el('div', { class: 'lint-body' }, [
          el('div', { class: 'stat-grid' }, [
            el('span', { class: 'k', text: '顶层类型' }), el('span', { class: 'v', text: lint.stats.type }),
            el('span', { class: 'k', text: '键数量' }), el('span', { class: 'v', text: lint.stats.keys }),
            el('span', { class: 'k', text: '最大深度' }), el('span', { class: 'v', text: lint.stats.depth }),
            el('span', { class: 'k', text: '行数' }), el('span', { class: 'v', text: lint.stats.lines }),
            el('span', { class: 'k', text: '字符数' }), el('span', { class: 'v', text: lint.stats.chars }),
          ]),
        ]),
      ]));
    } else if (lint) {
      const error = lint.errors[0];
      const card = el('div', { class: 'lint-card bad' }, [
        el('div', { class: 'lint-head' }, ['✕ 语法错误（已阻止保存）']),
        el('div', { class: 'lint-body' }, [
          el('div', { class: 'lint-msg', text: error.msg }),
          el('div', { class: 'row', style: 'gap:8px;margin:6px 0' }, [
            el('span', {
              class: 'lint-loc', text: `第 ${error.line} 行 第 ${error.col} 列 → 定位`,
              onclick: () => this.goToError(),
            }),
          ]),
          error.hint ? el('div', { class: 'lint-hint', text: `建议：${error.hint}` }) : null,
          error.snippet ? el('pre', { class: 'lint-snippet', text: error.snippet }) : null,
          el('div', { class: 'row', style: 'margin-top:8px' }, [
            el('button', { class: 'btn sm primary', text: '跳到错误位置', onclick: () => this.goToError() }),
          ]),
        ]),
      ]);
      host.appendChild(card);
    }

    if (lint?.warnings?.length) {
      host.appendChild(el('div', { class: 'lint-head', style: 'padding:10px 10px 4px;font-size:.86em;color:var(--muted)' },
        [`提示与建议（${lint.warnings.length}）`]));
      for (const warn of lint.warnings.slice(0, 20)) {
        host.appendChild(el('div', { class: 'warn-item' }, [
          el('span', { text: '⚠' }),
          el('span', { style: 'flex:1' }, [
            el('span', { text: warn.msg }),
            el('span', {
              class: 'loc', text: ` 第${warn.line}行`,
              onclick: () => this.jumpToLine(warn.line, warn.col),
            }),
          ]),
        ]));
      }
    }
    this.renderBackupList(host);
  }

  renderInspector() {
    this.renderLint();
  }

  renderBackupList(host) {
    const s = this.state;
    if (!s.backups?.length) return;
    host.appendChild(el('div', {
      class: 'lint-head',
      style: 'padding:12px 10px 4px;font-size:.86em;color:var(--muted)',
    }, [`历史备份（${s.backups.length}）`]));
    for (const backup of s.backups.slice(0, 8)) {
      host.appendChild(el('div', {
        class: 'row',
        style: 'padding:4px 10px;font-size:.84em',
      }, [
        el('span', { class: 'mono', text: backup.stamp.slice(0, 15), style: 'flex:1' }),
        el('span', { class: 'muted', text: backup.sizeText }),
        el('button', {
          class: 'btn sm ghost', text: '对比',
          onclick: () => this.showDiff(null, backup),
        }),
        el('button', {
          class: 'btn sm ghost', text: '还原',
          onclick: () => this.restoreBackup(backup),
        }),
      ]));
    }
  }

  goToError() {
    const s = this.state;
    const error = s.lint?.errors?.[0];
    if (!error) return;
    this.setMode('code');
    setTimeout(() => {
      if (s.editor) {
        s.editor.goToLine(error.line, error.col);
        s.editor.focus();
      }
    }, 30);
  }

  jumpToLine(line, col = 1) {
    this.setMode('code');
    setTimeout(() => {
      if (this.state.editor) {
        this.state.editor.goToLine(line, col);
        this.state.editor.focus();
      }
    }, 30);
  }

  /* ------------------------------------------------------------ 保存 */
  async save(force = false) {
    const s = this.state;
    if (!s.name) return;
    if (s.readonly) { toastWarn('当前文件为只读，先解除只读'); return; }
    if (!s.lint?.ok) {
      toastErr('JSON 语法不合法，已阻止保存');
      this.goToError();
      return;
    }
    try {
      const data = await api.post('/json/save', {
        root: s.rootId,
        name: s.name,
        text: s.text,
        expectedMtime: s.meta.mtime,
        force,
      });
      s.baseline = s.text;
      s.dirty = false;
      s.meta = { ...s.meta, mtime: data.mtime, size: data.size, sizeText: data.sizeText, encoding: data.encoding, eol: data.eol };
      s.backups = data.backups || [];
      s.lint = data.lint;
      s.ast = data.lint.ok ? parseJson(s.text).root : s.ast;
      this.renderChrome();
      this.syncFileState();
      this.renderLint();
      this.updateStatus();
      toastOk(`已保存 ${s.name}${data.backup ? '（原文件已备份）' : ''}`);
    } catch (err) {
      if (err.status === 409) {
        const ok = await confirmDialog({
          title: '文件已被外部修改',
          message: '磁盘上的这个文件在你编辑期间被其它程序改动了。强行保存会覆盖对方的修改。',
          okText: '仍然覆盖', cancelText: '重新载入', danger: true,
        });
        if (ok) return this.save(true);
        return this.reload();
      }
      if (err.status === 422 && err.payload?.detail) {
        const detail = err.payload.detail;
        s.lint = detail;
        if (s.editor) s.editor.setErrors(detail.errors);
        this.renderLint();
        this.goToError();
        toastErr(err.message);
        return;
      }
      toastErr(err.message);
    }
  }

  async reload() {
    const s = this.state;
    if (!s.name) return;
    if (s.dirty) {
      const ok = await confirmDialog({
        title: '重新载入',
        message: '当前未保存的修改将丢失，确定从磁盘重新读取吗？',
        okText: '重新载入', danger: true,
      });
      if (!ok) return;
    }
    await this.openFile(s.name);
    toastOk('已从磁盘重新载入');
  }

  format() {
    const s = this.state;
    if (!s.lint?.ok || !s.ast) { toastErr('存在语法错误，无法格式化'); return; }
    const unit = detectIndentUnit(s.text);
    const next = `${formatJson(s.ast, unit)}\n`;
    if (next === s.text) { toast('已经是规范格式', 'info', 1600); return; }
    this.commitText(next);
    toastOk('已统一缩进格式');
  }

  toggleReadonly() {
    const s = this.state;
    s.readonly = !s.readonly;
    if (s.editor) s.editor.setReadOnly(s.readonly);
    this.renderChrome();
    toast(s.readonly ? '已切换为只读' : '已解除只读', 'info', 1600);
  }

  /* ------------------------------------------------------------ 备份与对比 */
  async showBackups() {
    const s = this.state;
    if (!s.name) return;
    let backups = s.backups;
    try {
      backups = await api.get('/json/backups', { root: s.rootId, name: s.name });
    } catch (err) { toastErr(err.message); }
    const body = el('div', { class: 'col' }, [
      backups.length ? null : el('p', { class: 'muted', text: '暂无备份。每次保存前都会自动生成一份，保留最近 30 份。' }),
      ...backups.map((backup) => el('div', { class: 'row', style: 'border-bottom:1px solid var(--border);padding:6px 0' }, [
        el('div', { class: 'col', style: 'flex:1;gap:0' }, [
          el('span', { class: 'mono', text: backup.stamp }),
          el('span', { class: 'muted small', text: `${backup.sizeText} · ${backup.mtimeText}` }),
        ]),
        el('button', { class: 'btn sm', text: '查看差异', onclick: () => { close(); this.showDiff(null, backup); } }),
        el('button', { class: 'btn sm', text: '还原', onclick: () => { close(); this.restoreBackup(backup); } }),
      ])),
    ]);
    const close = this.openModalSafe({ title: `备份历史 · ${s.name}`, body, wide: true });
  }

  async restoreBackup(backup) {
    const s = this.state;
    const ok = await confirmDialog({
      title: '还原备份',
      message: `将用 ${backup.stamp} 的备份覆盖当前磁盘文件（当前内容会先自动备份一次）。`,
      okText: '还原', danger: true,
    });
    if (!ok) return;
    try {
      const data = await api.post('/json/restore', { root: s.rootId, name: s.name, backupId: backup.id });
      s.meta = data;
      s.baseline = data.text;
      s.text = data.text;
      s.backups = data.backups || [];
      s.dirty = false;
      s.lint = data.lint;
      s.ast = parseJson(data.text).root;
      if (s.editor) s.editor.setValue(data.text, { silent: true });
      this.renderTree();
      this.renderLint();
      this.renderChrome();
      this.updateStatus();
      toastOk('已还原备份');
    } catch (err) { toastErr(err.message); }
  }

  async showDiffChooser() {
    const s = this.state;
    const body = el('div', { class: 'col' }, [
      el('p', { class: 'muted', text: '选择对比基准：' }),
      el('button', {
        class: 'btn', text: '与磁盘当前内容对比（查看本次改了哪些）',
        onclick: () => { close(); this.showDiff(null, null); },
      }),
      ...s.backups.slice(0, 6).map((backup) => el('button', {
        class: 'btn', text: `与备份 ${backup.stamp} 对比`,
        onclick: () => { close(); this.showDiff(null, backup); },
      })),
    ]);
    const close = this.openModalSafe({ title: '选择对比基准', body });
  }

  async showDiff(_unused, backup) {
    const s = this.state;
    this.setMode('diff');
    const host = clear(this.el.diffHost);
    let leftText;
    let leftLabel;
    if (backup) {
      try {
        const data = await api.get('/json/diff', { root: s.rootId, name: s.name, backup: backup.id });
        leftText = data.left.text;
        leftLabel = data.leftLabel;
      } catch (err) { toastErr(err.message); return; }
    } else {
      leftText = s.baseline;
      leftLabel = '磁盘当前内容';
    }
    const rightText = s.text;
    const result = diffLines(leftText, rightText);
    const changes = result.stats || { added: 0, removed: 0 };
    host.appendChild(el('div', { class: 'diff-head' }, [
      el('span', { text: `${leftLabel}  →  编辑器内容` }),
      el('span', { text: `+${changes.added}  −${changes.removed}` }),
    ]));
    const wrap = el('div', { class: 'diff' });
    let shown = 0;
    for (const op of result.ops) {
      if (op.type === 'eq') continue;
      wrap.appendChild(el('div', { class: `diff-line ${op.type}` }, [
        el('span', { class: 'no', text: op.leftNo ? String(op.leftNo) : '' }),
        el('span', { class: 'no r', text: op.rightNo ? String(op.rightNo) : '' }),
        el('span', { class: 'txt', text: op.text || ' ' }),
      ]));
      shown += 1;
      if (shown > 3000) {
        wrap.appendChild(el('div', { class: 'muted', style: 'padding:8px 12px', text: '差异过多，已截断显示' }));
        break;
      }
    }
    if (!shown) {
      wrap.appendChild(el('div', { class: 'muted', style: 'padding:16px', text: '没有差异 ✓' }));
    }
    host.appendChild(wrap);
  }

  openModalSafe({ title, body, wide = false }) {
    const mask = el('div', { class: 'modal-mask' });
    const close = () => mask.remove();
    const dialog = el('div', { class: `modal${wide ? ' wide' : ''}` }, [
      el('div', { class: 'modal-head' }, [
        el('span', { text: title }), el('span', { class: 'spacer' }),
        el('button', { class: 'icon-btn', text: '✕', onclick: close }),
      ]),
      el('div', { class: 'modal-body' }, [body]),
    ]);
    mask.appendChild(dialog);
    mask.addEventListener('mousedown', (event) => { if (event.target === mask) close(); });
    document.getElementById('modal-root').appendChild(mask);
    return close;
  }

  /* ------------------------------------------------------------ 键盘与可见性 */
  onShow() { this.hidden = false; }

  onHide() { this.hidden = true; }

  bindKeys() {
    this.onKey = (event) => {
      if (this.hidden) return; // 页签隐藏时不响应快捷键，避免误存别的视图
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 's') {
        event.preventDefault();
        this.save();
        return;
      }
      if (event.key === 'F8') {
        event.preventDefault();
        this.goToError();
        return;
      }
      if (event.key === 'F5') {
        event.preventDefault();
        this.loadFiles();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey && this.state.mode === 'tree') {
        event.preventDefault();
        this.undo();
      }
      if ((event.ctrlKey || event.metaKey) && (key === 'y' || (key === 'z' && event.shiftKey)) && this.state.mode === 'tree') {
        event.preventDefault();
        this.redo();
      }
    };
    document.addEventListener('keydown', this.onKey);
  }
}
