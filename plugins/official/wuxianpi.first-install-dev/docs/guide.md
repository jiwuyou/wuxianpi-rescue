# 首次安装开发版

这是用于真机验证完整首次安装链路的开发插件。它会先安装并启动独立的 `wuxianpi.background-run-guide`，等待后台运行设置完成后，再使用完整的 `openhouse-core-stack-dev` 开发资源集合继续安装；不再转交正式首次安装插件。

请明确要求维修助手：

```text
请安装并启动 wuxianpi.first-install-dev，不要启动正式的 wuxianpi.first-install。
执行开发版完整首次安装流程。
```

开发版会下载当前候选镜像脚本，读取公网出口所在国家，同时测试两个 Termux 官方源和对应区域的候选源。脚本从 `InRelease` 读取实际索引格式，校验索引 SHA-256，并验证 `tmux`、`proot-distro` 的实际 `.deb` 包池。候选还必须通过真实 `apt-get update`。海外完整可用时优先使用官方源；中国大陆区域源只有比最快官方源至少快 20% 才会优先。

镜像阶段通过后，插件继续完成 Android 资源投递、完整开发资源集合补齐、运行激活、Package reconcile、Android 私有连接保存、Ubuntu 安装和安装收尾。开发集合包含当前正式集合的全部资源，验证通过后可以直接提升为正式集合。

外部 Termux 配置命令会显示为一个普通命令区域。请点击下方右上角的复制按钮，一次性复制下面的全部命令。切换到 Termux，粘贴后点击键盘上的换行键执行。

测试日志位于：

```text
$HOME/.local/state/wuxianpi-setup/mirror/benchmark.log
$HOME/.local/state/wuxianpi-setup/mirror/profile.json
```

开发版不会改变 APK 内置资源，也不会启动正式首次安装插件。
