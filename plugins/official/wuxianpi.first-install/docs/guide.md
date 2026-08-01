# WuxianPi 首次安装

这个插件根据设备的真实状态继续执行，不维护脆弱的向导进度。再次运行时，已经完成的步骤会被检查并跳过。

## 两种宿主

- All-in-One 使用 APK 内部 Termux，不需要 SAF 或外部 RUN_COMMAND 授权。
- Native 使用外部 All-in-One Termux，需要授权 Termux Home，并允许 RUN_COMMAND。

## 执行顺序

1. 检查当前安装状态和宿主类型。
2. 准备 Termux 与 bootstrap。
3. Native 获取 Termux Home SAF，并完成工作区绑定。
4. Native 获取 RUN_COMMAND 权限并验证命令通道。
5. 测试软件源，只安装 tmux 的必要前置包。
6. 安装 tmux，建立持久 Termux 终端。
7. tmux 准备后，所有长命令和后续诊断使用 `termux_exec_command`。
8. 将 APK 随附资源转移到 Termux，运行可重复的一键安装器。
9. 安装 `termux-services`，显式执行 `service-daemon start`，检查 `runsvdir`、`sv status service-manager` 和 `127.0.0.1:20087`。
10. 安装并注册 service-manager、WuxianPi 和 Ubuntu；暂不安装 AionUI 等可选组件。
11. WuxianPi 注册为 `yuanshengwuxianpi`，固定使用 `127.0.0.1:20765`，但安装时不默认启动，也不设为常驻。
12. 检查终端工具、service-manager 常驻链路、WuxianPi 服务声明和 Ubuntu。只有明确测试模型或打开 WuxianPi 时才按需启动 WuxianPi。

## 服务生命周期

- 只有 service-manager 由 `termux-services` 长期托管。
- `yuanshengwuxianpi` 的 `residentByDefault` 为 `false`，`restart.mode` 为 `on-failure`。
- WuxianPi 显示 `stopped` 是正常的按需状态，不代表安装损坏。
- tmux 只承载安装、升级和维修任务；tmux 会话不是正式服务的生命周期所有者。

安装中断后可以直接再次启动本工作流。
