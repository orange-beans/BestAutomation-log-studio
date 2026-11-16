/* ===========================================================================
   app.js —— 入口：读取启动信息、注册页签、主题与字号、帮助面板
   =========================================================================== */

import {
  api, el, clear, $, store, toast, toastErr,
  initTheme, initFontSize, applyTheme, registerTab, renderTabs, activateTab, hasTab,
  bindShortcut, initShortcuts, emptyState, resetViews,
} from './core.js';
import { showLogin, hideLogin, isLoginVisible, openAccount } from './auth.js';
import * as jsonview from './jsonview.js';
import * as logview from './logview.js';
import * as toolsview from './tools.js';

let boot = null;
let currentUser = null;

async function main() {
  let me = null;
  try {
    me = await api.get('/auth/me');
  } catch {
    me = null;
  }
  if (!me || !me.authenticated) {
    showLogin((data) => { startApp(data && data.user, data && data.initialPassword); });
    return;
  }
  await startApp(me.user, me.initialPassword);
}

/** 会话失效（401）时回到登录页 */
window.addEventListener('studio:unauthorized', () => {
  if (isLoginVisible()) return;
  showLogin(
    (data) => { startApp(data && data.user, data && data.initialPassword); },
    { message: '登录状态已失效，请重新登录。' },
  );
});

async function startApp(user = null, initialPassword = false) {
  currentUser = user;
  hideLogin();
  resetViews();

  try {
    boot = await api.get('/bootstrap');
  } catch (err) {
    document.body.appendChild(el('div', { class: 'modal-mask' }, [
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, ['无法连接本地服务']),
        el('div', { class: 'modal-body' }, [
          el('p', { text: '工作台前端已加载，但请求后端失败。' }),
          el('p', { class: 'hint', text: String(err.message || err) }),
          el('p', { class: 'hint', text: '请确认启动窗口没有关闭，然后刷新页面。' }),
        ]),
      ]),
    ]));
    return;
  }

  initTheme(boot.ui.theme);
  initFontSize(boot.ui.fontSize);
  // 允许用 URL 指定主题，便于截图/演示：?theme=dark
  const themeParam = new URLSearchParams(location.search).get('theme');
  if (themeParam) applyTheme(themeParam);

  const brandSub = $('#brand-sub');
  const mainRoot = boot.roots.json.find((r) => r.id === 'main') || boot.roots.json[0];
  if (brandSub && mainRoot) brandSub.textContent = mainRoot.path;

  if (user) mountUserChip(user, initialPassword);

  registerTab({ id: 'json', title: '配置编辑', order: 10, mount: jsonview.mount });
  registerTab({ id: 'logs', title: '日志查看', order: 20, mount: logview.mount });
  registerTab({ id: 'tools', title: '实用工具', order: 30, mount: toolsview.mount });

  // 插件页签：plugins/*.py 中 add_view 注册的模块
  for (const view of (boot.plugins?.views || [])) {
    if (!view.script) continue;
    registerTab({
      id: view.id,
      title: view.title,
      order: 50,
      mount: async (root) => {
        const module = await import(`/js/plugins/${view.script}`);
        return module.mount(root, { boot });
      },
    });
  }

  renderTabs();
  bindShortcut('?', () => showHelp(), '打开帮助');
  bindShortcut('ctrl+1', () => activateTab('json'), '切到配置编辑');
  bindShortcut('ctrl+2', () => activateTab('logs'), '切到日志查看');
  bindShortcut('ctrl+3', () => activateTab('tools'), '切到实用工具');
  bindShortcut('ctrl+0', () => activateTab('json'), '回到配置编辑');
  initShortcuts();

  $('#help-btn').addEventListener('click', () => showHelp());

  const missing = [...boot.roots.json, ...boot.roots.logs].filter((r) => !r.exists);
  if (missing.length) {
    toast(`有 ${missing.length} 个目录未找到：${missing.map((r) => r.label).join('、')}`, 'warn', 7000);
  }
  if (boot.plugins?.errors?.length) {
    toastErr(`插件加载失败：${boot.plugins.errors[0].file}`);
  }
  if (boot.env?.configError) {
    toastErr(boot.env.configError);
  }

  const fromHash = (location.hash || '').replace(/^#\/?/, '');
  const wanted = fromHash || store.get('activeTab', 'json');
  await activateTab(hasTab(wanted) ? wanted : 'json');
  window.addEventListener('hashchange', () => {
    const next = (location.hash || '').replace(/^#\/?/, '');
    if (!next) { activateTab('json'); return; }
    if (hasTab(next)) activateTab(next);
  });
}

/** 顶栏账号按钮：显示当前用户，点击可改密码 / 退出 */
function mountUserChip(user, initialPassword) {
  const right = $('.appbar-right');
  if (!right || right.querySelector('.user-chip')) return;

  const chip = el('button', {
    class: `user-chip${initialPassword ? ' warn' : ''}`,
    title: initialPassword ? '仍在使用初始密码，点击修改' : '账号与密码',
    onclick: () => openAccount({
      user: currentUser,
      initialPassword: chip.classList.contains('warn'),
      onLogout: () => location.reload(),
    }),
  }, [
    el('span', { class: 'user-avatar', text: (user.username || 'A').slice(0, 1).toUpperCase() }),
    el('span', { class: 'user-name', text: user.username }),
  ]);

  window.addEventListener('studio:password-changed', () => {
    chip.classList.remove('warn');
    chip.title = '账号与密码';
  });

  right.insertBefore(chip, right.firstChild);
}

function showHelp() {
  const body = el('div', { class: 'col', style: 'gap:14px' }, [
    el('div', {}, [
      el('div', { style: 'font-weight:600;margin-bottom:6px', text: '快捷键' }),
      el('table', { class: 'kbd-table' }, [
        ...[
          ['保存当前文件（仅当语法合法）', ['Ctrl', 'S']],
          ['跳到语法错误位置', ['F8']],
          ['刷新文件列表', ['F5']],
          ['结构视图撤销 / 重做', ['Ctrl', 'Z'], ['Ctrl', 'Y']],
          ['切换页签', ['Ctrl', '1'], ['Ctrl', '2'], ['Ctrl', '3']],
          ['放大 / 缩小字号', ['Ctrl', '='], ['Ctrl', '-']],
          ['打开本帮助', ['?']],
          ['关闭弹窗 / 结束编辑', ['Esc']],
        ].map(([label, ...keys]) => el('tr', {}, [
          el('td', { text: label }),
          el('td', {}, keys.flatMap((combo) => [
            ...combo.map((k) => el('kbd', { text: k })),
            el('span', { text: ' ' }),
          ])),
        ])),
      ]),
    ]),
    el('div', {}, [
      el('div', { style: 'font-weight:600;margin-bottom:6px', text: '文件与安全' }),
      el('p', { class: 'hint', text: '· 日志模块完全只读，没有任何写入接口。' }),
      el('p', { class: 'hint', text: '· JSON 保存前必须通过语法校验，语法不合法会阻止保存并定位错误。' }),
      el('p', { class: 'hint', text: '· 每次保存前自动备份到 studio/.tool-backups/，保留最近 30 份。' }),
      el('p', { class: 'hint', text: '· 保存会保留原文件的编码（UTF-8/BOM）、换行符（LF/CRLF）与缩进风格。' }),
      el('p', { class: 'hint', text: '· 服务只监听 127.0.0.1，不对外网开放。' }),
    ]),
    el('div', {}, [
      el('div', { style: 'font-weight:600;margin-bottom:6px', text: '目录' }),
      ...(boot ? [...boot.roots.json, ...boot.roots.logs].map((root) => el('p', {
        class: 'hint mono',
        style: 'word-break:break-all',
        text: `${root.exists ? '✓' : '✕'} ${root.label}  ${root.path}`,
      })) : []),
    ]),
    el('div', {}, [
      el('div', { style: 'font-weight:600;margin-bottom:6px', text: '关于' }),
      el('p', { class: 'hint', text: `版本 ${boot?.version || ''} · Python ${boot?.env?.python || ''} · 零第三方依赖` }),
      el('p', { class: 'hint', text: `程序目录 ${boot?.env?.studioDir || ''}` }),
      el('p', { class: 'hint', text: '扩展方式见 studio/plugins/README.md；新增一个 .py 即可多一个页签。' }),
    ]),
  ]);

  const mask = el('div', { class: 'modal-mask' });
  const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  const dialog = el('div', { class: 'modal wide' }, [
    el('div', { class: 'modal-head' }, [
      el('span', { text: '使用帮助' }), el('span', { class: 'spacer' }),
      el('button', { class: 'icon-btn', text: '✕', onclick: close }),
    ]),
    el('div', { class: 'modal-body' }, [body]),
  ]);
  mask.appendChild(dialog);
  mask.addEventListener('mousedown', (event) => { if (event.target === mask) close(); });
  document.getElementById('modal-root').appendChild(mask);
  document.addEventListener('keydown', onKey);
}

main();
