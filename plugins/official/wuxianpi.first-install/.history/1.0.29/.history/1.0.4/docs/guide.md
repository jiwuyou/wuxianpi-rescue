# WuxianPi 首次安装

这个插件根据设备的真实状态继续执行，不维护脆弱的向导进度。再次运行时，已经完成的步骤会被检查并跳过。1.0.3 将旧版桌面组件 ID `pi-agent` 迁移为与服务一致的 `yuanshengwuxianpi`；1.0.4 增加 OpenHouse Android-Termux 控制面包投放与诊断。

首次安装除了部署 `yuanshengwuxianpi` 服务，还会注册一个 OpenHouse 桌面组件。服务注册和桌面组件注册是两条独立链路：服务可以已经运行，但如果 `components.d` 没有 `yuanshengwuxianpi`，原生桌面不会显示 WuxianPi 入口。

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
8. 先投放 OpenHouse 控制面包到 `$HOME/.local/share/openhouseai/control-plane/current/`。其中包含完整启动、修复和诊断脚本，以及 SHA-256 清单；manifest 最后写入，作为完整标记。
9. 将 APK 随附资源转移到 Termux，并执行 `start_wuxianpi_setup` 针对当前宿主返回的命令。Native 返回的命令会解包并调用 `$HOME/.local/share/wuxianpi/install-resources/current/bootstrap/wuxianpi-setup` 原始脚本；All-in-One 返回的命令会调用宿主已暂存的 `/bin/wuxianpi-setup`。工作流不得自行拼接另一宿主的路径。
10. 安装 `termux-services`，显式执行 `service-daemon start`，检查 `runsvdir`、`sv status service-manager` 和 `127.0.0.1:20087`。首次 `sv up` 若出现 `unable to change to service directory`，按 3 秒间隔最多重试 10 次 readiness，给 `runsvdir` 留出启动时间。
11. 安装并注册 service-manager、WuxianPi 和 Ubuntu；暂不安装 AionUI 等可选组件。
12. WuxianPi 注册为 `yuanshengwuxianpi`，固定使用 `127.0.0.1:20765`，但安装时不默认启动，也不设为常驻。
13. 使用控制面包的 `start` 和 `inspect` 命令检查 `service-daemon`、`runsvdir`、`sv status service-manager`、带认证的 `20087` API 和脚本完整性。
14. 读取插件内置的 `scripts/register-openhouse-component.sh`，将 `yuanshengwuxianpi` 写入 OpenHouse registry，并验证 `/api/v1/registry/components` 返回该组件。

## Android-Termux 控制面

Android 不直接启动 service-manager。Native Android 只通过已授权的 `com.termux.RUN_COMMAND` 把固定入口 `openhouse-host/start-control-plane.sh` 提交给 Termux；入口优先调用：

```text
$HOME/.local/share/openhouseai/control-plane/current/start-control-plane-termux-native.sh
```

完整脚本才负责读取 canonical config、启动 `service-daemon`、等待 `runsvdir`、执行 `service-manager install-service` 与 `sv up`，最后校验 20087 health 和认证服务列表。控制包缺失时，Android 入口不能恢复服务；1.0.4 会在首次安装时提前投放它。

维修助手的首选诊断命令是：

```sh
"$PREFIX/bin/bash" \
  "$HOME/.local/share/openhouseai/control-plane/current/inspect-control-plane-termux-native.sh" inspect
```

它只输出 `control_plane_*` 状态，不输出 token。`control_plane_status=repair_required` 且 config 已存在时，可执行同一脚本的 `repair`。不要因为 `yuanshengwuxianpi` 正常 stopped 而重装 WuxianPi；那是按需服务的正常状态。

## 桌面组件注册

标准组件清单位置是：

```text
$HOME/.config/openhouseai/components.d/yuanshengwuxianpi.json
```

本插件使用与 service-manager 服务完全一致的固定组件 ID `yuanshengwuxianpi`，入口为：

```text
http://127.0.0.1:20765/
```

该地址由已经安装的 `yuanshengwuxianpi` 提供。注册脚本只写入或更新 `yuanshengwuxianpi`，不会删除其它组件，也不会重装或删除 WuxianPi 服务。当前 service-manager 没有发布 20765 endpoint，因此清单使用固定本地地址，服务控制仍通过 OpenHouse 内置的服务控制入口完成。

注册操作通过 service-manager API 完成：

```text
PUT /api/v1/registry/components/yuanshengwuxianpi
POST /api/v1/registry/sync
```

如果 API 暂时不可用，脚本会保留文件 registry，下一次运行时重试 API 同步。新版宿主支持“刷新桌面组件”，注册后返回宿主即可刷新；旧 APK 的 registry 只在进程启动时加载，需要完全退出并重新打开原生 `com.wuxianpi`。

### 旧版本迁移

1.0.2 及更早版本可能写入 `components.d/pi-agent.json`。注册脚本只在文件同时包含旧 ID 和 WuxianPi 标识（名称、服务 ID 或 20765 本地入口）时认定它属于本插件；其它同名文件会原样保留。

确认属于本插件后，旧清单会先备份到：

```text
$HOME/.local/share/wuxianpi/plugins/wuxianpi.first-install/migrations/
```

再移除旧文件并写入 `components.d/yuanshengwuxianpi.json`。脚本会尽力调用 `DELETE /api/v1/registry/components/pi-agent` 清理旧 registry 项；即使服务端尚不支持删除或暂时不可达，也不会阻塞新组件注册。

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
- 如果服务检查成功但桌面没有 WuxianPi，先运行本插件的组件注册步骤，再检查 `$HOME/.config/openhouseai/components.d/yuanshengwuxianpi.json` 和 `/api/v1/registry/components`；不要重复安装 `yuanshengwuxianpi`。
- 已安装设备更新到 1.0.4 后，重新运行首次安装工作流即可补齐控制面包并完成旧 `pi-agent` 清单迁移；不需要重装服务或重新构建 APK。
- Android 显示“service-manager 不可达”且 `runsvdir` 未运行时，先执行控制面 `inspect`；如果发现 `control_plane_bundle_*` 缺失，更新到 1.0.4 后重新运行本工作流投放控制包，再执行 `start` 或 `repair`，不要只反复点击 Android 按钮。
