# service-manager 检查指南

正式常驻链路只有：

```text
termux-services / runsvdir
→ service-manager:20087
```

依次检查：

```sh
command -v service-daemon
command -v sv
pgrep -af runsvdir
sv status "$PREFIX/var/service/service-manager"
curl -fsS http://127.0.0.1:20087/api/v1/health
```

如果 `runsvdir` 没有运行，先执行 `service-daemon start`，再检查 `sv status` 和 20087 健康接口。不能只凭安装脚本退出码或 tmux 会话仍存在判断 service-manager 已经常驻。

WuxianPi 服务 ID 使用 `yuanshengwuxianpi`，地址为 `127.0.0.1:20765`。它必须声明 `residentByDefault=false` 和 `restart.mode=on-failure`，由模型测试、聊天、Web UI 或用户操作按需启动。`stopped` 是正常闲置状态，不算服务损坏，也不应由本插件强制拉起。

tmux 只用于执行安装和维修长命令，不承载 service-manager 或 WuxianPi 正式进程。

检查服务定义、二进制路径、健康状态和日志轮转。错误报告只读取日志末尾，不能把完整超大日志载入 Android Java 堆。
