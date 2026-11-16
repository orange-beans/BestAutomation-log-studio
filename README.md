# BestAutomation · JSON & 日志工作台（Studio）

> 单机、零依赖的本地 Web 工具：安全地编辑 `BestAutomation` 的 JSON 配置，只读阅读运行日志与实验日志。
> 当前版本：**1.3.0**（见 [VERSION](VERSION) 与 [CHANGELOG.md](CHANGELOG.md)）
> 本 Git 仓库的根目录就是 `studio` 工具目录；克隆后的文件夹名可以任意。

## 这是什么

`BestAutomation` 设备软件把配置和日志都放在自己的目录里，手工改 JSON 容易写坏，翻日志也不方便。
这个工具用一个本地网页界面解决两件事：

- **配置编辑**：JSON 文件列表、结构树 / 源码 / 差异三种视图、保存前语法校验、自动备份、编码与换行保真
- **日志查看**：原文 / 表格两种视图、按日期与级别筛选、只看不合格、实验统计、实时跟随、表格与原文双向跳转

工具只使用 Python 标准库，并内置了 **Python 3.13.3 Windows x64** 运行时。目标电脑**不需要安装 Python、pip 包、Node 或 VC++ 运行库**。

## 功能一览

- JSON：行内改值、改名、增删、数组上下移；源码高亮 + 行号；与磁盘/备份逐行对比
- 校验：行列定位、中文原因、修复建议；语法不合法时禁止保存
- 保存：自动备份到 `.tool-backups`（保留 30 份），保留编码/BOM、换行、缩进、结尾换行
- 日志：原文时间淡显、级别配色、搜索高亮；表格自动分列、排序、列显示/隐藏、复制为 TSV
- 实验日志：头部信息卡、步数/合格/不合格/不合格率/耗时统计
- 表格列：`Stp / tpA / tpB / pinA / pinB / range / V / Res` 始终显示；常量派生列默认隐藏，`列` 按钮显示隐藏数量，支持全部显示/恢复默认
- 多页签：配置编辑、日志查看、实用工具（线性映射计算器）、插件示例

## 快速开始（Windows 10/11，64 位）

### 方式一：克隆仓库

```bat
git clone https://github.com/orange-beans/BestAutomation-log-studio.git
cd BestAutomation-log-studio
```

双击 **`启动工作台.bat`**，浏览器会打开 `http://127.0.0.1:8765/`。

- **没有真实数据也能跑**：如果上一级目录没有 `settings.json`，程序会自动使用仓库内的 [demo](demo) 数据；启动横幅里的四个目录会指向 `demo` 下的对应位置。
- 默认账号：`admin`，初始密码：`Admin12345`。登录后右上角可以改密码。
- 关闭黑窗口即停止服务。

### 方式二：下载 ZIP

在 GitHub 页面点 **Code → Download ZIP**，解压后双击 `启动工作台.bat`。
注意不要只在压缩包里双击，要先完整解压。

## 接真实数据

工具默认把 `studio` 的上一级目录当作 `BestAutomation`。最推荐的放置方式：

```text
BestAutomation\
├─ studio\                 ← 本仓库（整个文件夹）
├─ settings.json
├─ calibration_setting.json
├─ measure_check_setting.json
├─ mock_boards.json
├─ systemMonitor.json
├─ logs\
│  └─ experiment\
└─ backup\
```

只要 `studio` 和 `settings.json`、`logs`、`backup` 处于同一级，双击 `启动工作台.bat` 就会使用真实数据，不需要改任何配置。

如果数据在别处，用环境变量覆盖（路径按实际修改）：

```bat
set STUDIO_ROOT_MAIN=D:\Data\BestAutomation
set STUDIO_ROOT_LOGS=D:\Data\BestAutomation\logs
set STUDIO_ROOT_EXPERIMENT=D:\Data\BestAutomation\logs\experiment
set STUDIO_ROOT_BACKUP=D:\Data\BestAutomation\backup
启动工作台.bat
```

> 建议四个 `STUDIO_ROOT_*` 都设置；只设置 `STUDIO_ROOT_MAIN` 时，日志/备份根目录仍会按默认规则回退到 demo。

## 可以放在任意文件夹吗？

**可以，不要求放在 `Documents` 下面。** 例如 `D:\Tools\BestAutomation\studio`、`E:\便携 测试\studio` 都可以，路径里有中文和空格也支持。

需要满足：

1. **64 位 Windows**（建议 Windows 10/11）。内置运行时是 x64，32 位系统无法启动；ARM64 未专门验证，按需改用系统 Python 3.8+。
2. **文件夹可写**：首次启动要生成 `studio.auth.json`，保存配置要写 `.tool-backups`。不要放 `C:\Program Files`、只读共享盘或只读 U 盘。
3. **数据位置正确**：只复制 `studio` 时，默认使用内置 demo；要读真实数据，就把 `studio` 放进 `BestAutomation`，或用上面的 `STUDIO_ROOT_*` 环境变量。
4. 路径不要过深（遵守 Windows 260 字符限制更稳妥）。

工具内部所有路径都相对于 `studio` 目录，`app.py` 也用 `__file__` 定位，因此和“当前在哪个盘、哪个文件夹”无关。

## 目录结构

```text
studio\
├─ app.py                  HTTP 服务、路由、鉴权、静态文件
├─ VERSION                 版本号单一来源
├─ README.md / CHANGELOG.md
├─ .gitignore / .gitattributes
├─ studio.config.json      路径 / 端口 / 上限 / 主题
├─ 启动工作台.bat          双击启动（CRLF）
├─ core\                   后端：config / fsutil / jsonlint / jsonservice / logservice / auth / registry / version
├─ plugins\                插件（加一个 .py 即多一个页签）
├─ web\                    前端：index.html + css + js
├─ demo\                   脱敏演示数据（无真实数据时自动使用）
├─ tests\                  selftest.py + CDP 界面回归脚本
└─ runtime\python\         内置 Python 3.13.3 x64（约 20 MB）
```

## 配置

`studio.config.json` 里的路径都相对于 `studio` 目录：

- `server.host` / `server.port`：默认 `127.0.0.1:8765`，端口被占用会自动往后找
- `roots.json[]` / `roots.logs[]`：白名单目录与文件匹配模式
- `limits.maxJsonBytes` / `maxLogBytes`：单文件读取上限（默认 5 MB）
- `backup.keep`：每个文件保留的历史备份数（默认 30）
- `ui.theme` / `ui.fontSize`：默认主题与字号

更完整的字段说明见 [使用说明.md](使用说明.md)；维护与架构说明见 [交接说明.md](交接说明.md)。

## 测试

后端自测（不依赖网络，不写真实配置）：

```bat
runtime\python\python.exe tests\selftest.py
```

界面回归（仅开发期需要，Node 22+ 与 Edge）：

```bat
msedge --headless=new --remote-debugging-port=9222 http://127.0.0.1:8765/
node tests\cdp-columns-test.mjs 9222 http://127.0.0.1:8765
node tests\cdp-jump-test.mjs 9222 http://127.0.0.1:8765
```

## 安全与隐私

- 只监听 `127.0.0.1`，并校验 `Host` 头，不对外网开放
- 整站需要登录；密码用 PBKDF2-HMAC-SHA256（随机盐、20 万次迭代）存储
- 日志模块**严格只读**，没有任何写入、删除、改名接口
- `studio.auth.json`、`.tool-backups/`、`tests/tmp/` 已加入 `.gitignore`，不会提交密码哈希或备份
- 真实 `settings.json`、日志、`backup` 位于仓库之外，不会被这个仓库上传；**不要把真实日志或含客户信息的配置提交到公开仓库**

> 这层登录用于防误入、防随手改，挡不住拥有本机管理员权限的人。

## 版本

- 版本号在 [VERSION](VERSION) 中维护，`app.py` 通过 `core/version.py` 读取；不要再在代码里散落版本字符串。
- 更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

当前仓库未附开源许可证。如需对外开源，请先补充 `LICENSE`（例如 MIT / Apache-2.0）再发布。
