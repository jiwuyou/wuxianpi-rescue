# Termux 故障排查

依次区分 Android shell、Termux shell 和 Ubuntu shell。Termux 命令失败时应明确返回 Termux 错误，不能隐式改用 `/system/bin/sh`。

重点检查 SAF 是否完成工作区绑定、RUN_COMMAND 是否授权、`allow-external-apps` 是否开启、镜像源是否可用，以及 tmux 会话能否在救援助手退出后继续存在。
