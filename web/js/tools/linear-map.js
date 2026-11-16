/* ===========================================================================
   linear-map.js —— 线性映射计算器
   已知两点 (x1 → y1)、(x2 → y2)，求 y = A·x + B，并给出：
     · 计算过程（A、B 的推导）
     · 两点回代校验
     · 反解 x = (y − B) / A
     · 任意值代入（x→y、y→x）
   参考：0.55 → 0.095，0.70 → 0.105 ⇒ y = 0.06667x + 0.05833
   =========================================================================== */

import { el, clear, toast, copyText, store } from '../core.js';

export const id = 'linear-map';
export const title = '线性映射计算器';
export const desc = '两点求 y = Ax + B';
export const icon = 'ƒ';

const DEFAULTS = { x1: '0.55', y1: '0.095', x2: '0.70', y2: '0.105' };

export function mount(root) {
  const state = {
    ...DEFAULTS,
    decimals: Number(store.get('calc.decimals', 5)) || 5,
    swap: false,
  };

  const input = (key, label) => {
    const field = el('input', {
      class: 'calc-input',
      type: 'text',
      inputmode: 'decimal',
      value: state[key],
      'aria-label': label,
      oninput: (event) => {
        state[key] = event.target.value;
        update();
      },
    });
    return { key, node: field };
  };

  const f1 = input('x1', 'x 起始');
  const f2 = input('y1', 'y 起始');
  const f3 = input('x2', 'x 结束');
  const f4 = input('y2', 'y 结束');

  const decSelect = el('select', { class: 'select', style: 'height:32px' },
    [2, 3, 4, 5, 6, 7, 8].map((n) => el('option', {
      value: String(n), text: `${n} 位小数`, selected: n === state.decimals,
    })));
  decSelect.addEventListener('change', () => {
    state.decimals = Number(decSelect.value);
    store.set('calc.decimals', state.decimals);
    update();
  });

  const swapBtn = el('button', {
    class: 'btn', text: '⇄ 反向映射', title: '把 y 的起始与结束对调，得到反方向的映射',
    onclick: () => {
      const t = state.y1; state.y1 = state.y2; state.y2 = t;
      f2.node.value = state.y1;
      f4.node.value = state.y2;
      update();
    },
  });
  const resetBtn = el('button', {
    class: 'btn ghost', text: '恢复示例',
    onclick: () => {
      Object.assign(state, DEFAULTS);
      f1.node.value = state.x1;
      f2.node.value = state.y1;
      f3.node.value = state.x2;
      f4.node.value = state.y2;
      update();
    },
  });

  const result = el('div');
  const copyBtn = el('button', {
    class: 'btn sm', text: '复制结果', onclick: () => copyResult(),
  });
  const copyHint = el('span', { class: 'muted small' });

  root.appendChild(el('div', { class: 'tool-wrap' }, [
    el('section', { class: 'calc-card' }, [
      el('div', { class: 'calc-card-title' }, [
        el('span', { text: '已知区间映射' }),
        el('span', { class: 'muted small', text: '按 起始 → 结束 依次填写 x 区间与 y 区间' }),
      ]),
      el('div', { class: 'calc-range' }, [
        el('span'),
        el('span', { class: 'calc-range-col', text: '起始' }),
        el('span'),
        el('span', { class: 'calc-range-col', text: '结束' }),

        el('span', { class: 'calc-range-axis', text: 'x' }),
        f1.node,
        el('span', { class: 'calc-range-dash', text: '—' }),
        f3.node,

        el('span', { class: 'calc-range-axis', text: 'y' }),
        f2.node,
        el('span', { class: 'calc-range-dash', text: '—' }),
        f4.node,
      ]),
      el('div', { class: 'calc-caption' }, [
        'x 区间整体映射到 y 区间：起始 ↔ 起始、结束 ↔ 结束。',
      ]),
      el('div', { class: 'calc-row', style: 'margin-top:12px' }, [
        decSelect, swapBtn, resetBtn, el('span', { class: 'spacer' }), copyBtn, copyHint,
      ]),
    ]),
    el('div', { class: 'calc-card' }, [
      el('div', { class: 'calc-card-title' }, ['结果']),
      result,
    ]),
  ]));

  /* ---------------------------------------------------------------- 计算 */
  const num = (value) => {
    const text = String(value).trim();
    if (!text) return NaN;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : NaN;
  };

  const fmt = (value, digits = state.decimals) => {
    if (!Number.isFinite(value)) return '—';
    if (value !== 0 && (Math.abs(value) >= 1e9 || Math.abs(value) < 1e-6)) {
      return value.toExponential(digits);
    }
    return value.toFixed(digits);
  };

  // 公式里省略多余的 0，更接近手写习惯（只处理小数点后的 0）
  const trim = (text) => (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text);

  // 给"精确值"用：保留 8 位有效数字，避免出现 0.06666666666666668 这种尾巴
  const sig = (value) => {
    if (!Number.isFinite(value)) return '—';
    const text = value.toPrecision(8);
    return text.includes('e') ? text : trim(text);
  };

  let lastGood = null;

  function compute() {
    const x1 = num(state.x1);
    const y1 = num(state.y1);
    const x2 = num(state.x2);
    const y2 = num(state.y2);
    if ([x1, y1, x2, y2].some((v) => Number.isNaN(v))) {
      return { ok: false, message: '请把四个输入框都填成数字（支持 1.5、-2、1e-3 这类写法）。' };
    }
    if (x1 === x2) {
      return { ok: false, message: `两点的 x 相同（都是 ${x1}），竖直方向无法确定唯一映射，请检查 x₁ 与 x₂。` };
    }
    const a = (y2 - y1) / (x2 - x1);
    const b = y1 - a * x1;
    return { ok: true, x1, y1, x2, y2, a, b };
  }

  /* ---------------------------------------------------------------- 渲染 */
  function renderError(message) {
    clear(result).appendChild(el('div', { class: 'calc-error', text: message }));
  }

  function render(data) {
    const d = state.decimals;
    const { x1, y1, x2, y2, a, b } = data;
    const aText = trim(a.toFixed(d));
    const bRounded = Number(Math.abs(b).toFixed(d));
    const sign = b < 0 && bRounded !== 0 ? '−' : '+';
    const formula = bRounded === 0
      ? `y = ${aText}x`
      : `y = ${aText}x ${sign} ${trim(bRounded.toFixed(d))}`;

    const yOut = el('b', { class: 'mono', text: trim(fmt(y1)) });
    const xOut = el('b', { class: 'mono', text: trim(fmt(x1)) });

    const card = (label, value, hint) => el('div', { class: 'calc-metric' }, [
      el('div', { class: 'calc-metric-label', text: label }),
      el('div', { class: 'calc-metric-value', text: value }),
      hint ? el('div', { class: 'calc-metric-hint', text: hint }) : null,
    ]);

    const verify = (x, y) => {
      const got = a * x + b;
      const diff = Math.abs(got - y);
      const ok = diff <= 0.5 * Math.pow(10, -d) + 1e-12;
      return { got, diff, ok };
    };
    const v1 = verify(x1, y1);
    const v2 = verify(x2, y2);

    const inverse = Math.abs(a) > 1e-15
      ? `x = ${trim((1 / a).toFixed(d))}·y ${(-b / a) < 0 ? '−' : '+'} ${trim(Math.abs(-b / a).toFixed(d))}`
      : '';

    const steps = [
      ['A = (y₂ − y₁) ÷ (x₂ − x₁)',
        `= (${trim(fmt(y2))} − ${trim(fmt(y1))}) ÷ (${trim(fmt(x2))} − ${trim(fmt(x1))})`,
        `= ${trim((y2 - y1).toFixed(d + 2))} ÷ ${trim((x2 - x1).toFixed(d + 2))}`,
        `= ${trim(a.toFixed(d))}`],
      ['B = y₁ − A·x₁',
        `= ${trim(fmt(y1))} − ${trim(a.toFixed(d))} × ${trim(fmt(x1))}`,
        `= ${trim(b.toFixed(d))}`],
    ];

    const body = el('div', { class: 'calc-body' }, [
      el('div', { class: 'calc-metrics' }, [
        card('A（斜率）', trim(a.toFixed(d)), `精确值 ${sig(a)}`),
        card('B（截距）', trim(b.toFixed(d)), `精确值 ${sig(b)}`),
      ]),
      el('div', { class: 'calc-formula' }, [formula]),
      el('div', { class: 'calc-sub', text: `${trim(fmt(x1))} → ${trim(fmt(y1))} ， ${trim(fmt(x2))} → ${trim(fmt(y2))}` }),

      el('div', { class: 'calc-section' }, [
        el('div', { class: 'calc-section-title', text: '反解（由 y 求 x）' }),
        inverse
          ? el('div', { class: 'calc-formula small', text: inverse })
          : el('div', { class: 'calc-muted', text: 'A = 0（y 恒为常数），没有反函数。' }),
      ]),

      el('div', { class: 'calc-section' }, [
        el('div', { class: 'calc-section-title', text: '回代校验' }),
        el('div', { class: 'calc-check' }, [
          el('span', { class: `chip ${v1.ok ? 'ok' : 'bad'}`, text: v1.ok ? '✓' : '✕' }),
          el('span', { class: 'mono', text: `x = ${trim(fmt(x1))} → y = ${trim(fmt(v1.got))}（目标 ${trim(fmt(y1))}）` }),
        ]),
        el('div', { class: 'calc-check' }, [
          el('span', { class: `chip ${v2.ok ? 'ok' : 'bad'}`, text: v2.ok ? '✓' : '✕' }),
          el('span', { class: 'mono', text: `x = ${trim(fmt(x2))} → y = ${trim(fmt(v2.got))}（目标 ${trim(fmt(y2))}）` }),
        ]),
      ]),

      el('div', { class: 'calc-section' }, [
        el('div', { class: 'calc-section-title', text: '计算过程' }),
        ...steps.map(([head, ...lines]) => el('div', { class: 'calc-step' }, [
          el('div', { class: 'mono', text: head }),
          ...lines.map((line) => el('div', { class: 'mono calc-step-line', text: line })),
        ])),
      ]),

      el('div', { class: 'calc-section' }, [
        el('div', { class: 'calc-section-title', text: '代入计算' }),
        el('div', { class: 'calc-inline' }, [
          el('span', { class: 'muted', text: 'x =' }),
          el('input', {
            class: 'calc-input sm', type: 'text', inputmode: 'decimal', value: trim(fmt(x1)),
            oninput: (event) => {
              const v = num(event.target.value);
              yOut.textContent = Number.isNaN(v) ? '—' : trim(fmt(a * v + b));
            },
          }),
          el('span', { class: 'muted', text: '→ y =' }),
          yOut,
        ]),
        el('div', { class: 'calc-inline' }, [
          el('span', { class: 'muted', text: 'y =' }),
          el('input', {
            class: 'calc-input sm', type: 'text', inputmode: 'decimal', value: trim(fmt(y1)),
            oninput: (event) => {
              const v = num(event.target.value);
              xOut.textContent = Number.isNaN(v) || Math.abs(a) < 1e-15 ? '—' : trim(fmt((v - b) / a));
            },
          }),
          el('span', { class: 'muted', text: '→ x =' }),
          xOut,
        ]),
      ]),
    ]);

    clear(result).appendChild(body);
    lastGood = { a, b, formula, inverse, x1, y1, x2, y2 };
  }

  function update() {
    const data = compute();
    if (!data.ok) {
      lastGood = null;
      renderError(data.message);
      return;
    }
    render(data);
  }

  function copyResult() {
    if (!lastGood) { toast('请先输入有效的两个点', 'warn'); return; }
    const d = state.decimals;
    const { a, b, formula, inverse, x1, y1, x2, y2 } = lastGood;
    const text = [
      '线性映射',
      `x 区间：${trim(fmt(x1))} → ${trim(fmt(x2))}`,
      `y 区间：${trim(fmt(y1))} → ${trim(fmt(y2))}`,
      `对应关系：${trim(fmt(x1))} → ${trim(fmt(y1))}，${trim(fmt(x2))} → ${trim(fmt(y2))}`,
      `A = ${trim(a.toFixed(d))}，B = ${trim(b.toFixed(d))}`,
      formula,
      inverse ? `反解：${inverse}` : '',
    ].filter(Boolean).join('\n');
    copyText(text).then(() => {
      copyHint.textContent = '已复制';
      setTimeout(() => { copyHint.textContent = ''; }, 1600);
    });
  }

  update();
}
