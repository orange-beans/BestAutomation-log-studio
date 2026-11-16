/* CDP 小工具：验证登录门禁的完整流程。
   前置：服务端以 STUDIO_AUTH_FILE 指向独立账号文件启动（默认密码 Admin12345）。
   用法：node tests/cdp-auth-test.mjs <debugPort> <baseUrl>
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

const results = [];
const expect = (ok, label, extra = '') => {
  results.push({ ok, label, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${extra ? ` (${extra})` : ''}`);
};

// 1) 全新浏览器直接访问 -> 应该停在登录页
await client.send('Page.navigate', { url: `${base}/` });
await sleep(1500);
const initial = await evaluateRetry(`(async () => ({
  hasLogin: !!document.querySelector('#login-root'),
  tabs: document.querySelectorAll('#tabs .tab').length,
  title: document.querySelector('.login-title')?.textContent || '',
  apiStatus: await fetch('/api/bootstrap').then(r => r.status).catch(() => -1)
}))()`, true);
expect(initial.hasLogin === true, '未登录时显示登录页');
expect(initial.tabs === 0, '未登录时不渲染工作台页签', `tabs=${initial.tabs}`);
expect(initial.apiStatus === 401, '未登录调用业务接口返回 401', `status=${initial.apiStatus}`);

// 2) 错误密码 -> 提示错误，仍停在登录页
const wrong = await evaluateRetry(`(async () => {
  document.querySelector('.login-input[type="password"]').value = 'wrong-pass';
  document.querySelector('.login-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  return {
    hasLogin: !!document.querySelector('#login-root'),
    error: document.querySelector('.login-error:not(.hidden)')?.textContent || '',
  };
})()`, true);
expect(wrong.hasLogin === true, '密码错误后仍停在登录页');
expect(/不正确|错误|锁定/.test(wrong.error), '密码错误有明确提示', wrong.error);

// 3) 正确密码 -> 进入工作台
const ok = await evaluateRetry(`(async () => {
  document.querySelector('.login-input[type="password"]').value = 'Admin12345';
  document.querySelector('.login-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 2000));
  return {
    hasLogin: !!document.querySelector('#login-root'),
    tabs: [...document.querySelectorAll('#tabs .tab')].map(t => t.textContent),
    user: document.querySelector('.user-chip .user-name')?.textContent || '',
    initialWarn: document.querySelector('.user-chip')?.classList.contains('warn') || false,
  };
})()`, true);
expect(ok.hasLogin === false, '登录成功后关闭登录页');
expect(ok.tabs.length >= 3, '登录后渲染页签', ok.tabs.join('/'));
expect(ok.user === 'admin', '顶栏显示当前用户', ok.user);
expect(ok.initialWarn === true, '初始密码状态下有醒目提示');

// 4) 刷新后仍在登录态（同一浏览器会话）
await client.send('Page.navigate', { url: `${base}/#logs` });
await sleep(2000);
const afterReload = await evaluateRetry(`({
  hasLogin: !!document.querySelector('#login-root'),
  tabs: document.querySelectorAll('#tabs .tab').length
})`);
expect(afterReload.hasLogin === false && afterReload.tabs >= 3, '刷新后保持登录（会话 Cookie 生效）');

// 5) 退出登录 -> 回到登录页
const opened = await evaluateRetry(`(async () => {
  const chip = document.querySelector('.user-chip');
  if (!chip) return false;
  chip.click();
  await new Promise(r => setTimeout(r, 400));
  return !![...document.querySelectorAll('.modal .btn')].find(b => b.textContent.includes('退出登录'));
})()`, true);
expect(opened === true, '账号面板中有退出登录按钮');

// 点击退出会触发页面重载，执行上下文会被销毁，这里忽略这次调用的异常
try {
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.modal .btn')].find(b => b.textContent.includes('退出登录'));
    if (btn) btn.click();
    return true;
  })()`);
} catch { /* 页面正在刷新 */ }
await sleep(2200);
const back = await evaluateRetry(`({ hasLogin: !!document.querySelector('#login-root') })`);
expect(back.hasLogin === true, '退出后回到登录页');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
client.close();
process.exit(failed ? 1 : 0);
