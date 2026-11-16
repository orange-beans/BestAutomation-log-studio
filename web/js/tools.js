/* ===========================================================================
   tools.js —— 实用工具页
   左侧工具列表，右侧工具内容。新增一个工具只需要：
     1) 在 tools/ 下新建模块，导出 { id, title, desc, mount }
     2) 在本文件顶部 import，并加入 TOOLS 数组
   =========================================================================== */

import { el, clear, emptyState } from './core.js';
import * as linearMap from './tools/linear-map.js';

const TOOLS = [
  linearMap,
];

export async function mount(root) {
  const sidebar = el('div', { class: 'tool-list' });
  const content = el('div', { class: 'tool-content' });

  const headTitle = el('span', { class: 'title', text: '实用工具' });
  const headDesc = el('span', { class: 'muted small' });
  const headActions = el('span', { class: 'row', style: 'gap:6px' });

  const workspace = el('div', { class: 'workspace two-col' }, [
    el('aside', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [el('span', { class: 'title', text: '工具列表' })]),
      el('div', { class: 'panel-body' }, [sidebar]),
      el('div', { class: 'panel-foot', text: `${TOOLS.length} 个工具 · 持续扩充` }),
    ]),
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [headTitle, headDesc, el('span', { class: 'spacer' }), headActions]),
      content,
    ]),
  ]);
  clear(root).appendChild(workspace);

  const open = async (tool) => {
    for (const item of sidebar.children) {
      item.classList.toggle('active', item.dataset.id === tool.id);
    }
    headTitle.textContent = tool.title;
    headDesc.textContent = tool.desc || '';
    clear(headActions);
    clear(content);
    const host = el('div', { class: 'tool-scroll' });
    content.appendChild(host);
    try {
      await tool.mount(host);
    } catch (err) {
      host.appendChild(emptyState('工具加载失败', String(err && err.message || err), '⚠'));
    }
  };

  for (const tool of TOOLS) {
    sidebar.appendChild(el('button', {
      class: 'file-item tool-item',
      dataset: { id: tool.id },
      onclick: () => open(tool),
    }, [
      el('div', { class: 'fi-top' }, [
        el('span', { class: 'tool-icon', text: tool.icon || '▦' }),
        el('span', { class: 'fi-name', text: tool.title }),
      ]),
      el('div', { class: 'fi-meta' }, [
        el('span', { text: tool.desc || '' }),
      ]),
    ]));
  }

  if (TOOLS.length) await open(TOOLS[0]);
}
