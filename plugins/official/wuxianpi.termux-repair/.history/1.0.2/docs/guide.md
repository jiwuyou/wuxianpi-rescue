# Termux 故障排查

依次区分 Android shell、Termux shell 和 Ubuntu shell。Termux 命令失败时应明确返回 Termux 错误，不能隐式改用 `/system/bin/sh`。

重点检查 SAF 是否完成工作区绑定、RUN_COMMAND 是否授权、`allow-external-apps` 是否开启、镜像源是否可用，以及 tmux 会话能否在救援助手退出后继续存在。

持久终端准备完成后，还要独立检查正式服务链路：`service-daemon` 和 `sv` 命令存在、`runsvdir` 正在运行、`sv status service-manager` 正常，并且 `127.0.0.1:20087` 健康接口可访问。必要时执行 `service-daemon start`。

Android 的“启动运行中枢”只依赖两个固定脚本。诊断工作流会检查：

```bash
$PREFIX/bin/openhouse-control-plane-start
$PREFIX/libexec/openhouse/start-service-manager.sh
```

如果脚本缺失或不可执行，在用户明确要求修复后运行 `workflows/repair-control-plane.json`。该工作流只补齐两个脚本并执行固定入口；不覆盖配置、不生成 token、不更新资源、不同步 registry，也不重装 WuxianPi。

tmux 只负责持久执行安装和维修命令，不能用 tmux 会话代替 `termux-services` 托管 service-manager。WuxianPi 的 `yuanshengwuxianpi` 服务按需运行；它未启动或显示 `stopped` 不属于 Termux 故障。
