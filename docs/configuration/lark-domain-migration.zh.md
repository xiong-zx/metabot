# Lark 域名迁移

为了兼容旧配置，MetaBot 继续使用 `feishuBots`、`feishuAppId` 和
`feishuAppSecret` 这些名字。新增的域名设置只决定凭证发往哪个官方 API：

- `feishu`（默认）使用飞书 API。
- `lark` 使用国际版 Lark API。

只接受这两个小写值。旧配置没有该字段时仍然使用飞书。

## 配置 Lark Bot

先在 Lark 开发者后台新建并发布自建应用，启用机器人能力，授予消息和资源权限，
再配置长连接事件订阅。然后写入新的 Lark 凭证：

```json
{
  "feishuBots": [{
    "name": "international-bot",
    "feishuAppId": "cli_new_lark_app",
    "feishuAppSecret": "...",
    "feishuDomain": "lark",
    "defaultWorkingDirectory": "/home/me/project"
  }]
}
```

单 Bot 环境变量模式使用 `FEISHU_DOMAIN=lark`。独立 Wiki/文档 Service App
使用 `FEISHU_SERVICE_APP_ID`、`FEISHU_SERVICE_APP_SECRET` 和
`FEISHU_SERVICE_DOMAIN=lark`。没有独立 Service App 凭证时，会沿用第一个 Bot
的凭证和域名。

安装器也会把这个值传给 `lark-cli config init --brand`，保证新建的 CLI 配置使用
同一个 API。如果 `lark-cli` 已经有配置，安装器会保留这份用户配置；使用 Lark
Skills 前，需要用 `--brand lark` 新建或重新初始化 Lark CLI 配置。

`~/.lark-cli/config.json` 是一份用户级全局配置，Bridge 的每 Bot 域名不会自动切换
它。在同时运行飞书和 Lark Bot 的机器上，最先初始化 `lark-cli` 的 Bot 会决定这份
全局配置的品牌。若已安装的 CLI 版本支持独立配置，需要手工为不同租户维护配置；
否则在使用另一租户的 Skills 前，要用对应的 `--brand` 重新初始化全局配置。

## 不要复用跨租户 ID

飞书与 Lark 的 App ID、open ID、union ID、聊天 ID、消息 ID、Wiki Space ID、
Wiki 节点 Token、文档 Token 和云盘文件 Token 都只在各自租户内有效。Lark
应用和群聊要重新创建，不能把飞书 ID 复制进 Lark 配置或定时任务。

## 为 Wiki 同步建立全新映射

Wiki 同步把文档和文件夹映射保存在 `WIKI_SYNC_STATE_DIR` 下的
`sync-mapping.db`。其中包含只在原租户有效的 Wiki 节点和文档 ID。迁移到 Lark
时：

1. 设置 Lark Service App 凭证和 `FEISHU_SERVICE_DOMAIN=lark`。
2. 在 Lark 租户选择或创建新的 Wiki Space，填写新的 `WIKI_SPACE_ID`；也可以留空，
   让同步按名称查找或创建。
3. 把 `WIKI_SYNC_STATE_DIR` 指向新的空目录，不要复制或复用飞书的
   `sync-mapping.db`。
4. 确认 Lark Service App 已有 Wiki、Docx、云盘权限并能访问目标 Space 后，才运行
   第一次同步。

验证完成前保留旧飞书映射目录，方便回退到原租户。

## 仍需在线开通的资源

代码不能代替租户资源开通。在线测试前，管理员仍需创建并发布 Lark 聊天应用、
批准权限和事件订阅、把机器人加入新 Lark 群聊；若使用 Wiki 同步，还要创建
Service App 和 Wiki Space。最后更新受保护的运行时凭证和新 ID，再由有权限的人
执行受控重启。
