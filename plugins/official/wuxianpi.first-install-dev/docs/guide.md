# 首次安装开发版

这是用于真机验证 Termux 镜像区域识别和测速的开发插件。

请明确要求维修助手：

```text
请安装并启动 wuxianpi.first-install-dev，不要启动正式的 wuxianpi.first-install。
先执行开发版镜像测速，再继续首次安装验证。
```

开发版会下载当前候选镜像脚本，读取公网出口所在国家，同时测试两个 Termux 官方源和对应区域的候选源。候选必须通过 Termux `InRelease` 内容校验和真实 `apt-get update`；区域源只有比官方源至少快 20% 才会优先。通过后会记录选择结果，并交给正式首次安装流程继续资源、服务和 Ubuntu 阶段。

测试日志位于：

```text
$HOME/.local/state/wuxianpi-setup/mirror/benchmark.log
$HOME/.local/state/wuxianpi-setup/mirror/profile.json
```

开发版不会替换正式首次安装插件，也不会改变 APK 内置资源。
