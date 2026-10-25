# 暗域 · SYNC

手机端实时房间聊天 PWA。完整部署源码与 Upstash Redis 持久化增强正在独立分支中准备，合并前会先完成语法与配置检查。

- Node.js 18+
- WebSocket 实时聊天
- 可选客户端 AES-GCM 加密
- Upstash Redis 最近 50 条消息持久化（需在部署平台配置服务端环境变量）

请勿将 Redis token 提交到仓库。
