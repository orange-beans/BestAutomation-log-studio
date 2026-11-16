内嵌 Python 运行时 / Embedded Python runtime

版本：Python 3.13.3 (64-bit Windows, embeddable package)
来源：https://www.python.org/ftp/python/3.13.3/python-3.13.3-embed-amd64.zip
许可：Python Software Foundation License（见同目录 LICENSE.txt）

用途
    让本工具在「没有安装 Python 的电脑」上也能直接双击运行。
    启动脚本 启动工作台.bat 会优先使用本目录下的 python.exe；
    删掉整个 runtime 目录后，工具会自动改用系统已安装的 Python 3.8+。

说明
    - 这是官方「嵌入式发行版」，不是普通安装包，不会写注册表、不改系统环境变量。
    - 只包含标准库，本工具不依赖任何第三方包。
    - 仅支持 64 位 Windows；若目标机是 ARM64 / 32 位系统，
      请删除本目录，改为安装对应版本 Python 3.8+ 后使用。
    - 如果杀毒软件拦截 python.exe，请把本目录加入白名单。

校验
    下载文件大小 10,885,425 字节，与 python.org 官方一致。
