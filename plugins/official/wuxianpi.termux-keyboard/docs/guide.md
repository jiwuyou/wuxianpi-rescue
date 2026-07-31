# Termux 键盘配置

该插件通过固定脚本 `scripts/termux-keyboard.sh` 管理 Termux 的额外按键配置。救援 AI 不应自行拼接或改写脚本内容，而应使用 `read_rescue_plugin_document` 读取当前插件版本中的脚本，再通过 `write_file` 写入 Termux Home：

```text
environment: repo:termux-home
path: .local/share/wuxianpi/plugins/termux-keyboard/termux-keyboard.sh
实际路径: ~/.local/share/wuxianpi/plugins/termux-keyboard/termux-keyboard.sh
```

写入后，权限设置、执行和状态检查都必须通过持久工具 `termux_exec_command` 完成，不能改用 Android shell 或 Ubuntu shell。

## 工作流

- `workflows/apply.json`：应用 WuxianPi 推荐键盘配置，然后执行 `status` 验证。
- `workflows/remove.json`：只移除 WuxianPi 管理的配置，然后执行 `status` 验证；不得自动扩大为完整恢复。
- `workflows/restore-original.json`：完整恢复 Termux 原始状态，然后执行 `status` 验证。

## 完整恢复确认

`restore-original` 可能覆盖或移除用户已有的 `extra-keys` 自定义内容。救援 AI 必须先清楚说明这一影响，并获得用户对“完整恢复原始配置”的明确肯定答复。未确认、含糊回答或用户只要求移除 WuxianPi 配置时，必须停止并改用 `remove`，不得执行 `restore-original`。

最终结果必须以脚本的 `status` 输出为准。命令成功启动不等于配置已经生效或恢复完成。
