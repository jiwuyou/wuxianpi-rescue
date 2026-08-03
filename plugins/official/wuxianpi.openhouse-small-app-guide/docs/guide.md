# OpenHouse 小 App 开发与统一接入指南

本文给需要创建或管理 OpenHouse 小 App 的助手使用。目标不是介绍整个产品，而是完成一条
可执行工作流：判断运行环境，创建小 App，用 service-manager 管理长期进程，再把入口注册到
OpenHouse 桌面。

## 必须记住的四条规则

1. 小 App 默认在 **Termux native** 创建和运行。
2. Ubuntu/proot 只是兼容回退；只有 Termux 无法合理满足依赖时才使用。
3. 长期进程统一由 Termux native 的 **service-manager** 管理，不能依赖 `nohup`、后台
   shell、`tmux` 或某个终端会话常驻。
4. OpenHouse 桌面只管理入口和服务引用；启动命令只写进 ServiceSpec。

## 先判断自己在哪里

执行无副作用的探测：

```bash
pwd
printf 'HOME=%s\n' "$HOME"
printf 'PREFIX=%s\n' "${PREFIX:-}"
cat /etc/os-release 2>/dev/null || true
command -v proot-distro 2>/dev/null || true
```

判断方式：

| 现象 | 当前层 | 默认用途 |
| --- | --- | --- |
| `$HOME=/data/data/com.termux/files/home`，通常有 `$PREFIX` | Termux native | 默认开发、运行和 service-manager 控制 |
| `$HOME=/root`，`/etc/os-release` 显示 Ubuntu | Ubuntu/proot | 仅处理 Termux 明确不兼容的依赖 |
| 只能操作 Android UI | Android App | 桌面入口、权限和维护中心，不直接承载 Web 服务 |

不要只根据终端入口名称判断；入口可能自动进入 Ubuntu。

## 什么时候才使用 Ubuntu

先在 Termux 尝试静态页面、Termux 的 Node/Python 或可用的原生包。只有出现下列情况之一，
并确认没有简单稳定的 Termux 方案时，才选择 Ubuntu/proot：

- 上游只提供 glibc Linux 二进制；
- 依赖完整 Linux FHS 或 Termux/Bionic 缺失的系统库；
- native addon 无法在 Android/Bionic 构建；
- 上游明确不支持 Termux，且补丁成本或稳定性不可接受。

即使业务进程运行在 Ubuntu，service-manager daemon 仍运行在 Termux native，并通过
`proot-distro` provider 启动它。

## 统一管理模型

```text
Git 仓库 / WuxianPi Composite Package
                  |
                  +-- service-manager.service -> 进程、状态、健康、日志、重启
                  |
                  +-- openhouse.app            -> 桌面图标、打开入口、控制入口
```

WuxianPi Package Manager 负责按批准 commit 安装、验证、启用、更新和回滚贡献；
service-manager 负责运行期；OpenHouse 桌面负责用户入口。

## 小 App 仓库结构

```text
my-small-app/
├── wuxianpi-package.json
├── app/
├── service/service.json
├── openhouse/app.json
├── README.md
└── docs/
```

典型 Package 至少贡献服务和桌面入口：

```json
{
  "schemaVersion": 1,
  "id": "io.example.hello-openhouse",
  "name": "Hello OpenHouse",
  "version": "1.0.0",
  "summary": "最小 OpenHouse 小 App",
  "categories": ["app"],
  "requires": {
    "hostCapabilities": [
      { "id": "wuxianpi.package", "contractVersion": 1 },
      { "id": "service-manager.service", "contractVersion": 1 },
      { "id": "openhouse.app", "contractVersion": 1 }
    ],
    "packages": []
  },
  "build": { "mode": "none" },
  "artifacts": [],
  "contributions": [
    {
      "id": "io.example.hello-openhouse/service.web",
      "type": "service-manager.service",
      "name": "Hello OpenHouse 服务",
      "manifest": "service/service.json"
    },
    {
      "id": "io.example.hello-openhouse/app.desktop",
      "type": "openhouse.app",
      "name": "Hello OpenHouse 桌面入口",
      "manifest": "openhouse/app.json"
    }
  ]
}
```

贡献 ID 必须以 Package ID 加 `/` 开头。路径必须是 Package 内的安全相对路径。

## 当前 Package 路径限制

当前 WuxianPi 的 `service-manager.service` 会把 ServiceSpec 原样交给 service-manager；它没有
公开的运行时 Package 根目录或数据目录占位符。构建阶段的 `WUXIANPI_PACKAGE_ROOT` 也不能
当作服务运行时变量。

因此：

- 不要在 ServiceSpec 中虚构 `${WUXIANPI_PACKAGE_ROOT}` 等变量；
- 不要引用 Package Manager 私有的 `revisions/` 物理路径；
- 无文件依赖的小服务可以直接使用结构化命令；
- 正式 App 应由安装流程部署到稳定的 Termux 绝对路径，再让 ServiceSpec 指向该路径；
- 在宿主正式发布稳定 Package 运行路径契约前，安装脚本和路径必须随 App 一起验证。

下面的最小示例使用内联 Node 服务，因此不依赖未公开的 Package 路径。

## 完整最小示例

`service/service.json`：

```json
{
  "schemaVersion": 1,
  "id": "hello-openhouse",
  "service": {
    "name": "hello-openhouse",
    "description": "Minimal OpenHouse app example",
    "provider": "termux-process",
    "command": [
      "node",
      "-e",
      "const http=require('node:http');const html='<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Hello OpenHouse</title><main><h1>Hello OpenHouse</h1><p>由 service-manager 管理。</p></main>';http.createServer((req,res)=>{if(req.url==='/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));return}res.setHeader('content-type','text/html; charset=utf-8');res.end(html)}).listen(Number(process.env.PORT||23130),process.env.HOST||'127.0.0.1')"
    ],
    "env": {
      "HOST": "127.0.0.1",
      "PORT": "23130"
    },
    "runtime": {
      "strategy": "termux-process",
      "runtime": "termux",
      "platform": "android-arm64"
    },
    "restart": {
      "mode": "always",
      "max_retries": 0
    },
    "health": [
      {
        "type": "http",
        "url": "http://127.0.0.1:{{port:web}}/health",
        "interval": "30s",
        "timeout": "5s"
      }
    ],
    "ports": [
      {
        "name": "web",
        "host": "127.0.0.1",
        "preferred": 23130,
        "dynamic": false,
        "protocol": "tcp",
        "envVar": "PORT",
        "endpoint": { "scheme": "http", "path": "/" }
      }
    ],
    "enabled": true,
    "tags": ["openhouseai", "small-app", "group:local-stack"]
  }
}
```

`openhouse/app.json`：

```json
{
  "schemaVersion": 1,
  "id": "hello-openhouse",
  "title": "Hello OpenHouse",
  "description": "最小 OpenHouse 小 App",
  "kind": "app",
  "shellMenu": {
    "visible": true,
    "section": "apps",
    "order": 200,
    "entry": {
      "type": "webview",
      "url": "http://127.0.0.1:23130/"
    },
    "controlEntry": {
      "type": "service-control",
      "serviceNames": ["hello-openhouse"],
      "serviceRefs": ["service-manager://services/hello-openhouse"]
    }
  },
  "smallphoneApp": {
    "visible": true,
    "section": "apps",
    "order": 200,
    "icon": "app-window",
    "entry": {
      "type": "webview",
      "url": "http://127.0.0.1:23130/"
    },
    "controlEntry": {
      "type": "service-control",
      "serviceNames": ["hello-openhouse"],
      "serviceRefs": ["service-manager://services/hello-openhouse"]
    }
  },
  "serviceManager": {
    "required": true,
    "services": [
      {
        "name": "hello-openhouse",
        "serviceRef": "service-manager://services/hello-openhouse"
      }
    ]
  },
  "ai": {}
}
```

Package 发布后由 WuxianPi 安装批准的不可变 commit。Package Manager 会注册并启用两项
贡献；不需要把启动命令复制到桌面 manifest。

## service-manager 使用

OpenHouse 环境必须使用 canonical 配置，不要裸用另一套默认配置：

```bash
SM_CONFIG="${SMALLPHONEAI_OPENHOUSE_SERVICE_MANAGER_CONFIG:-$HOME/.config/openhouseai/service-manager/config.json}"
SM_URL="${SERVICE_MANAGER_URL:-http://127.0.0.1:20087}"
TOKEN="$(service-manager token show --config "$SM_CONFIG" | head -n1)"
SERVICE_ID="hello-openhouse"
```

常用操作：

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" "$SM_URL/api/v1/services/$SERVICE_ID/status"
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$SM_URL/api/v1/services/$SERVICE_ID/start"
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$SM_URL/api/v1/services/$SERVICE_ID/restart"
curl -fsS -H "Authorization: Bearer $TOKEN" "$SM_URL/api/v1/services/$SERVICE_ID/logs?limit=100"
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$SM_URL/api/v1/services/$SERVICE_ID/stop"
```

token 只能进入当前进程变量，不能写入仓库、manifest、URL、日志或聊天内容。真实 endpoint
优先读取 `$HOME/.config/openhouseai/runtime/endpoints.json`；缺失时显示不可用，不要猜端口。

## 生命周期

### 安装

1. 检查 Package manifest、贡献文件和 Skill。
2. 提交 Git commit，并由 WuxianPi Hub 审核固定 `approvedCommit`。
3. 设备安装该 release；Package Manager 验证 commit、manifest 和贡献。
4. service-manager 注册服务，OpenHouse 注册桌面入口。
5. 验证服务状态、health、日志和桌面打开行为。

### 更新与回滚

- 更新必须形成新 commit 和新 release，不能移动旧 release。
- mutable 数据放在 Package Git/revision 外的稳定数据目录。
- 不在 active revision 内执行 `git pull`。
- 新版本只有在验证、构建和贡献激活成功后才替换当前版本；失败时保留旧版本。

### 停用与卸载

- 停用服务贡献时，Package Manager 应从 service-manager 移除对应 Package-owned 服务。
- 停用桌面贡献时，入口应从 OpenHouse registry 消失。
- 卸载前先停止服务；默认保留用户数据，只有用户明确同意才删除。

## 验收清单

- 已确认当前运行层，默认选择 Termux native。
- 端口来自 `23100-23999` 的未占用范围，并只绑定 `127.0.0.1`。
- ServiceSpec 使用 `termux-process`；使用 Ubuntu 时记录真实兼容原因并改用
  `proot-distro`。
- 服务命令是 argv 数组，进程以前台方式运行。
- 有真实 health check，可查看状态和日志。
- `openhouse.app` 只有入口与服务引用，不包含 `command`、`shell`、`script` 或 `args`。
- 桌面能打开 App，控制入口能管理服务。
- 更新失败不破坏旧版本，卸载不默认删除用户数据。

## 当前版本的详细契约

独立指南负责流程，具体字段必须以当前 checkout 的仓库文档为准：

- WuxianPi：`packages/contracts/PACKAGE_CONTRACT.md`、
  `packages/contracts/wuxianpi-package.schema.json`、`docs/PACKAGES.md`
- service-manager：`docs/usage.zh-CN.md`
- OpenHouse 现有直接注册与完整 Web App 示例：`CUSTOM_FRONTEND_AND_APPS.md`
- 路径与端口：`PATHS_AND_PORTS.md`

本地存在 WuxianPi 或 service-manager Git checkout 时，优先读取与当前安装版本对应的仓库
文档。联网的最新文档只能用于查新，不能覆盖当前已安装版本的契约。
