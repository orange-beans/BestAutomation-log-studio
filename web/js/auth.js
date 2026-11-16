/* ===========================================================================
   auth.js —— 登录页与账号面板
   · showLogin(onSuccess)：未登录时覆盖整页，登录成功后回调
   · openAccount({user, onLogout})：查看账号、修改密码、退出登录
   密码只发给后端校验，前端不保存任何凭据。
   =========================================================================== */

import { api, el, clear, $, toast, toastOk, toastErr } from './core.js';

let loginVisible = false;

function loginRoot() {
  let root = $('#login-root');
  if (!root) {
    root = el('div', { id: 'login-root', class: 'login-mask' });
    document.body.appendChild(root);
  }
  return root;
}

export function hideLogin() {
  const root = $('#login-root');
  if (root) root.remove();
  loginVisible = false;
}

export function isLoginVisible() {
  return loginVisible;
}

/** 显示登录页；成功后调用 onSuccess()。 */
export function showLogin(onSuccess, { message = '' } = {}) {
  if (loginVisible) return;
  loginVisible = true;

  const root = loginRoot();
  clear(root);

  const error = el('div', { class: 'login-error hidden' });
  const userInput = el('input', {
    class: 'login-input', type: 'text', value: 'admin', autocomplete: 'username',
    spellcheck: 'false', 'aria-label': '用户名',
  });
  const passInput = el('input', {
    class: 'login-input', type: 'password', autocomplete: 'current-password',
    placeholder: '请输入密码', 'aria-label': '密码',
  });
  const submit = el('button', { class: 'btn primary login-submit', type: 'submit' }, ['登 录']);

  const form = el('form', { class: 'login-form' }, [
    el('label', { class: 'login-field' }, [el('span', { text: '用户名' }), userInput]),
    el('label', { class: 'login-field' }, [el('span', { text: '密码' }), passInput]),
    error,
    submit,
  ]);

  const card = el('div', { class: 'login-card' }, [
    el('div', { class: 'login-brand' }, [
      el('span', { class: 'login-logo', text: '▤' }),
      el('div', {}, [
        el('div', { class: 'login-title', text: 'JSON & 日志工作台' }),
        el('div', { class: 'login-sub', text: 'BestAutomation 配置与日志工具' }),
      ]),
    ]),
    el('div', { class: 'login-hint' }, ['需要登录后才能查看配置与日志。']),
    form,
  ]);

  root.appendChild(card);

  if (message) {
    error.textContent = message;
    error.classList.remove('hidden');
  }

  const setBusy = (busy) => {
    submit.disabled = busy;
    submit.textContent = busy ? '登录中…' : '登 录';
  };

  const fail = (text) => {
    error.textContent = text;
    error.classList.remove('hidden');
    passInput.value = '';
    passInput.focus();
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    error.classList.add('hidden');
    setBusy(true);
    try {
      const data = await api.post('/auth/login', {
        username: userInput.value.trim(),
        password: passInput.value,
      });
      hideLogin();
      toastOk(`欢迎，${data.user.username}`);
      if (onSuccess) onSuccess(data);
    } catch (err) {
      fail(err.message || '登录失败');
    } finally {
      setBusy(false);
    }
  });

  setTimeout(() => {
    if (userInput.value.trim()) passInput.focus();
    else userInput.focus();
  }, 60);
}

/** 账号面板：改密码 / 退出登录。 */
export function openAccount({ user, initialPassword = false, onLogout }) {
  const mask = el('div', { class: 'modal-mask' });
  const close = () => mask.remove();

  const oldInput = el('input', { class: 'input', type: 'password', placeholder: '当前密码' });
  const newInput = el('input', { class: 'input', type: 'password', placeholder: '新密码（至少 6 位）' });
  const confirmInput = el('input', { class: 'input', type: 'password', placeholder: '再输一次新密码' });
  const msg = el('div', { class: 'login-error hidden', style: 'margin-top:8px' });

  const submit = el('button', { class: 'btn primary', text: '保存新密码' });
  submit.addEventListener('click', async () => {
    msg.classList.add('hidden');
    if (!oldInput.value || !newInput.value) {
      msg.textContent = '请填写当前密码与新密码';
      msg.classList.remove('hidden');
      return;
    }
    if (newInput.value !== confirmInput.value) {
      msg.textContent = '两次输入的新密码不一致';
      msg.classList.remove('hidden');
      return;
    }
    submit.disabled = true;
    try {
      const data = await api.post('/auth/password', {
        oldPassword: oldInput.value,
        newPassword: newInput.value,
      });
      toastOk('密码已更新');
      window.dispatchEvent(new CustomEvent('studio:password-changed'));
      close();
      openAccount({ user: data.user, initialPassword: false, onLogout });
    } catch (err) {
      msg.textContent = err.message || '修改失败';
      msg.classList.remove('hidden');
    } finally {
      submit.disabled = false;
    }
  });

  const body = el('div', {}, [
    el('div', { class: 'account-head' }, [
      el('div', { class: 'account-avatar', text: (user.username || 'A').slice(0, 1).toUpperCase() }),
      el('div', {}, [
        el('div', { class: 'account-name', text: user.username }),
        el('div', { class: 'muted small', text: user.updated ? `密码更新于 ${user.updated}` : '' }),
      ]),
    ]),
    initialPassword
      ? el('div', { class: 'account-warn', text: '当前仍在使用初始密码，建议立即修改。' })
      : null,
    el('div', { class: 'account-section' }, [
      el('div', { class: 'account-title', text: '修改密码' }),
      el('div', { class: 'col', style: 'gap:8px' }, [oldInput, newInput, confirmInput]),
      msg,
      el('div', { class: 'row', style: 'margin-top:10px' }, [
        el('span', { class: 'spacer' }),
        submit,
      ]),
    ]),
  ]);

  const dialog = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [
      el('span', { text: '账号' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'icon-btn', text: '✕', onclick: close }),
    ]),
    el('div', { class: 'modal-body' }, [body]),
    el('div', { class: 'modal-foot' }, [
      el('button', {
        class: 'btn danger', text: '退出登录',
        onclick: async () => {
          try { await api.post('/auth/logout', {}); } catch { /* 忽略 */ }
          close();
          if (onLogout) onLogout();
        },
      }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', text: '关闭', onclick: close }),
    ]),
  ]);

  mask.appendChild(dialog);
  mask.addEventListener('mousedown', (event) => { if (event.target === mask) close(); });
  $('#modal-root').appendChild(mask);
  setTimeout(() => oldInput.focus(), 40);
  void toast;
  void toastErr;
}
