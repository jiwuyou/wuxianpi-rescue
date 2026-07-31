# 常见错误索引

- `runner.sh: No such file or directory`：检查一次性 RUN_COMMAND 与持久执行器是否错误共享并清理临时根目录。
- Pi HTTP 400 且提示 tool calls 缺少结果：发送历史前保证每个 assistant tool call 后都有对应 tool result。
- 原生模型页面提示读取失败：区分真正请求失败与 Compose 协程取消。
- WuxianPi 页面 404：确认服务 ID、动态端口或规范端口，以及请求路径是否正确。
- APK 进程 OOM：检查是否一次性读取了无限增长的日志。
