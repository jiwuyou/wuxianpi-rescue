# WuxianPi 首次安装

`wuxianpi.first-install 1.0.6` 负责宿主权限、Termux/Ubuntu 基础环境和桌面组件注册。五个 OpenHouse 核心资源的安装、校验、差异下载和回滚统一交给 `wuxianpi.resource-update 2.0.0`。

首次安装入口应先刷新维修助手市场并运行已 promote 的最新 `wuxianpi.first-install`。工作流执行过程中还会再次读取市场最新的 `wuxianpi.resource-update` 脚本，因此首次安装插件和资源更新器分别升级，不依赖 APK 重新发版。

核心资源集合包含：

```text
service-manager
openhouse-control-plane
openhouse-runtime
wuyou
openhouse-web
```

首次安装会检查全部资源。当前安装、下载缓存或 APK 内置资源与目标 SHA-256 相同时不会联网下载；只有缺失、损坏或版本不同的资源才从维修助手市场获取。

## 执行顺序

1. 检查宿主类型和真实安装状态。
2. 准备 All-in-One 内部 Termux，或为 Native 获取 Termux Home SAF 与 RUN_COMMAND 权限。
3. 安装 tmux、curl、jq、tar、gzip、flock 和 Node 等基础能力。
4. 从维修助手市场读取最新 `wuxianpi.resource-update` 脚本并写入 Termux Home。
5. 先由宿主投递 APK 内置资源，再执行资源集合 `check`；因此 Native 断网首次安装也能使用离线集合。
6. 运行宿主返回的原始 `wuxianpi-setup` 命令。
7. `wuxianpi-setup` 配置系统依赖和 Ubuntu，并调用资源更新器收敛五个资源。
8. 验证资源凭据、版本目录、service-manager、控制面和 registry。
9. 注册 `yuanshengwuxianpi` 桌面组件。

All-in-One 与 Native 使用相同资源 ID、版本和 SHA-256。市场不可用时使用 APK 内置集合。本机资源集合 sequence 高于 APK 时拒绝自动降级。

## Android-Termux 控制面

Android 只调用固定入口；实际启动、修复和诊断逻辑来自版本化的 `openhouse-control-plane` 资源：

```text
$HOME/.local/share/openhouseai/control-plane/current/
```

控制面负责启动 `service-daemon`、等待 `runsvdir`、安装 service-manager runit 服务，并验证带认证的 `127.0.0.1:20087` API。

## 桌面组件

服务 ID、组件 ID 和文件名统一为：

```text
yuanshengwuxianpi
components.d/yuanshengwuxianpi.json
```

注册接口：

```text
PUT /api/v1/registry/components/yuanshengwuxianpi
POST /api/v1/registry/sync
```

新版宿主返回桌面时会刷新组件，不需要强制停止 App。重复执行首次安装和资源收敛都是幂等的，不能删除用户配置、模型、会话或自定义组件。
