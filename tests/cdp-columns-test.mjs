/* CDP 回归：日志表格列显示策略。
   验证：测量身份列始终显示、常量派生列默认隐藏、列按钮计数、
         “全部显示/恢复默认”、按文件记住手动选择。
   用法：node tests/cdp-columns-test.mjs <debugPort> <baseUrl>
   说明：只点击界面、不写文件；默认账号 admin / Admin12345。 */

const port = Number(process.argv[2] || 9222);
const base = process.argv[3] || 'http://127.0.0.1:8765';
const password = process.env.STUDIO_TEST_PASSWORD || 'Admin12345';
const SAMPLE = '2026.11.11_1600_5d3.log';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 30; i += 1) {
    for (const host of ['127.0.0.1', '[::1]']) {
      try {
        const res = await fetch(`http://${host}:${port}/json`);
        const pages = await res.json();
        const page = pages.find((p) => p.type === 'page');
        if (page) return page;
      } catch { /* 等待浏览器 */ }
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

/* 页面内通用小工具：取表格数据列（去掉行/时间/级别）和“列”按钮 */
const PAGE_HELPERS = `
  window.__dataHeaders = () => [...document.querySelectorAll('.log-table thead th')]
    .map((th) => th.textContent.trim())
    .filter((h) => !['行', '时间', '级别'].includes(h));
  window.__colBtn = () => [...document.querySelectorAll('.log-toolbar button')]
    .find((b) => b.textContent.trim().startsWith('列'));
  window.__menuLabel = (name) => [...document.querySelectorAll('.col-menu label')]
    .find((label) => label.querySelector('span')?.textContent === name);
  window.__menuButton = (text) => [...document.querySelectorAll('.col-menu button')]
    .find((b) => b.textContent.trim() === text);
`;

// 0) 打开目标日志（query 指定文件，hash 指定页签）
await client.send('Page.navigate', { url: `${base}/?log=${encodeURIComponent(SAMPLE)}#logs` });
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
const hasRaw = await waitFor(`document.querySelectorAll('.log-line').length > 0`);
expect(hasRaw === true, '日志原文已渲染');

// 切到表格
await evaluate(`document.querySelector('.segmented .seg[data-mode="table"]').click()`);
await sleep(450);
await evaluate(PAGE_HELPERS);
const ready = await waitFor(`document.querySelectorAll('.log-table tbody tr[data-line]').length > 0`);
expect(ready === true, '表格已渲染');

// 1) 默认：tpB/pinB 显示，rawV 隐藏，按钮计数 6
let headers = await evaluate(`window.__dataHeaders()`);
const expectedDefault = ['Stp', 'tpA', 'tpB', 'pinA', 'pinB', 'range', 'V', 'Res'];
expect(headers.length === expectedDefault.length,
  '默认显示 8 个关键列', `headers=${headers.join(',')}`);
expect(expectedDefault.every((h) => headers.includes(h)),
  'Stp/tpA/tpB/pinA/pinB/range/V/Res 全部显示');
expect(!headers.includes('rawV') && !headers.includes('offset'),
  '常量派生列 rawV/offset 仍默认隐藏');
let btn = await evaluate(`window.__colBtn()?.textContent.trim() || ''`);
expect(btn === '列 · 隐藏 6', '列按钮显示隐藏数量', `btn=${btn}`);

// 2) 菜单：计数正确、tpB 勾选、rawV 未勾选
await evaluate(`window.__colBtn().click()`);
await sleep(250);
const menuInfo = await evaluate(`({
  head: document.querySelector('.col-menu .col-menu-head .muted')?.textContent.trim() || '',
  tpB: window.__menuLabel('tpB')?.querySelector('input')?.checked,
  rawV: window.__menuLabel('rawV')?.querySelector('input')?.checked,
  hasAll: !!window.__menuButton('全部显示'),
  hasReset: !!window.__menuButton('恢复默认'),
})`);
expect(menuInfo.head === '已隐藏 6 列', '菜单顶部显示隐藏数量', menuInfo.head);
expect(menuInfo.tpB === true, '菜单里 tpB 已勾选');
expect(menuInfo.rawV === false, '菜单里 rawV 未勾选');
expect(menuInfo.hasAll && menuInfo.hasReset, '菜单提供全部显示/恢复默认');

// 3) 全部显示 -> 14 列，按钮无隐藏计数
await evaluate(`window.__menuButton('全部显示').click()`);
await sleep(400);
headers = await evaluate(`window.__dataHeaders()`);
btn = await evaluate(`window.__colBtn()?.textContent.trim() || ''`);
expect(headers.length === 14, '全部显示后 14 列', `headers=${headers.join(',')}`);
expect(btn === '列', '全部显示后按钮恢复为“列”', `btn=${btn}`);

// 4) 恢复默认 -> 8 列 / 隐藏 6
await evaluate(`window.__colBtn().click()`);
await sleep(250);
await evaluate(`window.__menuButton('恢复默认').click()`);
await sleep(400);
headers = await evaluate(`window.__dataHeaders()`);
btn = await evaluate(`window.__colBtn()?.textContent.trim() || ''`);
expect(headers.length === 8 && btn === '列 · 隐藏 6', '恢复默认回到 8 列/隐藏 6',
  `headers=${headers.length} btn=${btn}`);

// 5) 手动勾选 calib -> 9 列 / 隐藏 5；菜单计数同步更新
await evaluate(`window.__colBtn().click()`);
await sleep(250);
await evaluate(`window.__menuLabel('calib').querySelector('input').click()`);
await sleep(400);
headers = await evaluate(`window.__dataHeaders()`);
btn = await evaluate(`window.__colBtn()?.textContent.trim() || ''`);
const menuHead = await evaluate(`document.querySelector('.col-menu .col-menu-head .muted')?.textContent.trim() || ''`);
expect(headers.includes('calib') && headers.length === 9, '手动勾选 calib 后显示 9 列',
  `headers=${headers.join(',')}`);
expect(btn === '列 · 隐藏 5' && menuHead === '已隐藏 5 列', '手选后计数同步',
  `btn=${btn} menu=${menuHead}`);

// 关掉菜单
await evaluate(`document.querySelector('.log-toolbar').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
await sleep(200);

// 6) 切到其他文件再回来，calib 选择应保留
const switched = await evaluate(`(() => {
  const cur = document.querySelector('.log-item.active')?.dataset.name;
  const other = [...document.querySelectorAll('.log-item[data-name]')].find((el) => el.dataset.name !== cur);
  if (!other) return false;
  other.click();
  return true;
})()`);
expect(switched === true, '切换到其他日志');
await sleep(700);
await evaluate(`document.querySelector('.log-item[data-name="${SAMPLE}"]').click()`);
await sleep(700);
headers = await evaluate(`window.__dataHeaders()`);
btn = await evaluate(`window.__colBtn()?.textContent.trim() || ''`);
expect(headers.includes('calib') && headers.length === 9,
  '切回原文件后手动列选择保留', `headers=${headers.join(',')}`);
expect(btn === '列 · 隐藏 5', '切回后计数仍为隐藏 5', `btn=${btn}`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
client.close();
process.exit(failed ? 1 : 0);
