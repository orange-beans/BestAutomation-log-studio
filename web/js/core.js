/* ===========================================================================
   core.js —— 基础设施：接口调用、DOM 助手、提示/弹窗、主题与字号、页签注册
   =========================================================================== */

/* ------------------------------------------------------------- DOM 助手 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const escapeHtml = (str) => String(str)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function debounce(fn, wait = 200) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const remain = wait - (now - last);
    if (remain <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...args);
      }, remain);
    }
  };
}

/* ------------------------------------------------------------- 格式化 */
export function formatBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return i === 0 ? `${value} B` : `${value.toFixed(1)} ${units[i]}`;
}

export function formatTime(ts, withDate = true) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time;
}

export function relativeTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return formatTime(ts).slice(0, 10);
}

/* ------------------------------------------------------------- 存储 */
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`studio.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`studio.${key}`, JSON.stringify(value)); } catch { /* 忽略 */ }
  },
};

/* ------------------------------------------------------------- 接口 */
export class ApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value != null) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function request(method, path, { params, body } = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`/api${path}${buildQuery(params)}`, options);
  } catch (err) {
    throw new ApiError('无法连接本地服务，请确认黑色启动窗口仍在运行', 0);
  }
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  if (!response.ok || (payload && payload.ok === false)) {
    const message = (payload && (payload.error || payload.message)) || `请求失败（HTTP ${response.status}）`;
    if (response.status === 401 && payload && payload.detail && payload.detail.code === 'unauthorized') {
      window.dispatchEvent(new CustomEvent('studio:unauthorized'));
    }
    throw new ApiError(message, response.status, payload);
  }
  return payload ? payload.data : null;
}

export const api = {
  get: (path, params) => request('GET', path, { params }),
  post: (path, body) => request('POST', path, { body }),
};

/* ------------------------------------------------------------- 提示 */
let toastSeq = 0;

export function toast(message, type = 'info', timeout = 3200) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const id = ++toastSeq;
  const node = el('div', { class: `toast ${type}`, dataset: { id } }, [
    el('div', { class: 'msg', text: message }),
    el('button', { class: 'close', title: '关闭', text: '✕', onclick: () => node.remove() }),
  ]);
  stack.appendChild(node);
  if (timeout > 0) setTimeout(() => { if (node.isConnected) node.remove(); }, timeout);
  return node;
}

export const toastOk = (msg) => toast(msg, 'ok');
export const toastErr = (msg) => toast(msg, 'err', 5200);
export const toastWarn = (msg) => toast(msg, 'warn', 4200);

/* ------------------------------------------------------------- 弹窗 */
function openModal({ title, body, footer, wide = false, onClose }) {
  const root = $('#modal-root');
  const mask = el('div', { class: 'modal-mask' });
  const dialog = el('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' });
  const close = (result) => {
    mask.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose(result);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(null); }
  };
  dialog.appendChild(el('div', { class: 'modal-head' }, [
    el('span', { text: title }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'icon-btn', text: '✕', title: '关闭', onclick: () => close(null) }),
  ]));
  dialog.appendChild(el('div', { class: 'modal-body' }, [body]));
  if (footer) dialog.appendChild(el('div', { class: 'modal-foot' }, footer));
  mask.appendChild(dialog);
  mask.addEventListener('mousedown', (event) => { if (event.target === mask) close(null); });
  root.appendChild(mask);
  document.addEventListener('keydown', onKey);
  return close;
}

export function confirmDialog({ title = '确认操作', message = '', okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const body = el('div', {}, [
      el('p', { text: message }),
    ]);
    const close = openModal({
      title,
      body,
      footer: [
        el('button', { class: 'btn', text: cancelText, onclick: () => { close(false); } }),
        el('button', {
          class: `btn ${danger ? 'danger' : 'primary'}`,
          text: okText,
          onclick: () => close(true),
        }),
      ],
      onClose: (result) => resolve(result === true),
    });
  });
}

export function promptDialog({ title = '输入', label = '', value = '', placeholder = '', okText = '确定' }) {
  return new Promise((resolve) => {
    const input = el('input', { class: 'input', value, placeholder, style: 'width:100%' });
    const body = el('div', { class: 'col' }, [
      label ? el('div', { class: 'small muted', text: label }) : null,
      input,
    ]);
    const close = openModal({
      title,
      body,
      footer: [
        el('button', { class: 'btn', text: '取消', onclick: () => close(null) }),
        el('button', { class: 'btn primary', text: okText, onclick: () => close(input.value) }),
      ],
      onClose: (result) => resolve(result),
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') close(input.value);
    });
  });
}

/* ------------------------------------------------------------- 主题与字号 */
const THEMES = ['light', 'paper', 'dark'];

export function applyTheme(theme) {
  const next = THEMES.includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
  $$('#theme-switch button').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeValue === next));
  });
}

export function initTheme(preferred) {
  const saved = store.get('theme', null);
  applyTheme(saved || preferred || 'light');
  $$('#theme-switch button').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeValue));
  });
}

export function applyFontSize(size) {
  const clamp = Math.min(22, Math.max(11, Math.round(size)));
  document.documentElement.style.setProperty('--ui-size', `${clamp}px`);
  store.set('fontSize', clamp);
}

export function initFontSize(preferred) {
  applyFontSize(store.get('fontSize', preferred || 14));
  const step = (delta) => applyFontSize(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-size')) + delta);
  $('#font-plus').addEventListener('click', () => step(1));
  $('#font-minus').addEventListener('click', () => step(-1));
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key === '=' || event.key === '+') { event.preventDefault(); step(1); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); step(-1); }
    else if (event.key === '0') { event.preventDefault(); applyFontSize(preferred || 14); }
  });
}

/* ------------------------------------------------------------- 页签 */
const tabs = new Map();
// 每个页签只挂载一次，之后靠显示/隐藏切换，这样滚动位置、输入内容、
// 展开状态、筛选条件都不会丢（视图可选实现 onShow / onHide）。
const mounted = new Map();
let activeTabId = null;
let activating = null;

export function registerTab({ id, title, mount, order = 100, badge = '' }) {
  tabs.set(id, { id, title, mount, order, badge });
}

export function renderTabs() {
  const nav = $('#tabs');
  clear(nav);
  const list = Array.from(tabs.values()).sort((a, b) => a.order - b.order);
  for (const tab of list) {
    nav.appendChild(el('button', {
      class: 'tab',
      role: 'tab',
      dataset: { tabId: tab.id },
      'aria-selected': String(tab.id === activeTabId),
      onclick: () => activateTab(tab.id),
    }, [tab.title]));
  }
  return list;
}

/** 重新登录等场景：丢弃所有已挂载视图，下次进入时重建。 */
export function resetViews() {
  for (const entry of mounted.values()) {
    try { entry.instance?.onHide?.(); } catch (err) { console.warn(err); }
  }
  mounted.clear();
  activeTabId = null;
  const root = $('#view-root');
  if (root) clear(root);
}

/** display:none 会让滚动位置归零，所以隐藏前记下来、显示后补回去。 */
function snapshotScroll(container) {
  const saved = [];
  for (const node of container.querySelectorAll('*')) {
    if (node.scrollTop > 0 || node.scrollLeft > 0) {
      saved.push([node, node.scrollTop, node.scrollLeft]);
    }
    if (saved.length > 200) break;
  }
  return saved;
}

function restoreScroll(saved) {
  for (const [node, top, left] of saved) {
    if (!node.isConnected) continue;
    node.scrollTop = top;
    node.scrollLeft = left;
  }
}

export async function activateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (activeTabId === id || activating === id) return;
  activating = id;
  try {
    // 隐藏上一个视图
    const previous = mounted.get(activeTabId);
    if (previous) {
      previous.scroll = snapshotScroll(previous.container);
      previous.container.classList.add('hidden');
      try { previous.instance?.onHide?.(); } catch (err) { console.warn(err); }
    }

    const root = $('#view-root');
    let entry = mounted.get(id);
    if (!entry) {
      const container = el('div', { class: 'view', style: 'height:100%' });
      root.appendChild(container);
      entry = { container, instance: null, scroll: null };
      mounted.set(id, entry);
      try {
        entry.instance = await tab.mount(container);
      } catch (err) {
        console.error(err);
        container.appendChild(el('div', { class: 'empty' }, [
          el('div', { class: 'empty-icon', text: '⚠' }),
          el('p', { class: 'empty-title', text: '模块加载失败' }),
          el('p', { class: 'empty-desc', text: String(err && err.message || err) }),
        ]));
      }
    }

    activeTabId = id;
    entry.container.classList.remove('hidden');
    try { entry.instance?.onShow?.(); } catch (err) { console.warn(err); }
    if (entry.scroll && entry.scroll.length) {
      const saved = entry.scroll;
      entry.scroll = null;
      requestAnimationFrame(() => restoreScroll(saved));
    }

    if (location.hash !== `#${id}`) {
      history.replaceState(null, '', `#${id}`);
    }
    $$('#tabs .tab').forEach((btn) => btn.setAttribute('aria-selected', String(btn.dataset.tabId === id)));
    store.set('activeTab', id);
  } finally {
    activating = null;
  }
}

export function activeTab() { return activeTabId; }

export function hasTab(id) { return tabs.has(id); }

/* ------------------------------------------------------------- 全局快捷键 */
const shortcuts = new Map();

export function bindShortcut(combo, handler, description = '') {
  shortcuts.set(combo.toLowerCase(), { combo, handler, description });
}

export function shortcutList() {
  return Array.from(shortcuts.values());
}

let shortcutsBound = false;

export function initShortcuts() {
  if (shortcutsBound) return;
  shortcutsBound = true;
  document.addEventListener('keydown', (event) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
    const parts = [];
    if (event.ctrlKey) parts.push('ctrl');
    if (event.altKey) parts.push('alt');
    if (event.shiftKey && key !== '?' && !/^[a-z0-9]$/.test(key)) parts.push('shift');
    parts.push(key);
    const combo = parts.join('+');
    const item = shortcuts.get(combo);
    if (!item) return;
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (typing && !combo.startsWith('ctrl')) return;
    event.preventDefault();
    item.handler(event);
  });
}

/* ------------------------------------------------------------- 文本高亮 */
export function highlightInto(text, query) {
  if (!query) return escapeHtml(text);
  const lowText = text.toLowerCase();
  const lowQuery = query.toLowerCase();
  let out = '';
  let index = 0;
  while (index < text.length) {
    const found = lowText.indexOf(lowQuery, index);
    if (found < 0) { out += escapeHtml(text.slice(index)); break; }
    out += escapeHtml(text.slice(index, found));
    out += `<mark>${escapeHtml(text.slice(found, found + query.length))}</mark>`;
    index = found + query.length;
  }
  return out;
}

/* ------------------------------------------------------------- 其他 */
export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); } catch { /* 忽略 */ }
  area.remove();
  return Promise.resolve();
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { href: url, download: filename });
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function emptyState(title, desc, icon = '◌') {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-icon', text: icon }),
    el('p', { class: 'empty-title', text: title }),
    el('p', { class: 'empty-desc', text: desc }),
  ]);
}
