# OpenHouse 核心资源更新

`wuxianpi.resource-update 2.0.2` 使用资源 API V2，不兼容 1.0.0 的单 Runtime 目录。它优先调用 Termux 中由 APK 离线总包安装的 `$PREFIX/bin/openhouse-resource-manager`，因此在线更新与首次安装共享同一套差异计算、事务安装、校验、回滚和 receipt 实现。

目标是让设备最终拥有 `openhouse-core-stack` 声明的五个资源：`service-manager`、`openhouse-control-plane`、`openhouse-runtime`、`wuyou` 和 `openhouse-web`。更新器会检查全部资源，但只有已安装内容、缓存和 APK 内置资源都无法匹配目标 SHA-256 时才联网下载。

资源来源优先级：

```text
当前安装完整且 SHA 相同
→ 本地归档缓存
→ APK 内置资源
→ 维修助手市场
```

支持命令：

```text
update-resources.sh check
update-resources.sh plan
update-resources.sh apply
update-resources.sh verify
update-resources.sh rollback
```

`plan` 会报告目标资源数、无需处理数、APK/缓存复用数、真正下载数和预计字节。`apply` 先下载和解压全部差异资源，再切换版本；失败时恢复旧链接和安装处理器。`rollback` 使用上一次成功更新前保存的完整资源集合。

安装完成后会验证 service-manager `20087`、按需启动 WuxianPi 并验证 `20765`，随后恢复更新前的服务运行状态。APK 目录只有存在 `.complete` 时才会被读取；成功收敛后会清除全局 pending 标记和目录内 `.pending`。

资源清单不能携带安装命令。插件只允许五个固定资源 ID，并为每个资源调用内置处理器。配置、模型、会话和用户数据不存放在版本目录中。

公共接口：

```text
GET /api/v2/resources
GET /api/v2/resources/<id>
GET /api/v2/resource-sets/openhouse-core-stack
GET /resources-v2/<id>/<version>/<archive>.tgz
```

市场不可用时使用 APK 内置资源集合。APK 版本较旧且本机资源集合 sequence 更高时，更新器拒绝自动降级。
