# APK 资源更新

`wuxianpi.resource-update` 与 `wuxianpi.first-install` 分工不同：首次安装只初始化 Termux、service-manager、WuxianPi 和桌面组件；本插件负责 APK 更新后的资源检查和独立资源包更新。

APK 的 All-in-One、Universal、Native 使用同一个 `versionCode/versionName`。资源版本独立，下载前必须验证 ABI、大小和 SHA-256，解包后写入版本目录，最后原子切换 `current`。市场不可用时保留并使用 APK 投递的离线资源。

资源市场接口：

```text
GET /api/v1/resources
GET /resources/<id>/<version>/<archive>.tgz
```

更新失败不得删除当前版本，也不能阻塞 WuxianPi 核心服务。
