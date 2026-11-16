# 插件开发说明

工作台的每个"页签"都是一个插件。主程序只负责启动、路由、主题与安全边界，具体功能都在插件里。

## 最小示例

**1. 后端：`plugins/my_plugin.py`**

```python
def setup(registry):
    def hello(query, body):
        return {"msg": "hello"}

    registry.add_api("GET", "/api/my/hello", hello)
    registry.add_view(id="my-page", title="我的页面", script="my.js")
```

**2. 前端：`web/js/plugins/my.js`**

```js
export async function mount(root, ctx) {
  const data = await ctx.api.get('/my/hello');   // 自动带上 /api 前缀
  root.innerHTML = `<div style="padding:20px">${data.msg}</div>`;
}
```

重启工作台（或刷新页面 + 重启 Python），顶部就会多一个「我的页面」页签。

## 后端接口

`registry` 提供两个方法：

| 方法 | 说明 |
|---|---|
| `add_api(method, path, handler)` | 注册接口。`path` 以 `/api` 开头；`handler(query, body)` 返回可 JSON 序列化的数据 |
| `add_view(id, title, script="", icon="", description="")` | 注册页签；`script` 是 `web/js/plugins/` 下的文件名 |

- `GET` 请求：`query` 是查询参数字典（字符串值），`body` 为空字典
- `POST` 请求：`body` 已解析为 dict；`query` 是查询参数
- 返回 `dict` / `list` / 基本类型即可，框架会自动包成 `{"ok": true, "data": ...}`
- 抛异常会被框架捕获成 500 并打印到控制台，**不会拖垮主进程**
- 插件加载失败只会在控制台与"帮助"面板里提示，其他页签照常可用

## 前端模块

`mount(root, ctx)` 中：

- `root`：已经清空、高度 100% 的容器
- `ctx.boot`：启动信息（根目录、限制、配置）
- `ctx.api`：接口封装，`get(path, params)` / `post(path, body)`

可以复用的工具（`web/js/core.js`）：

```js
import { el, clear, toast, toastOk, toastErr, confirmDialog, promptDialog,
         formatBytes, formatTime, emptyState, copyText, store } from '../core.js';
```

以及 `web/js/parser.js` 里的 `parseJson / formatJson / diffLines`。

## 约定

1. 页签内容请放在 `<div class="panel" style="height:100%">` 里，才能正确撑满窗口
2. 只读数据请放 `logs` 目录，不要在插件里写它
3. 需要写文件的功能，务必走 `core/fsutil.py` 的 `resolve_file` + `atomic_write_text`，不要自己拼路径
4. 插件不要修改 `app.py`；如果确实需要，说明这个能力应该进主程序

## 调试

- 控制台会打印 `[插件失败] xxx.py: 具体异常`
- 浏览器 F12 → Console 可看到前端错误
- 页面顶部的红色 toast 会兜底显示未捕获的脚本错误

## 示例

`example_plugin.py` + `web/js/plugins/demo.js` 演示了一个完整的"日志统计"页签，可以直接复制改名当模板。
