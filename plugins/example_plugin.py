"""示例插件：日志统计。

它演示了扩展一个页签的完整做法：
1. 后端 add_api 暴露接口（这里 /api/demo/overview）；
2. 前端 web/js/plugins/demo.js 导出 mount(root, ctx) 渲染页面；
3. 只需把本文件放在 plugins/ 目录，重启工作台，顶部就会多出「日志统计」页签。
"""


def setup(registry):
    def overview(query, body):
        from core import logservice

        result = {}
        for root_id in ("logs", "experiment"):
            try:
                result[root_id] = logservice.summarize(root_id)
            except Exception as exc:  # 单个目录缺失不影响另一个
                result[root_id] = {"error": str(exc)}
        return result

    registry.add_api("GET", "/api/demo/overview", overview)
    registry.add_view(
        id="demo-stats",
        title="日志统计",
        script="demo.js",
        description="示例插件：按目录汇总日志数量、行数与错误数",
    )
