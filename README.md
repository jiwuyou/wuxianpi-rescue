# WuxianPi Rescue

WuxianPi Rescue 是救援插件、在线文档、版本评论和 Support MCP 的独立服务。首版由一个 Node 22 进程提供维修市场网站、HTTP API、静态插件包、SQLite 评论和 MCP。

## 本地运行

```bash
npm install
npm test
npm start
```

默认监听 `127.0.0.1:20877`，评论数据库位于 `data/comments.db`。生产容器将评论和发布内容分别保存到 `/data/comments.db` 与 `/data/releases`。

## 发布插件

官方插件源文件位于 `plugins/official/<pluginId>`。构建时会：

1. 校验 Contract v1 和声明文件；
2. 拒绝符号链接及不安全路径；
3. 生成确定性 ZIP；
4. 计算 SHA-256；
5. 保留 `public` 中已有的历史版本和 ZIP；
6. 拒绝覆盖内容或 SHA-256 已变化的同版本发布；
7. 按 SemVer 稳定排序并生成 `public/catalog.json`。

资源包与插件包分开管理。资源使用破坏性升级后的 API V2 和持久化 `/data/releases-v2`；旧 `/api/v1/resources`、`/resources.json` 与 `/resources/...` 均已退役并返回 `410 Gone`。`wuxianpi.resource-update 2.0.0` 负责按完整资源集合比较、下载差异、安装和回滚，`wuxianpi.first-install 1.0.6` 只准备宿主环境、获取最新资源更新器并注册桌面组件。

插件发布后不可覆盖同一版本。内容有任何变化都必须递增 `manifest.json` 的 `version`；完全相同的重复构建可以通过。

```bash
npm run build
```

## HTTP API

```text
GET  /health
GET  /api/v1/plugins?q=
GET  /api/v1/plugins/:id
GET  /api/v1/plugins/:id/versions
GET  /api/v1/plugins/:id/comments?version=
POST /api/v1/plugins/:id/comments
POST /api/v1/comments/:id/replies
GET  /api/v2/resources
GET  /api/v2/resources/:id
GET  /api/v2/resource-sets/:id
GET  /resources-v2/:id/:version/:archive
GET  /plugins/:id/:version.zip
GET  /docs/raw/:id/:version/:path
POST /mcp
```

## 通过管理 API 发布插件

维修助手市场的插件发布不需要登录生产服务器。发布者在本地构建并测试后，使用管理 API 上传；服务端会校验 metadata、ZIP 实际大小、SHA-256 和归档内的 `manifest.json`，然后原子写入持久化 `/data/releases`。同一版本相同内容重复上传是幂等的，不同内容会返回 `409`，历史 ZIP 不会被覆盖或删除。

管理 API 只属于维修助手市场，不会同步其它市场：

```text
GET  /api/v1/management/status
PUT  /api/v1/management/plugins/:pluginId/releases/:version
POST /api/v1/management/plugins/:pluginId/promote
PUT  /api/v2/management/resources/:resourceId/releases/:version
POST /api/v2/management/resources/:resourceId/promote
PUT  /api/v2/management/resource-sets/:resourceSetId/releases/:version
POST /api/v2/management/resource-sets/:resourceSetId/promote
```

生产环境通过 `WUXIANPI_RESCUE_MANAGEMENT_TOKEN` 启用接口。未配置 token 时写接口禁用；请求必须带 `Authorization: Bearer <token>`。Nginx 配置默认只允许本机、私网或 Tailscale 地址访问管理路径。

本地发布工具只接受显式的 `--market rescue`，默认上传后将版本 promote 为 latest；加 `--no-promote` 可只上传版本：

```bash
npm test
npm run build

WUXIANPI_RESCUE_MANAGEMENT_URL=https://wuxianpirescue.webefficacy.com \
WUXIANPI_RESCUE_MANAGEMENT_TOKEN='...' \
scripts/publish-market-via-api.sh \
  --market rescue \
  --plugin wuxianpi.first-install \
  --version 1.0.2
```

只做本地校验而不发送请求：

```bash
scripts/publish-market-via-api.sh --market rescue \
  --plugin wuxianpi.first-install --version 1.0.2 --dry-run
```

发布接口使用临时文件接收 ZIP，校验成功后才原子移动并更新 catalog。`promote` 只切换 `latestVersion`，因此可以在保留历史版本的前提下回滚：

```bash
curl -X POST \
  -H "Authorization: Bearer $WUXIANPI_RESCUE_MANAGEMENT_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"version":"1.0.1"}' \
  "$WUXIANPI_RESCUE_MANAGEMENT_URL/api/v1/management/plugins/wuxianpi.first-install/promote"
```

## 发布核心资源集合

APK 仓库中的 `scripts/generate-resource-set-v2.sh` 生成唯一的五资源组合、每个资源的发布 metadata 和 `openhouse-core-stack` manifest。All-in-One、Native 与市场上传必须使用这些相同字节，不能重新压缩：

```bash
cd /root/projects/smallphoneai/openhouseai-app-ai-web
scripts/generate-resource-set-v2.sh --check
jq . distribution/resources-v2/publish-manifest.json
```

先逐个上传但不 promote，完成测试机 `plan/apply/rollback` 后再提升资源，最后提升集合：

```bash
scripts/publish-resource-via-api.sh --market rescue \
  --resource openhouse-runtime \
  --version '0.1.0+pi.0.80.10' \
  --archive /path/to/runtime-aarch64.tgz \
  --metadata /path/to/metadata.json

scripts/publish-resource-set-via-api.sh --market rescue \
  --manifest /path/to/openhouse-core-stack.json \
  --promote
```

资源版本不可覆盖。相同版本相同 SHA 重传是幂等成功，不同 SHA 返回 `409`。单个压缩资源上限为 60 MiB；Nginx 仅对 `/api/v2/management/` 放宽到 64 MiB。版本化下载支持 `HEAD`、Range、ETag 和不可变缓存。

发表评论：

```json
{
  "version": "1.0.0",
  "authorType": "agent",
  "authorName": "WuxianPi Rescue",
  "clientId": "device-local-id",
  "content": "Android 14 环境实测通过",
  "rating": 5,
  "environment": { "android": "14", "termux": "0.118" }
}
```

MCP 支持 `initialize`、`tools/list` 和 `tools/call`，提供：

- `search_plugins`
- `get_plugin`
- `read_plugin_document`
- `get_plugin_comments`

## Docker 部署

```bash
git clone https://github.com/jiwuyou/wuxianpi-rescue.git /opt/wuxianpi-rescue
mkdir -p /var/lib/wuxianpi-rescue
printf 'WUXIANPI_RESCUE_MANAGEMENT_TOKEN=...\n' > /opt/wuxianpi-rescue/deploy/.env
chmod 600 /opt/wuxianpi-rescue/deploy/.env
docker compose --env-file /opt/wuxianpi-rescue/deploy/.env -f /opt/wuxianpi-rescue/deploy/docker-compose.yml up -d --build
```

Compose 只把服务发布到宿主 `127.0.0.1:20877`。复制 `deploy/nginx-wuxianpi-rescue.conf` 到独立 Nginx vhost，申请证书后执行 `nginx -t` 并 reload。

Compose 启动时会把镜像内的 `public/catalog.json` 和插件 ZIP 迁移到 `/data/releases`（只补齐缺失文件，不覆盖已经发布的版本）。之后公共 `/catalog.json`、插件查询和下载都从该持久化目录读取；升级市场服务自身代码不会丢失已发布内容。`deploy/deploy.sh` 会显式读取 `/opt/wuxianpi-rescue/deploy/.env`（也可通过 `MARKET_ENV_FILE` 覆盖），仅用于升级市场服务代码和容器，不用于发布插件。

备份脚本会短暂停止 Rescue 服务，复制一致的 SQLite 数据库并打包持久化发布目录，然后恢复容器：

```bash
install -m 0755 deploy/backup-comments.sh /usr/local/sbin/wuxianpi-rescue-backup
/usr/local/sbin/wuxianpi-rescue-backup
```

可通过系统定时器或 cron 每日调用，默认保留 30 天；发布目录备份文件为 `releases-*.tgz`。
