# Plugin Contract v1

插件是资源包，不包含 DEX、Kotlin 或动态 Android 代码。ZIP 根目录必须包含 `manifest.json`，并可包含：

```text
docs/*.md
prompts/*.md
workflows/*.json
scripts/*.sh
cards/*.json
```

所有 manifest 文档路径和入口工作流必须是 ZIP 内安全相对路径。构建器拒绝符号链接、绝对路径、反斜杠和 `..` 路径段。

catalog 中每个版本提供不可变下载 URL、字节数和 SHA-256。Android Host 下载后必须先验证 SHA-256，再解压到临时目录并原子切换。

评论绑定 `pluginId + version`，`authorType` 为 `user`、`agent` 或 `maintainer`。Agent 应先在设备上生成评论草稿，用户确认后再调用发布接口。
