# OpenHouse 核心资源更新

`wuxianpi.resource-update 2.0.3` 只收敛 `openhouse-core-stack` 的五个静态资源内容。它不会启动或停止服务，不读取 token，不同步 registry，也不以 20087/20765 运行状态决定 content 事务是否成功。

每次执行时，插件先把当前市场文档携带的 canonical `openhouse-resource-manager` 原子安装到 `$PREFIX/bin`，再移交执行。这样已经存在的旧版或故障管理器不会阻止自身升级。

来源优先级：

```text
当前安装完整且 SHA 相同
→ 本地归档缓存
→ APK 内置资源
→ 维修助手市场
```

支持：

```text
update-resources.sh check
update-resources.sh plan
update-resources.sh apply
update-resources.sh verify
update-resources.sh rollback
```

`verify` 只验证 receipt、资源树 SHA 和静态安装结果。运行收敛由 `wuxianpi-setup activate` 或维修流程单独执行。

更新失败时恢复旧 `current`，将失败候选、plan、resource-set 和错误信息保存在 `resource-manager/failed/`。配置、模型、会话和用户数据不位于资源版本目录内。
