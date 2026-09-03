# WuxianPi 首次安装

这个插件根据设备的真实状态继续执行，不维护脆弱的向导进度。再次运行时，已经完成的步骤会被检查并跳过。

## 两种宿主

- All-in-One 使用 APK 内部 Termux，不需要 SAF 或外部 RUN_COMMAND 授权。
- Native 使用外部 Termux，需要授权 Termux Home，并允许 RUN_COMMAND。

## 执行顺序

1. 检查当前安装状态和宿主类型。
2. 准备 Termux 与 bootstrap。
3. Native 获取 Termux Home SAF，并完成工作区绑定。
4. Native 获取 RUN_COMMAND 权限后立即运行真实命令验证。若 Termux 尚未启用 `allow-external-apps`，通过已授权的 SAF Termux Home 文件通道编辑 `~/.termux/termux.properties`，确保存在未注释的 `allow-external-apps = true`，然后重新验证；验证成功前不进入下一步。
5. 测试软件源，只安装 tmux 的必要前置包。
6. 安装 tmux，建立持久 Termux 终端。
7. tmux 准备后，所有长命令和后续诊断使用 `termux_exec_command`。
8. 将 APK 随附资源转移到 Termux，并执行 `start_wuxianpi_setup` 针对当前宿主返回的命令。Native 返回的命令会解包并调用 `$HOME/.local/share/wuxianpi/install-resources/current/bootstrap/wuxianpi-setup` 原始脚本；All-in-One 返回的命令会调用宿主已暂存的 `/bin/wuxianpi-setup`。工作流不得自行拼接另一宿主的路径。
9. 安装 `termux-services`，显式执行 `service-daemon start`，检查 `runsvdir`、`sv status service-manager` 和 `127.0.0.1:20087`。首次 `sv up` 若出现 `unable to change to service directory`，按 3 秒间隔最多重试 10 次 readiness，给 `runsvdir` 留出启动时间。
10. 安装并注册 service-manager、WuxianPi 和 Ubuntu；暂不安装 AionUI 等可选组件。
11. WuxianPi 注册为 `yuanshengwuxianpi`，固定使用 `127.0.0.1:20765`，但安装时不默认启动，也不设为常驻。
12. 检查终端工具、service-manager 常驻链路、WuxianPi 服务声明和 Ubuntu。只有明确测试模型或打开 WuxianPi 时才按需启动 WuxianPi。

## 服务生命周期

- 只有 service-manager 由 `termux-services` 长期托管。
- `yuanshengwuxianpi` 的 `residentByDefault` 为 `false`，`restart.mode` 为 `on-failure`。
- WuxianPi 显示 `stopped` 是正常的按需状态，不代表安装损坏。
- tmux 只承载安装、升级和维修任务；tmux 会话不是正式服务的生命周期所有者。

安装中断后可以直接再次启动本工作流。

## 兼容性排障

- RUN_COMMAND 的 Android 权限已授予，不代表 Termux 已允许外部命令；必须同时验证 `allow-external-apps = true` 和真实命令返回。
- `runsvdir` 启动存在短暂时序窗口，首次 `sv up service-manager` 失败时先等待并重试 readiness，不需要立刻手工修复。
- 重跑安装必须执行 `start_wuxianpi_setup` 返回的宿主命令。Native 命令从 `install-resources/current/bootstrap/wuxianpi-setup` 原始资源启动；All-in-One 命令使用宿主已暂存的 `/bin/wuxianpi-setup`。
