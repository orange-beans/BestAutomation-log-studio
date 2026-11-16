# 更新记录

## 1.3.0 — 2026-11-16

### 新增

- 日志表格与原文**双向跳转**：点表格行到原文对应行，点原文行回表格对应行；目标行滚动并短暂高亮，搜索/筛选/排序保持。
- 表格列显示策略：测量身份/结果列（`Stp / tpA / tpB / pinA / pinB / range / V / Res`）始终显示；常量派生列默认隐藏。
- `列` 按钮显示隐藏数量，菜单提供“全部显示 / 恢复默认”，按文件记住本次会话内的手动选择。
- 复制表格时提示未包含的隐藏列。
- 内置 `demo/` 脱敏演示数据：仓库克隆后没有真实 BestAutomation 数据也能直接启动查看界面。

### 工程

- 新增 `VERSION` 与 `core/version.py`，版本号单一来源；启动横幅与 `/api/bootstrap` 均读取该版本。
- 新增 `README.md`、`.gitignore`、`.gitattributes`、`CHANGELOG.md`。
- `.gitattributes` 强制 `*.bat` 以 CRLF 检出，避免 cmd.exe 解析 LF 批处理出错。
- 新增 `tests/cdp-columns-test.mjs` 列显示回归。

## 1.2.1

- 基线版本：JSON 配置编辑、日志原文/表格查看、实验统计、线性映射计算器、登录门禁、插件机制、内置 Python 运行时。
