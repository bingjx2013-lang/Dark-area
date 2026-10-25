# 暗域 · SYNC

手机端实时房间聊天 PWA（Node.js 18+、WebSocket）。

## 功能
- WebSocket 实时房间聊天、在线人数、最近 50 条历史消息。
- 可选客户端 AES-256-GCM 加密；密钥不发送给服务器。
- 自动重连、PWA 安装、`/healthz` 健康检查。
- 输入校验、消息长度限制、加入房间/发送消息限速和 WebSocket payload 限制。
- `/api/status` 会执行 Redis `PING`，区分未配置、连接成功与不可用。
- 配置 Upstash Redis 后，最近 50 条消息可跨重启保留，历史记录 30 天过期。

## 本地启动
```sh
npm install
npm start
```
访问 `http://localhost:3000`。

## Upstash Redis
在部署平台的服务端环境变量中设置：
- `UPSTASH_REDIS_REST_URL`：Upstash REST URL（HTTPS）
- `UPSTASH_REDIS_REST_TOKEN`：Upstash REST token

不要把真实 token 放进 GitHub、前端代码或 `.env.example`。部署后访问 `/api/status`，只有当 `persistence` 为 `upstash-redis` 且 `redisConnected` 为 `true` 时才表示连通检查通过。 `memory-only` 表示未配置；`upstash-unavailable` 表示已配置但连接检查失败。

## Render
仓库包含 `render.yaml`。将代码合并到默认分支后，在 Render 连接此 GitHub 仓库部署，并在服务 Environment 中配置上述两个变量。健康检查路径是 `/healthz`。

## 手机安装
使用部署后的 HTTPS 地址打开页面。Android 浏览器菜单选择“安装应用/添加到主屏幕”；iPhone 使用 Safari“分享 → 添加到主屏幕”。

## 安全边界
- 当前没有账号注册、身份验证或真正的房间口令校验；知道房间名的人仍可加入。请勿用于存放敏感信息。
- 房间密钥仅用于客户端可选加密；未设置时消息为明文。设置密钥时服务器存储加密后的消息，但仍能看到昵称、房间名、时间等元数据。
- Redis 仅保存每个房间最近 50 条消息，30 天后过期；这不是永久档案。
- Redis 不可用时聊天可能继续，但相关消息可能未持久化；检查 `/api/status` 与服务日志。
