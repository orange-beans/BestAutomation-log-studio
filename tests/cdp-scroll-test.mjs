/* CDP 小工具：在真实浏览器里验证"点击日志条目后列表是否跳回顶部"。
   用法：node tools/cdp-scroll-test.mjs <debugPort> <pageUrlFragment>
   依赖：Node 22+（自带 WebSocket），无需安装第三方包。 */

const port = Number(process.argv[2] || 9222);
const targetFragment = process.argv[3] || '#logs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const pages = await res.json();
      const page = pages.find((p) => p.type === 'page');
      if (page) return page;
    } catch { /* 浏览器还没起来 */ }
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
// 切到日志页签（同一实例重复运行时也能正确进入）
await client.send('Page.navigate', { url: `http://127.0.0.1:${new URL(page.url).port}${targetFragment}` });

// 需要登录时自动登录（默认账号）
await sleep(1200);
const loggedIn = await client.send('Runtime.evaluate', {
  expression: '!document.querySelector("#login-root")', returnByValue: true,
}).then((r) => r.result.value);
if (!loggedIn) {
  await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const pwd = document.querySelector('.login-input[type="password"]');
      if (!pwd) return false;
      pwd.value = 'Admin12345';
      document.querySelector('.login-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 1500));
      return true;
    })()`,
    awaitPromise: true, returnByValue: true,
  });
  await client.send('Page.navigate', { url: `http://127.0.0.1:${new URL(page.url).port}${targetFragment}` });
  await sleep(1500);
}

// 等页面进入日志页签
const waitFor = async () => {
  for (let i = 0; i < 40; i += 1) {
    const { result } = await client.send('Runtime.evaluate', {
      expression: 'document.querySelectorAll(".log-item").length',
      returnByValue: true,
    });
    if (result.value > 0) return result.value;
    await sleep(300);
  }
  return 0;
};
const count = await waitFor();
if (!count) {
  console.log('FAIL: 日志列表没有渲染出来');
  client.close();
  process.exit(1);
}

const expression = `(async () => {
  const list = document.querySelector('.log-list');
  const scroller = list.closest('.panel-body');
  scroller.scrollTop = scroller.scrollHeight;
  await new Promise(r => setTimeout(r, 120));
  const before = Math.round(scroller.scrollTop);
  const items = [...list.querySelectorAll('.log-item')];
  // 点一个靠底部、当前没有被选中的条目
  const target = items.filter(i => !i.classList.contains('active')).pop() || items[items.length - 1];
  const name = target.dataset.name;
  target.click();
  await new Promise(r => setTimeout(r, 1200));
  const after = Math.round(scroller.scrollTop);
  const active = document.querySelector('.log-item.active')?.dataset.name;
  return { before, after, delta: after - before, clicked: name, active,
           scrollHeight: Math.round(scroller.scrollHeight), clientHeight: Math.round(scroller.clientHeight) };
})()`;

const { result } = await client.send('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
});

const data = result.value || {};
console.log(JSON.stringify(data, null, 2));

const scrolled = data.before > 50;
const kept = scrolled && Math.abs(data.delta) < 5 && data.active === data.clicked;
console.log(scrolled ? (kept ? 'PASS: 点击后滚动位置保持不变' : 'FAIL: 点击后滚动位置被重置') : 'SKIP: 列表太短，无法验证');
client.close();
process.exit(kept ? 0 : scrolled ? 1 : 0);
