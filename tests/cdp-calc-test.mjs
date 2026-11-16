/* CDP 小工具：在真实浏览器里验证线性映射计算器的计算结果。
   用法：node tests/cdp-calc-test.mjs <debugPort> <baseUrl>
   依赖：Node 22+（自带 WebSocket），无需安装第三方包。 */

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
await client.send('Page.navigate', { url: `${base}/#tools` });

const evaluate = async (expression, awaitPromise = false) => {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(`页面脚本异常：${exceptionDetails.text} ${exceptionDetails.exception?.description || ''}`);
  }
  return result.value;
};

// 等工具页渲染
let ready = false;
for (let i = 0; i < 40; i += 1) {
  ready = await evaluate('!!document.querySelector(".calc-formula")');
  if (ready) break;
  await sleep(300);
}
if (!ready) {
  const diag = await evaluate(`JSON.stringify({
    href: location.href,
    tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent),
    selected: document.querySelector('.tab[aria-selected="true"]')?.textContent,
    toolScroll: !!document.querySelector('.tool-scroll'),
    errors: window.__studioErrors || [],
  })`);
  console.log('诊断：', diag);
  client.close();
  process.exit(1);
}

const result = await evaluate(`(async () => {
  const read = () => ({
    formula: document.querySelector('.calc-formula')?.textContent.trim(),
    inverse: document.querySelectorAll('.calc-formula')[1]?.textContent.trim(),
    metrics: [...document.querySelectorAll('.calc-metric-value')].map(e => e.textContent.trim()),
    checks: [...document.querySelectorAll('.calc-check .chip')].map(e => e.textContent.trim()),
  });
  const first = read();
  // 页面可滚动性（内容比视口高时必须能滚到底）
  const scroller = document.querySelector('.tool-scroll');
  scroller.scrollTop = scroller.scrollHeight;
  await new Promise(r => setTimeout(r, 100));
  const scroll = {
    scrollHeight: Math.round(scroller.scrollHeight),
    clientHeight: Math.round(scroller.clientHeight),
    scrollTop: Math.round(scroller.scrollTop),
  };
  scroller.scrollTop = 0;
  // 点击"反向映射"，得到反向公式
  const swap = [...document.querySelectorAll('button')].find(b => b.textContent.includes('反向映射'));
  swap.click();
  await new Promise(r => setTimeout(r, 300));
  const reversed = read();
  // 恢复示例
  const reset = [...document.querySelectorAll('button')].find(b => b.textContent.includes('恢复示例'));
  reset.click();
  await new Promise(r => setTimeout(r, 300));
  return { first, reversed, restored: read(), scroll };
})()`, true);

console.log(JSON.stringify(result, null, 2));

const expectations = [
  [result.first.formula === 'y = 0.06667x + 0.05833', '正向公式 y = 0.06667x + 0.05833'],
  [result.first.inverse === 'x = 15·y − 0.875', '反解 x = 15·y − 0.875'],
  [result.first.metrics[0] === '0.06667' && result.first.metrics[1] === '0.05833', 'A / B 数值正确'],
  [result.first.checks.every((c) => c === '✓'), '两点回代校验通过'],
  [result.reversed.formula === 'y = -0.06667x + 0.14167', '反向映射 y = -0.06667x + 0.14167'],
  [result.restored.formula === 'y = 0.06667x + 0.05833', '恢复示例后回到正向公式'],
  [result.scroll.scrollHeight > result.scroll.clientHeight + 20, '内容超出视口（可滚动）'],
  [result.scroll.scrollTop > 100, `可滚动到底部（scrollTop=${result.scroll.scrollTop}）`],
];

let failed = 0;
for (const [ok, label] of expectations) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failed += 1;
}
client.close();
process.exit(failed ? 1 : 0);
