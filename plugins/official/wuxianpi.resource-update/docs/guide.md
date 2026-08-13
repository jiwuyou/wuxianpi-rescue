# OpenHouse 核心资源更新

`wuxianpi.resource-update 3.0.0` 是轻量编排插件，不包含第二套资源安装器。它比较本机、APK `.ready` TAR 和官方市场的 `openhouse-core-stack`，按 `sequence` 选择最高兼容集合，只获取版本不同的资源。

来源顺序：

```text
已安装同版本
→ 本地 archives/<resourceId>/<version>/<archive>
→ APK canonical TAR 中的同版本资源
→ 官方市场下载
```

静态内容统一交给 `$PREFIX/bin/openhouse-resource-manager`。内容事务只处理版本目录、`current`、schema 3 receipt 和回滚。内容发生变化后，插件才单独调用 `wuxianpi-setup activate`；激活失败不会回滚或重新下载内容。

运行期不计算 bundle、归档或目录树 SHA。APK 依赖 APK 签名，市场依赖官方 HTTPS、不可变 `resourceId/version` 和发布门禁；真机仍检查下载长度、TGZ 可读取、路径安全和允许的资源结构。

支持：

```text
update-resources.sh plan
update-resources.sh apply
update-resources.sh verify
update-resources.sh rollback
```

目标 `sequence` 低于本机时不自动降级；相同 sequence 对应不同五资源版本时直接报冲突。
