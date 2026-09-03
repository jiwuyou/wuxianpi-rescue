当用户报告 Android 的“启动运行中枢”、OpenHouse 小 App 服务控制或 `127.0.0.1:20087` 失败时，先区分控制面与 WuxianPi 业务服务：`yuanshengwuxianpi` 为 stopped 可以正常，service-manager/runsvdir 不可达才是控制面故障。

优先执行已投放的：

```sh
"$PREFIX/bin/bash" \
  "$HOME/.local/share/openhouseai/control-plane/current/inspect-control-plane-termux-native.sh" inspect
```

读取 `control_plane_*` 输出。若 bundle 缺失，重新执行本插件的控制面投放步骤；若 `control_plane_status=repair_required` 且 canonical config 存在，执行同一脚本的 `repair`。不要重装 WuxianPi、不要生成新 token、不要输出或上传 token。Android 固定入口只提交 `start-control-plane.sh`，它会调用该目录中的完整 Termux 脚本。
