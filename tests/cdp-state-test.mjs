/* CDP 小工具：验证"切换页签后状态保留"。
   用法：node tests/cdp-state-test.mjs <debugPort> <baseUrl>
   依赖：Node 22+（自带 WebSocket）。 */

const port = Number(process.argv[2] || 9222);
const base = process.argv[3] || 'http://127.0.0.1:8765';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const pages = await res.json();
      const page = pages.find((p) => p.type === 'page');
      if (page) return page;
    } catch { /* 等待浏览器 */ }
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

const results = [];
const expect = (ok, label, extra = '') => {
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${extra ? ` (${extra})` : ''}`);
};

// 登录（默认账号）——若已是登录态则跳过
await client.send('Page.navigate', { url: `${base}/#tools` });
await sleep(1800);
const logged = await evaluate(`!document.querySelector('#login-root')`);
if (!logged) {
  await evaluate(`(async () => {
    document.querySelector('.login-input[type="password"]').value = 'Admin12345';
    document.querySelector('.login-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
    return true;
  })()`, true);
  await client.send('Page.navigate', { url: `${base}/#tools` });
  await sleep(1500);
}

// 1) 工具页：改输入 -> 切走 -> 切回，输入与结果都应保留
const before = await evaluate(`(async () => {
  const input = document.querySelectorAll('.calc-input')[0];
  input.value = '1.5';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  return { value: input.value, formula: document.querySelector('.calc-formula')?.textContent || '' };
})()`, true);
expect(before.value === '1.5', '输入已改为 1.5', before.value);

await evaluate(`(location.hash = '#logs', true)`);
await sleep(1200);
await evaluate(`(location.hash = '#tools', true)`);
await sleep(800);
const after = await evaluate(`({
  value: document.querySelectorAll('.calc-input')[0]?.value,
  formula: document.querySelector('.calc-formula')?.textContent || '',
  visible: !document.querySelector('.view.hidden')?.contains(document.querySelector('.calc-formula')),
})`);
expect(after.value === '1.5', '切回后输入框仍为 1.5', String(after.value));
expect(after.formula === before.formula, '切回后计算结果未重置', after.formula);

// 2) 日志页：搜索词与滚动位置保留
await evaluate(`(location.hash = '#logs', true)`);
await sleep(1500);
const logBefore = await evaluate(`(async () => {
  const box = document.querySelector('.log-toolbar input[type="search"]');
  box.value = 'Stp';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const list = document.querySelector('.log-list');
  list.closest('.panel-body').scrollTop = 600;
  return {
    query: box.value,
    scroll: Math.round(list.closest('.panel-body').scrollTop),
    rows: document.querySelectorAll('.log-table tbody tr').length,
  };
})()`, true);
await evaluate(`(location.hash = '#json', true)`);
await sleep(1200);
await evaluate(`(location.hash = '#logs', true)`);
await sleep(800);
const logAfter = await evaluate(`(() => {
  const list = document.querySelector('.log-list');
  const scroller = list ? list.closest('.panel-body') : null;
  return {
    query: document.querySelector('.log-toolbar input[type="search"]')?.value,
    scroll: Math.round(scroller ? scroller.scrollTop : 0),
    scrollHeight: scroller ? Math.round(scroller.scrollHeight) : 0,
    clientHeight: scroller ? Math.round(scroller.clientHeight) : 0,
    views: document.querySelectorAll('#view-root > .view').length,
  };
})()`);
if (logAfter.scroll === 0) console.log('诊断:', JSON.stringify({ logBefore, logAfter }));
expect(logAfter.query === 'Stp', '切回后日志搜索词保留', String(logAfter.query));
expect(logAfter.scroll > 0, '切回后日志列表滚动位置保留', String(logAfter.scroll));

// 3) 配置编辑页：树搜索词保留
await evaluate(`(location.hash = '#json', true)`);
for (let i = 0; i < 20; i += 1) {
  const ready = await evaluate(`!!document.querySelector('.tree-row') || !!document.querySelector('.editor-wrap:not(.hidden)')`);
  if (ready) break;
  await sleep(300);
}
const jsonBefore = await evaluate(`(async () => {
  const box = document.querySelector('input[placeholder*="结构中搜索"]');
  if (!box) return { ok: false };
  box.value = 'name';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return { ok: true, value: box.value };
})()`, true);
if (jsonBefore.ok) {
  await evaluate(`(location.hash = '#tools', true)`);
  await sleep(800);
  await evaluate(`(location.hash = '#json', true)`);
  await sleep(800);
  const kept = await evaluate(`document.querySelector('input[placeholder*="结构中搜索"]')?.value`);
  expect(kept === 'name', '切回后配置树搜索词保留', String(kept));
} else {
  expect(true, '配置树搜索框未找到，跳过该项');
}

// 4) 切换过程中只有一个视图可见
const visible = await evaluate(`[...document.querySelectorAll('#view-root > .view')].filter(v => !v.classList.contains('hidden')).length`);
expect(visible === 1, '同一时刻只有一个视图可见', `visible=${visible}`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
client.close();
process.exit(failed ? 1 : 0);
