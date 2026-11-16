/* ===========================================================================
   示例插件前端：日志统计
   与 plugins/example_plugin.py 配套，演示"加一个页签"只需要这一个文件 + 一个 .py
   =========================================================================== */

import { api, el, clear, formatBytes, emptyState, toastErr } from '../core.js';

export async function mount(root) {
  const host = clear(root);
  host.appendChild(el('div', { class: 'panel', style: 'height:100%' }, [
    el('div', { class: 'panel-head' }, [
      el('span', { class: 'title', text: '日志统计（示例插件）' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm', text: '刷新', onclick: () => load() }),
    ]),
    el('div', { class: 'panel-body', style: 'padding:14px' }, [el('div', { id: 'demo-body' })]),
  ]));

  const body = host.querySelector('#demo-body');

  async function load() {
    try {
      const data = await api.get('/demo/overview');
      clear(body);
      const cards = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px' });
      for (const [key, info] of Object.entries(data)) {
        if (info.error) {
          cards.appendChild(el('div', { class: 'lint-card bad' }, [
            el('div', { class: 'lint-head' }, [key]),
            el('div', { class: 'lint-body' }, [info.error]),
          ]));
          continue;
        }
        const levels = Object.entries(info.levels || {});
        cards.appendChild(el('div', { class: 'lint-card' }, [
          el('div', { class: 'lint-head' }, [key === 'logs' ? '运行日志' : '实验日志']),
          el('div', { class: 'lint-body' }, [
            el('div', { class: 'stat-grid' }, [
              el('span', { class: 'k', text: '文件数' }), el('span', { class: 'v', text: info.files }),
              el('span', { class: 'k', text: '总行数' }), el('span', { class: 'v', text: info.lines }),
              el('span', { class: 'k', text: '含错误的文件' }), el('span', { class: 'v', text: info.filesWithError }),
              el('span', { class: 'k', text: '最新一份' }),
              el('span', { class: 'v', text: info.latest ? info.latest.name : '—' }),
            ]),
            levels.length ? el('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px;margin-top:8px' },
              levels.map(([level, count]) => el('span', { class: 'chip', text: `${level} ${count}` }))) : null,
            info.latest ? el('div', { class: 'muted small', style: 'margin-top:8px' },
              [`${formatBytes(info.latest.size)} · ${info.latest.mtimeText}`]) : null,
          ]),
        ]));
      }
      body.appendChild(cards);
      body.appendChild(el('p', { class: 'hint muted', style: 'margin-top:16px' },
        ['这个页签完全由 plugins/example_plugin.py + web/js/plugins/demo.js 提供，删除插件不会影响主程序。']));
    } catch (err) {
      clear(body).appendChild(emptyState('统计失败', err.message, '⚠'));
      toastErr(err.message);
    }
  }

  await load();
}
