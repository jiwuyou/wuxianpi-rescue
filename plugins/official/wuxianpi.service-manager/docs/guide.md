# service-manager 检查指南

WuxianPi 原生服务 ID 使用 `yuanshengwuxianpi`，系统级端口遵循 `20001-21999` 规范，当前约定端口为 `20765`。

检查服务定义、二进制路径、健康状态和日志轮转。错误报告只读取日志末尾，不能把完整超大日志载入 Android Java 堆。
