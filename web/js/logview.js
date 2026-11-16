/* ===========================================================================
   logview.js —— 日志阅读器（只读）
   · 原文模式：时间淡显、级别配色、斑马纹、关键词高亮，长时间阅读不累眼
   · 表格模式：自动把 "key: value; key: value" 拆成列，可排序、可筛选、可隐藏列
   · 实验日志：头部信息卡 + 步序统计 + 不合格行整行标红 + 一键只看失败
   · 实时跟随：文件被写入时自动刷新（仅比较 mtime，不重复读盘）
   本模块不提供任何写入操作。
   =========================================================================== */

import {
  api, el, clear, formatBytes, formatTime, relativeTime, emptyState, toast,
  toastErr, copyText, highlightInto, escapeHtml, store,
} from './core.js';

const LINE_RE = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+\[([A-Za-z]+)\]:\s?([\s\S]*)$/;
const DATE_RE = /^(\d{4})[.\-](\d{2})[.\-](\d{2})/;
const KNOWN_ORDER = ['Stp', 'tpA', 'tpB', 'pinA', 'pinB', 'range', 'rawV', 'offset',
  'adjV', 'trickV', 'calibV', 'calib', 'V', 'Res'];
const MAX_RAW_LINES = 4000;
/* 测量身份/结果列：即使整列数值相同也始终显示，否则会看不出这组数据测的是哪一对点 */
const ALWAYS_VISIBLE = new Set(['Stp', 'tpA', 'tpB', 'pinA', 'pinB', 'range', 'V', 'Res']);

export async function mount(root) {
  const view = new LogView(root);
  await view.init();
  return view;
}

class LogView {
  constructor(root) {
    this.root = root;
    this.state = {
      roots: [],
      rootId: 'logs',
      files: [],
      filter: '',
      name: null,
      meta: null,
      text: '',
      mode: 'raw',
      query: '',
      levels: new Set(['SYSTEM', 'USER', 'EXPERIMENT', 'ERROR']),
      onlyFail: false,
      wrap: true,
      follow: false,
      rows: [],
      metaLines: [],
      columns: [],
      hidden: new Set(),
      defaultHidden: new Set(),
      showAllColumns: store.get('log.showAllColumns', false) === true,
      sort: { key: '', dir: 1 },
      jumpLine: 0,
      playing: false,
    };
    this.el = {};
    this.timer = null;
    this.hidden = false;
    /* 每个文件手动勾选/取消的列，键为 "rootId/文件名"，只在本次页面会话内保留 */
    this.columnPrefs = new Map();
  }

  async init() {
    const boot = await api.get('/bootstrap');
    this.state.roots = boot.roots.logs;
    const params = new URLSearchParams(location.search);
    if (params.get('mode') === 'table') this.state.mode = 'table';
    const usable = this.state.roots.filter((r) => r.exists);
    if (usable.length) {
      const experiment = usable.find((r) => r.id === 'experiment');
      this.state.rootId = (experiment || usable[0]).id;
    }
    this.buildLayout();
    await this.loadFiles();
    const wanted = params.get('log');
    const target = wanted ? this.state.files.find((f) => f.name === wanted) : null;
    if (target) await this.openFile(target.name);
    else if (this.state.files.length) await this.openFile(this.state.files[0].name);
  }

  /* ------------------------------------------------------------ 布局 */
  buildLayout() {
    const s = this.state;

    this.el.rootSelect = el('select', { class: 'select', style: 'max-width:110px' });
    this.el.rootSelect.addEventListener('change', async () => {
      s.rootId = this.el.rootSelect.value;
      s.name = null;
      await this.loadFiles();
      if (s.files.length) await this.openFile(s.files[0].name);
    });

    this.el.search = el('input', {
      class: 'input', type: 'search', placeholder: '过滤文件名…',
      oninput: (event) => {
        s.filter = event.target.value.trim().toLowerCase();
        this.renderFileList({ keepScroll: false });
      },
    });

    this.el.fileList = el('div', { class: 'log-list' });
    this.el.fileScroll = el('div', { class: 'panel-body' }, [this.el.fileList]);
    this.el.fileFoot = el('div', { class: 'panel-foot' });

    this.el.filesPanel = el('aside', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('span', { class: 'title', text: '日志文件' }),
        el('span', { class: 'spacer' }),
        this.el.rootSelect,
        el('button', {
          class: 'icon-btn', title: '刷新 (F5)', text: '⟳',
          onclick: () => this.refreshFiles(),
        }),
      ]),
      el('div', { style: 'padding:8px 8px 0' }, [this.el.search]),
      this.el.fileScroll,
      this.el.fileFoot,
    ]);

    this.el.title = el('span', { class: 'title' });
    this.el.subtitle = el('span', { class: 'muted small' });

    this.el.modeSeg = el('div', { class: 'segmented' }, [
      el('button', { class: 'seg', dataset: { mode: 'raw' }, text: '原文', onclick: () => this.setMode('raw') }),
      el('button', { class: 'seg', dataset: { mode: 'table' }, text: '表格', onclick: () => this.setMode('table') }),
    ]);

    this.el.searchBody = el('input', {
      class: 'input', type: 'search', placeholder: '搜索日志内容…',
      oninput: (event) => { s.query = event.target.value; this.renderContent(); },
    });

    this.el.levelChips = el('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap' });
    this.el.onlyFail = el('label', { class: 'check' }, [
      el('input', {
        type: 'checkbox',
        onchange: (event) => { s.onlyFail = event.target.checked; this.renderContent(); },
      }),
      el('span', { text: '只看不合格' }),
    ]);
    this.el.wrapToggle = el('label', { class: 'check' }, [
      el('input', {
        type: 'checkbox', checked: true,
        onchange: (event) => { s.wrap = event.target.checked; this.renderContent(); },
      }),
      el('span', { text: '自动换行' }),
    ]);
    this.el.followToggle = el('label', { class: 'check' }, [
      el('input', {
        type: 'checkbox',
        onchange: (event) => { s.follow = event.target.checked; this.setFollow(s.follow); },
      }),
      el('span', { text: '实时跟随' }),
    ]);
    this.el.colBtn = el('button', { class: 'btn sm', text: '列', title: '选择显示哪些列', onclick: () => this.toggleColumnMenu() });
    this.el.copyBtn = el('button', {
      class: 'btn sm', text: '复制表格',
      title: '把当前表格复制为纯文本（可直接粘贴到 Excel）',
      onclick: () => this.copyTable(),
    });

    this.el.toolbar = el('div', { class: 'log-toolbar' }, [
      this.el.modeSeg,
      el('div', { class: 'grow' }, [this.el.searchBody]),
      this.el.levelChips,
      this.el.onlyFail,
      this.el.wrapToggle,
      this.el.followToggle,
      this.el.colBtn,
      this.el.copyBtn,
    ]);

    this.el.statBar = el('div', { class: 'stat-bar' });
    this.el.metaCard = el('div', { class: 'hidden' });
    this.el.content = el('div', { class: 'panel-body' });

    this.el.mainPanel = el('section', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        this.el.title, this.el.subtitle, el('span', { class: 'spacer' }),
        el('button', {
          class: 'icon-btn', title: '滚动到顶部', text: '⇡',
          onclick: () => { this.el.content.scrollTop = 0; },
        }),
      ]),
      this.el.toolbar,
      this.el.statBar,
      this.el.metaCard,
      this.el.content,
    ]);

    this.el.workspace = el('div', { class: 'workspace' }, [this.el.filesPanel, this.el.mainPanel]);
    this.el.workspace.classList.add('no-inspector');
    clear(this.root).appendChild(this.el.workspace);

    document.addEventListener('keydown', this.onKey || (this.onKey = (event) => {
      if (this.hidden) return;
      if (event.key === 'F5') { event.preventDefault(); this.refreshFiles(); }
    }));
  }

  /* 页签显示/隐藏：隐藏时暂停"实时跟随"轮询，回来再恢复，避免后台空转 */
  onShow() {
    this.hidden = false;
    if (this.state.follow && !this.timer) this.setFollow(true, { silent: true });
  }

  onHide() {
    this.hidden = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setMode(mode) {
    this.state.mode = mode;
    for (const btn of this.el.modeSeg.children) {
      btn.setAttribute('aria-selected', String(btn.dataset.mode === mode));
    }
    this.el.wrapToggle.classList.toggle('hidden', mode !== 'raw');
    this.el.colBtn.classList.toggle('hidden', mode !== 'table');
    this.el.copyBtn.classList.toggle('hidden', mode !== 'table');
    this.renderContent();
  }

  /* ------------------------------------------------------------ 列表 */
  async loadFiles() {
    const s = this.state;
    try {
      const data = await api.get('/log/list', { root: s.rootId });
      s.files = data.files || [];
    } catch (err) {
      s.files = [];
      toastErr(err.message);
    }
    this.renderFileList();
    this.renderRootSelect();
  }

  async refreshFiles() {
    const before = this.state.files.map((f) => `${f.name}:${f.mtime}`).join('|');
    await this.loadFiles();
    const after = this.state.files.map((f) => `${f.name}:${f.mtime}`).join('|');
    if (this.state.follow) {
      if (before !== after) toast('日志列表已更新', 'info', 1600);
      if (this.state.name) await this.reloadIfChanged();
    }
    this.renderFileList();
  }

  renderRootSelect() {
    const s = this.state;
    clear(this.el.rootSelect);
    for (const root of s.roots) {
      this.el.rootSelect.appendChild(el('option', {
        value: root.id,
        text: root.exists ? root.label : `${root.label}（缺失）`,
        disabled: !root.exists,
      }));
    }
    this.el.rootSelect.value = s.rootId;
  }

  /** 只切换选中态，不重建列表（避免点击后滚动位置被重置到顶部）。 */
  markActive() {
    const s = this.state;
    for (const item of this.el.fileList.children) {
      if (!item.dataset || !item.dataset.name) continue;
      item.classList.toggle('active', item.dataset.name === s.name);
    }
  }

  renderFileList({ keepScroll = true } = {}) {
    const s = this.state;
    const scroller = this.el.fileScroll;
    const scrollTop = keepScroll && scroller ? scroller.scrollTop : 0;
    const host = clear(this.el.fileList);
    const files = s.files.filter((f) => !s.filter || f.name.toLowerCase().includes(s.filter));
    if (!files.length) {
      host.appendChild(el('div', { class: 'muted small', style: 'padding:10px', text: '没有日志文件' }));
      this.el.fileFoot.textContent = '';
      return;
    }
    let lastDate = '';
    const dateCount = new Map();
    for (const file of files) {
      const key = (DATE_RE.exec(file.name) || [])[0] || '';
      dateCount.set(key, (dateCount.get(key) || 0) + 1);
    }
    for (const file of files) {
      const match = DATE_RE.exec(file.name);
      const date = match ? `${match[1]}-${match[2]}-${match[3]}` : '';
      if (date && date !== lastDate) {
        lastDate = date;
        host.appendChild(el('div', {
          class: 'log-date',
          text: `${date} · ${dateCount.get((DATE_RE.exec(file.name) || [])[0] || '') || 0} 份`,
        }));
      }
      const levels = file.levels || {};
      const levelText = ['EXPERIMENT', 'ERROR', 'USER', 'SYSTEM']
        .filter((name) => levels[name]).map((name) => `${name.slice(0, 4)} ${levels[name]}`).join(' · ');
      host.appendChild(el('button', {
        class: `log-item${file.name === s.name ? ' active' : ''}`,
        dataset: { name: file.name },
        title: `${file.name}\n${file.lines || 0} 行 · ${formatBytes(file.size)}\n${levelText}`,
        onclick: () => this.openFile(file.name),
      }, [
        el('div', { class: 'li-name' }, [
          file.hasError ? el('span', { class: 'chip bad', text: 'ERR' }) : null,
          el('span', { text: this.shortName(file.name) }),
        ]),
        el('div', { class: 'li-meta' }, [
          el('span', { text: `${file.lines || 0} 行` }),
          el('span', { text: formatBytes(file.size) }),
          el('span', { text: relativeTime(file.mtime) }),
        ]),
      ]));
    }
    this.el.fileFoot.textContent = `${files.length} 份 · ${this.currentRoot()?.label || ''}`;
    if (scroller) scroller.scrollTop = scrollTop;
  }

  shortName(name) {
    return name.replace(/\.log$/i, '');
  }

  currentRoot() {
    return this.state.roots.find((r) => r.id === this.state.rootId);
  }

  /* ------------------------------------------------------------ 打开 */
  async openFile(name) {
    const s = this.state;
    document.querySelector('.col-menu')?.remove();
    try {
      const data = await api.get('/log/get', { root: s.rootId, name });
      s.name = name;
      s.meta = data;
      s.text = data.text;
      s.jumpLine = 0;
      this.parseContent();
      this.el.title.textContent = this.shortName(name);
      this.el.subtitle.textContent = `${data.lines} 行 · ${formatBytes(data.size)} · ${formatTime(data.mtime)}`;
      this.renderLevelChips();
      this.markActive();
      this.setMode(s.mode === 'table' ? 'table' : 'raw');
    } catch (err) {
      toastErr(`读取失败：${err.message}`);
    }
  }

  async reloadIfChanged() {
    const s = this.state;
    if (!s.name) return;
    try {
      const list = await api.get('/log/list', { root: s.rootId });
      const found = (list.files || []).find((f) => f.name === s.name);
      if (!found || !s.meta || Math.abs(found.mtime - s.meta.mtime) < 0.5) return;
      const data = await api.get('/log/get', { root: s.rootId, name: s.name });
      const atBottom = this.el.content.scrollTop + this.el.content.clientHeight >= this.el.content.scrollHeight - 40;
      s.meta = data;
      s.text = data.text;
      this.parseContent();
      this.el.subtitle.textContent = `${data.lines} 行 · ${formatBytes(data.size)} · ${formatTime(data.mtime)}`;
      this.renderLevelChips();
      this.renderContent();
      if (atBottom) this.el.content.scrollTop = this.el.content.scrollHeight;
    } catch { /* 文件可能正在写入，忽略本次 */ }
  }

  setFollow(enabled, { silent = false } = {}) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!enabled) return;
    this.timer = setInterval(() => this.refreshFiles(), 2000);
    if (!silent) toast('已开启实时跟随，每 2 秒检查一次', 'info', 2000);
  }

  /* ------------------------------------------------------------ 双向跳转 */
  /** 表格行 → 原文：切到原文，滚动到对应行并短暂高亮 */
  jumpToRaw(no) {
    this.state.jumpLine = no;
    this.setMode('raw');
  }

  /** 原文行 → 表格：先确认该行在当前筛选结果里，再切到表格定位 */
  jumpToTable(no) {
    if (!this.visibleRows().some((row) => row.no === no)) {
      toast('该行被当前搜索或筛选条件隐藏，表格里看不到', 'warn', 2800);
      return;
    }
    this.state.jumpLine = no;
    this.setMode('table');
  }

  /* ------------------------------------------------------------ 解析 */
  parseContent() {
    const s = this.state;
    const lines = s.text.split('\n');
    const rows = [];
    const metaLines = [];
    const columnSet = new Set();
    const counts = { SYSTEM: 0, USER: 0, EXPERIMENT: 0, ERROR: 0 };
    let index = 0;
    for (const raw of lines) {
      index += 1;
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      if (line.startsWith('#')) {
        metaLines.push(line);
        continue;
      }
      const match = LINE_RE.exec(line);
      if (!match) {
        rows.push({ no: index, time: '', level: '', msg: line, cells: {}, unmatched: true });
        continue;
      }
      const [, time, level, message] = match;
      const cells = {};
      for (const part of message.split(';')) {
        const piece = part.trim();
        if (!piece) continue;
        const at = piece.indexOf(':');
        if (at <= 0 || at > 24) continue;
        const key = piece.slice(0, at).trim();
        const value = piece.slice(at + 1).trim();
        if (!/^[\w\u4e00-\u9fa5 ]{1,24}$/.test(key)) continue;
        cells[key] = value;
        columnSet.add(key);
      }
      const fail = /✕|×|不合格/.test(cells.Res || '') || /ERROR/.test(level);
      counts[level] = (counts[level] || 0) + 1;
      rows.push({ no: index, time, level, msg: message, cells, fail });
    }
    const columns = Array.from(columnSet).sort((a, b) => {
      const ia = KNOWN_ORDER.indexOf(a);
      const ib = KNOWN_ORDER.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b, 'zh');
    });
    s.rows = rows;
    s.metaLines = metaLines;
    s.columns = columns;
    s.counts = counts;

    // 只隐藏“常量派生列”（rawV/offset/…）；测量身份列与结果列始终显示
    const constant = new Set();
    for (const column of columns) {
      const values = new Set();
      for (const row of rows) {
        if (row.unmatched) continue;
        values.add(row.cells[column] ?? '');
        if (values.size > 1) break;
      }
      if (values.size === 1 && !ALWAYS_VISIBLE.has(column)) constant.add(column);
    }
    s.constantColumns = constant;
    s.defaultHidden = new Set(constant);

    // 同一文件内记住用户手动勾选/取消的列；没有手动记录时才套用默认/全局“显示全部”
    const prefs = this.columnPrefs.get(this.fileKey());
    if (prefs) {
      s.hidden = new Set([...prefs].filter((column) => columns.includes(column)));
    } else {
      s.hidden = s.showAllColumns ? new Set() : new Set(constant);
    }
    this.updateColumnButton();
    this.updateColumnMenuCount();
  }

  fileKey() {
    const s = this.state;
    return s.name ? `${s.rootId}/${s.name}` : '';
  }

  updateColumnButton() {
    if (!this.el.colBtn) return;
    const s = this.state;
    const count = s.hidden.size;
    this.el.colBtn.textContent = count ? `列 · 隐藏 ${count}` : '列';
    this.el.colBtn.title = count
      ? `已隐藏 ${count} 列：${[...s.hidden].slice(0, 8).join('、')}${count > 8 ? '…' : ''}`
      : '选择显示哪些列';
  }

  setColumnVisible(column, visible) {
    const s = this.state;
    if (visible) s.hidden.delete(column);
    else s.hidden.add(column);
    this.columnPrefs.set(this.fileKey(), new Set(s.hidden));
    this.renderContent();
    this.updateColumnButton();
    this.updateColumnMenuCount();
  }

  updateColumnMenuCount() {
    if (!this.el.colMenuCount) return;
    const count = this.state.hidden.size;
    this.el.colMenuCount.textContent = count ? `已隐藏 ${count} 列` : '所有列已显示';
  }

  revealAllColumns() {
    const s = this.state;
    s.hidden.clear();
    s.showAllColumns = true;
    store.set('log.showAllColumns', true);
    this.columnPrefs.set(this.fileKey(), new Set());
    this.renderContent();
    this.updateColumnButton();
    this.updateColumnMenuCount();
  }

  resetColumns() {
    const s = this.state;
    s.hidden = new Set(s.defaultHidden);
    s.showAllColumns = false;
    store.set('log.showAllColumns', false);
    this.columnPrefs.set(this.fileKey(), new Set(s.hidden));
    this.renderContent();
    this.updateColumnButton();
    this.updateColumnMenuCount();
  }

  renderLevelChips() {
    const s = this.state;
    const host = clear(this.el.levelChips);
    const levels = Object.entries(s.counts || {})
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [level, count] of levels) {
      const active = s.levels.has(level);
      const chip = el('button', {
        class: `chip${active ? ' accent' : ''}`,
        style: 'cursor:pointer;border:1px solid var(--border)',
        title: active ? '点击隐藏该级别' : '点击显示该级别',
        onclick: () => {
          if (active) s.levels.delete(level); else s.levels.add(level);
          this.renderLevelChips();
          this.renderContent();
        },
      }, [`${level} ${count}`]);
      if (!active) chip.style.opacity = '.55';
      host.appendChild(chip);
    }
  }

  visibleRows() {
    const s = this.state;
    const query = s.query.trim().toLowerCase();
    return s.rows.filter((row) => {
      if (row.unmatched) return true;
      if (!s.levels.has(row.level)) return false;
      if (s.onlyFail && !row.fail) return false;
      if (query) {
        const hay = `${row.msg} ${Object.values(row.cells).join(' ')}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }

  /* ------------------------------------------------------------ 渲染 */
  renderContent() {
    const s = this.state;
    if (!s.name) {
      clear(this.el.content).appendChild(emptyState('尚未选择日志', '在左侧选择一份日志开始阅读', '☰'));
      clear(this.el.statBar);
      return;
    }
    this.renderMetaCard();
    this.renderStats();
    const rows = this.visibleRows();
    if (s.mode === 'table') this.renderTable(rows);
    else this.renderRaw(rows);
  }

  renderMetaCard() {
    const s = this.state;
    const host = this.el.metaCard;
    clear(host);
    if (!s.metaLines.length) { host.classList.add('hidden'); return; }
    host.classList.remove('hidden');
    const items = [];
    for (const line of s.metaLines) {
      const body = line.replace(/^#+\s*/, '');
      for (const part of body.split(';')) {
        const piece = part.trim();
        if (!piece) continue;
        const at = piece.indexOf(':');
        if (at > 0) items.push([piece.slice(0, at).trim(), piece.slice(at + 1).trim()]);
        else items.push(['说明', piece]);
      }
    }
    host.className = 'log-meta-card';
    for (const [key, value] of items) {
      host.appendChild(el('span', {}, [
        el('span', { class: 'k', text: key }),
        el('span', { class: 'v', text: value }),
      ]));
    }
  }

  renderStats() {
    const s = this.state;
    const host = clear(this.el.statBar);
    const rows = s.rows.filter((r) => !r.unmatched);
    const total = rows.length;
    const measured = rows.filter((r) => r.cells.Res);
    const passed = measured.filter((r) => !r.fail).length;
    const failed = measured.filter((r) => r.fail).length;
    const errors = rows.filter((r) => r.level === 'ERROR').length;
    const times = rows.map((r) => r.time).filter(Boolean).sort();
    let duration = '';
    if (times.length >= 2) {
      const toSec = (t) => {
        const [h, m, rest] = t.split(':');
        return Number(h) * 3600 + Number(m) * 60 + Number(rest);
      };
      const diff = toSec(times[times.length - 1]) - toSec(times[0]);
      duration = diff > 0 ? ` · 耗时 ${diff.toFixed(1)}s` : '';
    }
    const add = (label, value, cls = '') => host.appendChild(el('span', { class: `kv ${cls}` }, [
      el('span', { text: label }), el('b', { text: String(value) }),
    ]));
    add('行数', s.meta?.lines || total);
    add('有效记录', total);
    if (measured.length) {
      add('合格', passed, 'ok');
      add('不合格', failed, 'bad');
      add('不合格率', `${((failed / Math.max(1, measured.length)) * 100).toFixed(1)}%`, failed ? 'bad' : 'ok');
    }
    if (errors) add('ERROR', errors, 'bad');
    if (times.length) add('时间跨度', `${times[0]} → ${times[times.length - 1]}${duration}`);
    const visible = this.visibleRows().length;
    if (visible !== total && s.mode === 'table') add('当前显示', visible);
  }

  renderRaw(rows) {
    const s = this.state;
    const host = clear(this.el.content);
    const wrap = el('div', { class: `log-raw${s.wrap ? '' : ' nowrap'}` });
    const query = s.query.trim();
    const limit = Math.min(rows.length, MAX_RAW_LINES);
    for (let i = 0; i < limit; i += 1) {
      const row = rows[i];
      const classes = ['log-line'];
      if (row.unmatched) classes.push('meta');
      if (row.level === 'ERROR' || row.fail) classes.push('error');
      if (!s.wrap) classes.push('wrap-off');
      wrap.appendChild(el('div', {
        class: classes.join(' '),
        dataset: { line: String(row.no) },
        onclick: () => {
          if (hasTextSelection()) return;
          this.jumpToTable(row.no);
        },
      }, [
        el('span', { class: 'no', title: '点击在表格中查看此行', text: String(row.no) }),
        row.time ? el('span', { class: 'ts', text: row.time }) : null,
        row.level ? el('span', { class: `tag-level ${row.level}`, text: row.level }) : null,
        el('span', {
          class: 'body',
          html: query ? highlightInto(row.msg, query) : escapeHtml(row.msg),
        }),
      ]));
    }
    if (rows.length > limit) {
      wrap.appendChild(el('div', {
        class: 'muted', style: 'padding:12px',
        text: `仅显示前 ${limit} 行（共 ${rows.length} 行），可用搜索或"只看不合格"缩小范围。`,
      }));
    }
    host.appendChild(wrap);
    if (s.jumpLine) {
      const target = host.querySelector(`.log-line[data-line="${s.jumpLine}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('jump');
        setTimeout(() => target.classList.remove('jump'), 1800);
      } else if (s.jumpLine > MAX_RAW_LINES) {
        toast(`第 ${s.jumpLine} 行超出原文显示上限（${MAX_RAW_LINES} 行），未能定位`, 'warn', 3200);
      }
      s.jumpLine = 0;
    }
  }

  renderTable(rows) {
    const s = this.state;
    const host = clear(this.el.content);
    const columns = s.columns.filter((c) => !s.hidden.has(c));
    if (s.sort.key) {
      const key = s.sort.key;
      const dir = s.sort.dir;
      rows = [...rows].sort((a, b) => compareCell(a.cells[key], b.cells[key]) * dir);
    }
    const table = el('table', { class: 'log-table' });
    const thead = el('thead');
    const headRow = el('tr');
    for (const [key, label] of [['no', '行'], ['time', '时间'], ['level', '级别']]) {
      headRow.appendChild(this.headerCell(label, key));
    }
    for (const column of columns) {
      headRow.appendChild(this.headerCell(column, column));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    rows.forEach((row, index) => {
      if (row.unmatched) {
        tbody.appendChild(el('tr', {
          class: 'meta-row',
          dataset: { line: String(row.no) },
          title: `第 ${row.no} 行 · 点击跳到原文`,
          onclick: () => this.jumpToRaw(row.no),
        }, [
          el('td', { text: String(row.no) }),
          el('td', { text: '' }),
          el('td', { text: '原文' }),
          el('td', { colspan: String(Math.max(1, columns.length)), text: row.msg }),
        ]));
        return;
      }
      const tr = el('tr', {
        class: row.fail ? 'fail' : '',
        dataset: { line: String(row.no) },
        title: `第 ${row.no} 行 · 点击跳到原文`,
        onclick: () => this.jumpToRaw(row.no),
      }, [
        el('td', { class: 'rowno', text: String(row.no) }),
        el('td', { text: row.time }),
        el('td', { class: 'rowno', text: row.level }),
      ]);
      for (const column of columns) {
        const value = row.cells[column] ?? '';
        const isRes = column === 'Res';
        const isNum = ['rawV', 'adjV', 'trickV', 'calibV', 'V', 'offset', 'tpA', 'tpB', 'Stp'].includes(column);
        tr.appendChild(el('td', {
          class: `${isNum ? 'num' : ''} ${isRes ? (row.fail ? 'res-bad' : 'res-ok') : ''}`,
          text: value,
        }));
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
    if (s.jumpLine) {
      const target = tbody.querySelector(`tr[data-line="${s.jumpLine}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('jump');
        setTimeout(() => target.classList.remove('jump'), 1800);
      }
      s.jumpLine = 0;
    }
    if (!rows.length) {
      host.appendChild(emptyState('没有匹配的记录', '调整搜索关键词或级别筛选试试', '☰'));
    }
  }

  headerCell(label, key) {
    const s = this.state;
    const active = s.sort.key === key;
    const th = el('th', {
      onclick: () => {
        if (s.sort.key === key) s.sort.dir = -s.sort.dir;
        else { s.sort.key = key; s.sort.dir = 1; }
        this.renderContent();
      },
    }, [label]);
    if (active) th.appendChild(el('span', { class: 'arrow', text: s.sort.dir > 0 ? '▲' : '▼' }));
    return th;
  }

  toggleColumnMenu() {
    const existing = document.querySelector('.col-menu');
    if (existing) { existing.remove(); return; }
    const s = this.state;
    const hiddenCount = s.hidden.size;
    const menu = el('div', { class: 'col-menu' });
    const close = () => menu.remove();
    this.el.colMenuCount = el('span', {
      class: 'muted small',
      text: hiddenCount ? `已隐藏 ${hiddenCount} 列` : '所有列已显示',
    });
    menu.appendChild(el('div', { class: 'col-menu-head' }, [
      this.el.colMenuCount,
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn sm', text: '全部显示',
        onclick: () => { this.revealAllColumns(); close(); },
      }),
      el('button', {
        class: 'btn sm', text: '恢复默认',
        onclick: () => { this.resetColumns(); close(); },
      }),
    ]));
    menu.appendChild(el('div', { class: 'muted small', style: 'padding:2px 6px 6px' },
      ['测量身份/结果列始终显示；其余相同值列默认隐藏']));
    for (const column of s.columns) {
      const checkbox = el('input', {
        type: 'checkbox', checked: !s.hidden.has(column),
        onchange: (event) => this.setColumnVisible(column, event.target.checked),
      });
      menu.appendChild(el('label', {}, [
        checkbox,
        el('span', { text: column }),
        s.constantColumns?.has(column) ? el('span', { class: 'chip', text: '常量' }) : null,
      ]));
    }
    menu.style.position = 'fixed';
    const rect = this.el.colBtn.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.right - 230, window.innerWidth - 238))}px`;
    document.body.appendChild(menu);
    const closeOnClick = (event) => {
      if (!menu.contains(event.target) && event.target !== this.el.colBtn) {
        menu.remove();
        document.removeEventListener('mousedown', closeOnClick);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeOnClick), 0);
  }

  copyTable() {
    const s = this.state;
    if (!s.rows.length) { toast('没有可复制的数据', 'info', 1600); return; }
    const columns = s.columns.filter((c) => !s.hidden.has(c));
    const hiddenCount = s.hidden.size;
    const head = ['行', '时间', '级别', ...columns].join('\t');
    const rows = this.visibleRows().map((row) => [
      row.no, row.time, row.level, ...columns.map((c) => row.cells[c] ?? ''),
    ].join('\t'));
    copyText([head, ...rows].join('\n')).then(() => {
      if (hiddenCount) {
        toast(`已复制 ${columns.length} 列；另有 ${hiddenCount} 个隐藏列未包含（可在“列”中显示）`, 'warn', 3600);
      } else {
        toast('表格已复制（可直接粘贴到 Excel）', 'ok');
      }
    });
  }
}

function compareCell(a, b) {
  const av = a ?? '';
  const bv = b ?? '';
  const an = parseFloat(String(av).replace(/[^\d.eE+-]/g, ''));
  const bn = parseFloat(String(bv).replace(/[^\d.eE+-]/g, ''));
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
  return String(av).localeCompare(String(bv), 'zh', { numeric: true });
}

/** 原文里拖选文字（准备复制）时不触发跳转 */
function hasTextSelection() {
  const selection = window.getSelection();
  return Boolean(selection && String(selection).trim());
}
