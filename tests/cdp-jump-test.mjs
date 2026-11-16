/* CDP 回归：日志页「表格 ↔ 原文」双向跳转。
   前置：服务端已启动；浏览器以调试端口启动并打开工作台。
   用法：node tests/cdp-jump-test.mjs <debugPort> <baseUrl>
   说明：只点击界面、不写任何文件；使用默认账号登录。 */

const port = Number(process.argv[2] || 9222);
const base = process.argv[3] || 'http://127.0.0.1:8765';
const password = process.env.STUDIO_TEST_PASSWORD || 'Admin12345';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  const hosts = ['127.0.0.1', '[::1]'];
  for (let i = 0; i < 30; i += 1) {
    for (const host of hosts) {
      try {
        const res = await fetch(`http://${host}:${port}/json`);
        const pages = await res.json();
        const page = pages.find((p) => p.type === 'page');
        if (page) return page;
      } catch { /* 等待浏览器；有的环境只监听 IPv6 */ }
    }
    await sleep(300);
  }
  throw new Error('找不到可调试的页面');
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ready, send, close: () => ws.close() };
}

const page = await findPage();
const client = cdpClient(page.webSocketDebuggerUrl);
await client.ready;
await client.send('Runtime.enable');
await client.send('Page.enable');

async function evaluate(expression, awaitPromise = false) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  }
  return result.value;
}

async function evaluateRetry(expression, awaitPromise = false, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    try {
      return await evaluate(expression, awaitPromise);
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(300);
    }
  }
  return undefined;
}

async function waitFor(expression, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await evaluateRetry(expression).catch(() => false);
    if (value) return value;
    await sleep(250);
  }
  return false;
}

const results = [];
const expect = (ok, label, extra = '') => {
  results.push({ ok, label, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${extra ? ` (${extra})` : ''}`);
};

// 0) 打开日志页并登录
await client.send('Page.navigate', { url: `${base}/#logs` });
await sleep(1600);
const needLogin = await evaluateRetry(`!!document.querySelector('#login-root')`);
if (needLogin) {
  await evaluate(`(() => {
    const pw = document.querySelector('.login-input[type="password"]');
    pw.value = ${JSON.stringify(password)};
    document.querySelector('.login-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return true;
  })()`);
  await sleep(2200);
}
const loggedIn = await evaluateRetry(`!document.querySelector('#login-root')`);
expect(loggedIn === true, '进入工作台');
const hasLines = await waitFor(`document.querySelectorAll('.log-line').length > 0`);
expect(hasLines === true, '日志原文已渲染');

// 1) 表格 → 原文
await evaluate(`document.querySelector('.segmented .seg[data-mode="table"]').click()`);
await sleep(400);
const picked = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.log-table tbody tr[data-line]')];
  const normal = rows.filter((tr) => !tr.classList.contains('meta-row'));
  const tr = normal[Math.min(5, normal.length - 1)] || rows[0];
  return tr ? { line: Number(tr.dataset.line), normal: normal.length, total: rows.length } : null;
})()`);
expect(!!picked && picked.total > 0, '表格有可点击的行', picked ? `line=${picked.line}` : 'none');
if (picked) {
  await evaluate(`document.querySelector('.log-table tbody tr[data-line="${picked.line}"]').click()`);
  await sleep(350);
  const state = await evaluate(`(() => {
    const seg = document.querySelector('.segmented .seg[data-mode="raw"]');
    const line = document.querySelector('.log-line[data-line="${picked.line}"]');
    const host = line?.closest('.panel-body');
    const r = line?.getBoundingClientRect();
    const h = host?.getBoundingClientRect();
    return {
      selected: seg?.getAttribute('aria-selected'),
      found: !!line,
      jump: line?.classList.contains('jump') || false,
      visible: !!(r && h && r.top >= h.top - 2 && r.bottom <= h.bottom + 2),
    };
  })()`);
  expect(state.selected === 'true', '表格行点击后切到原文', `selected=${state.selected}`);
  expect(state.found === true, '原文中能找到对应行', `line=${picked.line}`);
  expect(state.jump === true, '原文目标行有跳转高亮');
  expect(state.visible === true, '原文目标行滚动到可视区域');
}

// 2) 原文 → 表格
if (picked) {
  await evaluate(`document.querySelector('.log-line[data-line="${picked.line}"]').click()`);
  await sleep(350);
  const back = await evaluate(`(() => {
    const seg = document.querySelector('.segmented .seg[data-mode="table"]');
    const tr = document.querySelector('.log-table tbody tr[data-line="${picked.line}"]');
    const host = tr?.closest('.panel-body');
    const r = tr?.getBoundingClientRect();
    const h = host?.getBoundingClientRect();
    return {
      selected: seg?.getAttribute('aria-selected'),
      found: !!tr,
      jump: tr?.classList.contains('jump') || false,
      visible: !!(r && h && r.top >= h.top - 2 && r.bottom <= h.bottom + 2),
    };
  })()`);
  expect(back.selected === 'true', '原文行点击后切回表格', `selected=${back.selected}`);
  expect(back.found === true, '表格中能找到对应行', `line=${picked.line}`);
  expect(back.jump === true, '表格目标行有跳转高亮');
  expect(back.visible === true, '表格目标行滚动到可视区域');
}

// 3) 表格排序后，原文 → 表格 仍能定位
const sortClicked = await evaluate(`(() => {
  const th = [...document.querySelectorAll('.log-table thead th')].find((t) => t.textContent.trim().startsWith('Res'));
  if (!th) return false;
  th.click();
  return true;
})()`);
expect(sortClicked === true, '可按 Res 列排序');
await sleep(350);
const sortInfo = await evaluate(`(() => {
  const th = [...document.querySelectorAll('.log-table thead th')].find((t) => t.textContent.trim().startsWith('Res'));
  return { arrow: th?.querySelector('.arrow')?.textContent || '', rows: document.querySelectorAll('.log-table tbody tr[data-line]').length };
})()`);
expect(!!sortInfo.arrow, '排序箭头已显示', sortInfo.arrow);
if (picked) {
  const target = await evaluate(`(() => {
    const tr = document.querySelector('.log-table tbody tr[data-line]');
    const line = Number(tr.dataset.line);
    document.querySelector('.segmented .seg[data-mode="raw"]').click();
    return line;
  })()`);
  await sleep(350);
  await evaluate(`document.querySelector('.log-line[data-line="${target}"]')?.click()`);
  await sleep(350);
  const sortedJump = await evaluate(`(() => {
    const tr = document.querySelector('.log-table tbody tr[data-line="${target}"]');
    return {
      tableSelected: document.querySelector('.segmented .seg[data-mode="table"]')?.getAttribute('aria-selected'),
      found: !!tr,
      jump: tr?.classList.contains('jump') || false,
    };
  })()`);
  expect(sortedJump.tableSelected === 'true' && sortedJump.found === true,
    '排序状态下原文 → 表格仍定位到正确行', `line=${target}`);
  expect(sortedJump.jump === true, '排序状态下目标行有高亮');
}

// 4) 搜索筛选后，原文 → 表格 仍能定位
await evaluate(`(() => {
  document.querySelector('.segmented .seg[data-mode="raw"]').click();
  const input = document.querySelector('.log-toolbar input[type="search"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'C1-3');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(350);
const filtered = await evaluate(`({
  lines: document.querySelectorAll('.log-line').length,
  count: document.querySelector('.log-line[data-line]')?.dataset.line || '',
})`);
expect(filtered.lines > 0 && filtered.lines < (picked?.total || 999),
  '搜索后原文行数减少', `lines=${filtered.lines}`);
if (filtered.lines > 0) {
  const firstLine = Number(filtered.count);
  await evaluate(`document.querySelector('.log-line[data-line="${firstLine}"]').click()`);
  await sleep(350);
  const filteredJump = await evaluate(`(() => {
    const tr = document.querySelector('.log-table tbody tr[data-line="${firstLine}"]');
    return {
      tableSelected: document.querySelector('.segmented .seg[data-mode="table"]')?.getAttribute('aria-selected'),
      found: !!tr,
      jump: tr?.classList.contains('jump') || false,
      visibleRows: document.querySelectorAll('.log-table tbody tr[data-line]').length,
    };
  })()`);
  expect(filteredJump.tableSelected === 'true' && filteredJump.found === true,
    '筛选状态下原文 → 表格仍定位到正确行', `line=${firstLine}`);
  expect(filteredJump.visibleRows === filtered.lines,
    '筛选结果在两种视图里一致', `table=${filteredJump.visibleRows} raw=${filtered.lines}`);
}
// 清空搜索，恢复全量
await evaluate(`(() => {
  const input = document.querySelector('.log-toolbar input[type="search"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(300);

// 5) 拖选文字时不触发跳转
const selectionGuard = await evaluate(`(() => {
  document.querySelector('.segmented .seg[data-mode="raw"]').click();
  const line = document.querySelector('.log-line[data-line]');
  const body = line?.querySelector('.body');
  if (!body) return { ok: false };
  const range = document.createRange();
  range.selectNodeContents(body);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  line.click();
  const mode = document.querySelector('.segmented .seg[data-mode="raw"]')?.getAttribute('aria-selected');
  const after = { raw: mode === 'true', table: document.querySelector('.segmented .seg[data-mode="table"]')?.getAttribute('aria-selected') === 'true' };
  sel.removeAllRanges();
  return { ok: true, ...after };
})()`);
expect(selectionGuard.ok === true && selectionGuard.raw === true,
  '选中文字后点击不跳转', JSON.stringify(selectionGuard));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
client.close();
process.exit(failed ? 1 : 0);
