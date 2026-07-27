# Roadmap

> 2026-07 全量 review 之后整理。分三部分：**已确认待修的问题**、**产品功能规划**、
> **工程改进**。
>
> **进度更新（2026-07-27）**：§1 的四个问题（1.1-1.4）与 §2 的三个 P0 体验补强
> （结算展示、音效振动、Hero 视角旋转）已实现。自动化验证覆盖单元测试、100,000 组
> 随机合法下注属性测试，以及真实 PostgreSQL + HTTP + Socket.IO 牌局流程；浏览器实测
> 覆盖桌面、375px 竖屏和 812×375 横屏。P1 与 P2 尚未开始。

---

## 1. 已确认待修问题（✅ 全部已实现）

### 1.1 躲盲注漏洞（sit-out 绕过大盲）✅

**问题**：`beginHand` 只在 `activePlayers`（已准备、未暂离）里轮转按钮和盲注
（`apps/server/src/room/actor.ts:537`、`packages/poker-engine/src/button.ts:35`）。
玩家可以在自己即将成为大盲时 `player.sitOut`，下一手再 `player.ready` 回来，
从而永远不交大盲。目前代码中没有任何「欠盲」概念。

**方案**：经典 missed-blind 记账。暂离期间错过大盲的玩家，回座后第一手必须补一个
死大盲（dead blind，直接入池、不算下注额），或等到自然轮到自己的大盲位再进场。

**最终实现**：

```ts
// apps/server/src/room/state.ts
interface RuntimePlayer {
  // ...
  owesBigBlind: boolean; // 暂离期间错过大盲
}

interface RuntimeRoomState {
  // 上一手结束时按参与者顺序算出的下一位大盲玩家。
  // 追踪玩家身份，不根据空座或新加入玩家推断，避免扩桌时误判欠盲。
  nextBigBlindPlayerId: string | null;
}

// 1) 若 nextBigBlindPlayerId 下一手没有参与，标记 owesBigBlind。
// 2) 欠盲玩家回座且不在自然大盲位时，额外收一个死大盲：
//    进入 committedHand 与底池，但不进入 committedStreet。
// 3) 回座时自然成为大盲，则直接清除欠盲，不重复收取。
// 4) owesBigBlind 是布尔债务；连续暂离多手不会累积多份死盲。

// packages/protocol —— PublicSeat 增加 owesBigBlind?: boolean，
// 前端 Seat 组件在状态行显示「回座需补盲」，ReadyConfirmation 里也给出提示。
```

运行状态直接保存在已有加密房间快照中，不需要数据库迁移。测试覆盖躲盲后回座补死盲、
连续暂离多手只补一份、多人同时暂离只标记实际到期者，以及自然轮到大盲时不重复收取。

### 1.2 公共旁观视图走了 admin 端点 ✅

**问题**：`RoomPage` 的 `?view=public` 会让 `useRoom` 轮询
`/api/admin/rooms/:id/snapshot`（`apps/web/src/use-room.ts:89`），非管理员得到 401。
所谓「旁观模式」实际上只有管理员可用。

**方案**：给房间成员之外的登录用户提供只读旁观（公共投影本来就不含任何手牌）。

```ts
// apps/server/src/routes/http.ts
app.get('/api/rooms/:id/spectate', async (request, reply) => {
  const user = await requireUser(request, reply, repository);
  if (!user) return;
  return { public: await rooms.adminSnapshot(request.params.id), private: null };
  // adminSnapshot 本身就是 buildPublicProjection，可改名 publicSnapshot
});

// 实时化（可选二期）：realtime/socket.ts 的 allowRequest 放行
// 「登录用户 + spectator: true」的握手，socket 只 join 公共广播 room，
// 永远不发 room.private。

// apps/web/src/use-room.ts：spectator 轮询 /api/rooms/:id/spectate。
// 大厅为所有登录用户提供“旁观”入口；满桌或不能加入时仍可旁观。
// 旁观页不显示需要房间成员权限的牌谱入口。
```

### 1.3 Origin 校验 fail-open ✅

**问题**：`isAllowedBrowserOrigin` 在请求没有 `Origin` 头时直接放行
（`apps/server/src/security/origin.ts:11`），对 cookie 鉴权的写接口是反向默认。
现代浏览器跨源写请求都会带 Origin，实际风险低，但建议收紧。

**方案**：状态变更类路由（POST/PUT/DELETE + WebSocket 握手）要求
`Origin === PUBLIC_ORIGIN`，缺失即拒绝；只读 GET 与 `/health/*` 维持现状。
Socket.IO 同源 polling GET 在浏览器省略 Origin 时，仅当 Fetch Metadata 明确为
`same-origin` 才放行，保留 WebSocket 不可用时的安全回退。
注意会破坏无 Origin 的脚本客户端（内部工具、压测脚本），需要同步改造或加白名单开关
`ALLOW_NO_ORIGIN=true`（生产环境默认 false；开发和测试默认 true）。

### 1.4 side-pot 构建的防御性处理（低）✅

`buildSidePots` 在某池层全员弃牌时抛 `RangeError`
（`packages/poker-engine/src/side-pots.ts:83`）。现已针对异常贡献载荷改为防御性合并，
并使用 100,000 组随机合法下注序列验证：每个底池都有合资格玩家，且底池加退款始终
等于总投入。

---

## 2. 产品功能规划

### P0 · 体验补强（改动小、感知强）✅ 已全部实现

**2.1 摊牌与结算展示（最优先）✅**
现状：一手结束后桌面没有任何「谁赢了、赢多少、什么牌型」的反馈，只能翻牌谱。
实现：

```ts
// packages/protocol —— PublicRoomProjection 增加
lastHandSummary?: {
  handNumber: number;
  reason: 'UNCONTESTED' | 'SHOWDOWN' | 'LIVE_CONFIRMED';
  totalPot: number;
  winners: { playerId: string; amount: number; handRankCategory?: number }[];
  communityCards: Card[];
};
// apps/server/src/room/projection.ts —— settle 后写入，下一手 HAND_STARTED 时清空。
// apps/web —— 新组件 <SettlementBanner>：BETWEEN_HANDS 期间浮在 felt 中央，
//   赢家座位加金色描边，赢家金额使用 chip-pop 动画。
```

**2.2 声音与触感 ✅**（WebAudio 合成音，无二进制资源）
轮到你行动 / 发牌 / 下注 / 赢池四个音效 + 手机振动（`navigator.vibrate`）。
设置开关存入 localStorage；尊重 `prefers-reduced-motion` 用户默认关。首次用户交互会
解锁 AudioContext，播放失败安全降级；下注金额增加时播放筹码音。

**2.3 Hero 座位视角旋转（可选开关）✅**
现在自己的座位可能在桌子任意方位、手牌固定渲染在桌面下方。加「以我为底边」开关：
渲染时对 seat index 做 `(seat - mySeat + 3 + 6) % 6` 的视觉重映射，把自己放在视觉槽位 3
（桌面底边）；仅改变前端显示，实际座位号和牌桌位置不变。

### P1 · 玩法扩展

- **补码申请流**：现有 `stack.topUp`（自助补至上限）+ `adminAdjustStack`。扩展为
  「玩家申请 → 房主/管理员批准」的两段式，事件 `stack.rebuyRequest` / `stack.rebuyApprove`，
  按手与按局统计买入总额（为 2.4 统计打基础）。
- **Time bank**：每人每局 N 秒时间银行，`actionTimeoutSeconds` 用尽前可点击消耗。
  协议：`PublicSeat.timeBankSeconds`，命令 `hand.useTimeBank`。
- **Ante / Straddle**：`roomSettingsSchema` 加 `ante?: number`、`allowStraddle?: boolean`；
  引擎 `beginHand` 的 forcedBets 已有 ANTE 通道，改动集中在 betting.ts 的开局注册。
- **Run it twice**：全下且双方同意后发两次公共牌、各分一半池。引擎需要把
  `dealRemainingStreets` 抽成可重入函数，池分配走现有 side-pots 逻辑两次。

### P1 · 社交与数据

- **桌内快捷表情/聊天**：socket 事件 `chat.message`（zod 限长 + fastify rate limit），
  内存环形缓冲最近 50 条，不落库；表情反应直接飘在座位上。
- **战绩统计与排行榜**：新表 `player_hand_results(room_id, hand_id, player_id, net_amount)`，
  settle 时写入。API `/api/rooms/:id/stats`、`/api/me/stats`；
  前端个人盈亏曲线 + 房间排行榜页。牌谱数据已齐（`hand_events`），只差聚合。
- **手牌回放器**：基于现有 `historyActions()` 时间线做逐步回放 UI（上一步/下一步/自动播放），
  纯前端，无协议改动。
- **牌谱导出**：文本格式（可选 PokerStars 兼容格式）导出单手/整场。

### P2 · 更大的方向

- **SNG/锦标赛模式**：盲注升级表（`blindSchedule[]` 入 settings）、淘汰判定、奖池分配；
  引擎无需改，主要是 actor 的手间调度和 UI。
- **多桌与大厅增强**：大厅筛选/搜索、每用户多房间快速切换。
- **PWA 推送**：轮到你行动 / 牌局开始的 Web Push（service worker 已存在 `pwa-worker.js`）。
- **i18n**：文案集中到 `apps/web/src/copy.ts`（现散落在组件里），先抽取后翻译。
- **浅色主题**：styles.css 已全 token 化（`--bg/--surface/...`），补一套 light tokens +
  `prefers-color-scheme` 切换即可。

### 特性完成后的验收原则

每个 P0/P1 特性合入前：单测（engine/actor 层）+ 一条 e2e 流程 + 手机 375px 宽度截图检查。

---

## 3. 工程改进

- **CI 跑 e2e**：`ci.yml` 加 postgres service container，把
  `E2E_DATABASE_URL` 注入后跑 `pnpm test:e2e`（本地已验证 4 条用例全绿）。
- **ESLint**：目前仅 Prettier。建议 flat config + typescript-eslint +
  react-hooks 插件（本次 review 的 serverSeq 依赖问题，`exhaustive-deps` 能提前拦截一类）。
- **styles.css 拆分**：4000+ 行单文件，建议按页面拆成 `@layer`（base/lobby/table/admin），
  构建产物不变，可维护性显著提升。
- **RoomManager 缓存策略**：本次已加「归档即逐出」；后续若房间量大，可再加
  LRU + 空闲 TTL（actor 空闲 30 分钟落库后逐出）。
- **视觉回归**：Playwright 截图对比（登录/大厅/牌桌三个断点 × 桌面/移动）。
