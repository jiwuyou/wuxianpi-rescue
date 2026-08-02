# WuxianPi Rescue

WuxianPi Rescue 是救援插件、在线文档、版本评论和 Support MCP 的独立服务。首版由一个 Node 22 进程提供维修市场网站、HTTP API、静态插件包、SQLite 评论和 MCP。

## 本地运行

```bash
npm install
npm test
npm start
```

默认监听 `127.0.0.1:20877`，评论数据库位于 `data/comments.db`。

## 发布插件

官方插件源文件位于 `plugins/official/<pluginId>`。构建时会：

1. 校验 Contract v1 和声明文件；
2. 拒绝符号链接及不安全路径；
3. 生成确定性 ZIP；
4. 计算 SHA-256；
5. 保留 `public` 中已有的历史版本和 ZIP；
6. 拒绝覆盖内容或 SHA-256 已变化的同版本发布；
7. 按 SemVer 稳定排序并生成 `public/catalog.json`。

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
GET  /plugins/:id/:version.zip
GET  /docs/raw/:id/:version/:path
POST /mcp
```

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
docker compose -f /opt/wuxianpi-rescue/deploy/docker-compose.yml up -d --build
```

Compose 只把服务发布到宿主 `127.0.0.1:20877`。复制 `deploy/nginx-wuxianpi-rescue.conf` 到独立 Nginx vhost，申请证书后执行 `nginx -t` 并 reload。

备份脚本会短暂停止 Rescue 服务，复制一致的 SQLite 数据库，然后恢复容器：

```bash
install -m 0755 deploy/backup-comments.sh /usr/local/sbin/wuxianpi-rescue-backup
/usr/local/sbin/wuxianpi-rescue-backup
```

可通过系统定时器或 cron 每日调用，默认保留 30 天。
