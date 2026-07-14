# Poker with Friends

Poker with Friends 是一个账号登录、共享牌桌大厅、移动端优先的德州扑克应用。所有已登录玩家都能查看并直接加入未结束的牌桌：

- `ONLINE`：由服务端洗牌、发牌、判断牌型和结算。
- `LIVE`：配合线下实体扑克牌，只记录数字筹码、行动顺序、底池和争议确认。

本项目只使用不可兑换、不可提现的娱乐积分，不包含支付、抽成、现金结算或代客保管资金。部署者仍需自行确认所在地法律、隐私和年龄限制要求。

## 本地开发

需要 Node.js 24、Corepack、Docker Engine 和 Docker Compose v2：

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose -f infra/docker-compose.dev.yml up -d postgres
pnpm db:migrate
pnpm dev
```

前端开发服务器默认位于 `http://localhost:5173`，API 位于 `http://localhost:3000`。根目录 `.env.example` 中的 `SNAPSHOT_KEY` 是可解码为 32 字节的开发示例；生产环境必须生成独立的新密钥。

常用检查：

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

## Docker 部署

最短的自托管流程：

```bash
cd infra
cp .env.production.example .env
chmod 600 .env
# 编辑 .env，替换全部 REPLACE_* 值并设置公开 HTTPS 地址
docker compose config --quiet
docker compose up -d
docker compose ps
```

默认情况下，应用只监听宿主机 `127.0.0.1:3000`，PostgreSQL 不暴露宿主机端口，并使用独立的 Docker 命名卷。可通过 `APP_BIND_ADDRESS` 和 `APP_BIND_PORT` 调整应用监听位置。反向代理、密钥生成、备份、升级和回滚步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 安全与一致性

- 房间命令由单线程 `RoomActor` 串行处理。
- 每条命令使用 `commandId`、`expectedSeq` 和一次性 `turnToken` 防止重复下注。
- 事件、筹码分录、幂等结果和快照在同一 PostgreSQL 事务内写入。
- ONLINE 私有牌堆及底牌快照使用 AES-256-GCM 加密；公共投影不包含未公开底牌。
- 管理操作受权限和牌局状态约束，并保留可审计记录。

安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告，不要在公开 Issue 中披露漏洞或真实凭据。

## 版本与发布

项目使用 [Semantic Versioning](https://semver.org/)：

- `MAJOR`：不向后兼容的协议、数据库或部署变更；
- `MINOR`：向后兼容的新功能或迁移；
- `PATCH`：向后兼容的修复。

生产镜像应使用不可变的 Git 提交 SHA 或发布标签，不建议使用浮动的 `latest` 作为回滚依据。每个公开版本必须通过 CI、容器构建、密钥扫描和 CodeQL，并附带迁移与回滚说明。发布流程见 [公开发布清单](./docs/PUBLIC_RELEASE_CHECKLIST.md)，当前版本说明见 [v0.4.0](./docs/releases/v0.4.0.md)。

## 许可证

当前仓库未提供开源许可证。公开可见不等于授予使用、复制、修改或分发权；在明确添加许可证前保留所有权利。
