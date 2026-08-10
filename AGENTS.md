# AGENTS.md — 断箭蛆工具开发须知

> 本文件是项目交接文档，随项目更新（需要 agent 自我更新）。新接手的 agent 先通读本文件再动手。

## 1. 项目概览
- **是什么**：Electron 桌面工具（《断箭 / Broken Arrow》游戏辅助）。监听游戏 GameLogs 解析对局，调用公开查询站 **BATrace** 的 API，本地持久化玩家/对局/封禁/卡组数据，提供玩家调查、对局档案、封禁提醒、卡组备份、心跳统计等。
- **当前版本**：3.3.2（改版本 = package.json + version.txt，界面徽标自动读 `app.getVersion()`）。
- **技术栈**：Electron 31（主进程 Node）、无框架原生渲染（renderer/app.js + index.html + styles.css）、BATrace REST、本地 JSON 存储。
- **数据目录**：`%APPDATA%/broken-arrow-log-assistant/` → settings.json、players-db.json（追踪库）、match-archive.json（日志原始档案）、batrace-cache.json（API 磁盘缓存）、api-usage.json（24h 配额）、api-health.json（稳定性灯上次结果）、deck-sync.json（卡组包状态）、heartbeat-uid.txt（匿名 ID）。
- **卡组目录**：`AppData/LocalLow/SteelBalalaikaStudio/BrokenArrow/` → `Decks`（前线）、`DeckBackups`（后勤，含唯一 `上一局卡组包.zip`）、`DeckSync`（旧版遗留，仅删除账号时清理）。

## 2. 最重要的约束：API 调用必须省着用
本工具依赖 BATrace 公开接口，该站不稳定，**任何时候都要把 API 调用降到最低**，不给用户留「手痒多按一下」的入口。
- **API 稳定性灯（BATrace ●）只允许每小时自动检测一次**：禁止任何「点击重测 / 立即检测」等用户可手动触发探测的入口（已按要求移除）。
- 24 小时配额固定 **240 次**，设置里不暴露、代码里不放宽。
- 后台同步（封禁榜 / 本机对局 / 胜负回填）每小时一次，不加频。
- 缓存优先：命中缓存就不重复拉；只有需要「每小时真拉取」的后台同步才用短 TTL。
- 新增任何请求 BATrace 的功能前先评估调用量，优先复用本地数据（players-db、batrace-cache、api-health.json）。
- 健康检查探针不计配额，但也仅每小时一次。

## 3. 目录与文件职责
| 文件 | 职责 |
|---|---|
| main.js | 主进程：窗口、日志监听装配、全部 IPC、定时同步（封禁/对局/健康检查）、版本检查、matchSummary/matchDetail、惰性详情补齐 |
| preload.js | contextBridge 暴露 `window.api`（IPC 封装），渲染层只能经它调主进程 |
| renderer/app.js | 全部 UI 逻辑：渲染/事件/右键菜单/雷达加载动画/调查羁绊/对局档案/封禁/主题/设置 |
| renderer/index.html、styles.css、game.js | 页面结构 / 样式 / 防空小游戏（开发者娱乐，与加载无关） |
| src/logParser.js、logWatcher.js | GameLogs 解析状态机：matchStart/matchEnd/roster/lobbyPlayers/localName/session 事件 |
| src/tracker.js | 本地玩家追踪库（players-db.json）：matches/players/knownBans/localAccounts/playerSnapshots；胜负判定链、`fillMatchFromMatchInfo`、`setMatchWinner`、导出 `winnerTeamFromMatch` |
| src/batrace.js | BATrace API 客户端：限流、磁盘缓存、240 配额（ApiUsage/Cache） |
| src/analyzer.js | 玩家报告/蛆指数、`extractMini`、MAP_NAMES、`mapName` |
| src/apiHealth.js | API 稳定性灯：每小时 4 个轻量探针（不计配额） |
| src/heartbeat.js | 心跳统计 + `fetchViaProxy`（直连失败走免费代理） |
| src/config.js | 设置 DEFAULTS（settings.json） |
| src/deckSync.js | 卡组「上一局卡组包」唯一自动备份 + 换号替换提醒 |
| src/apm.js、inputHook.js | APM 统计（默认关闭，全局只读钩子） |
| src/storage.js、zip.js | MatchArchive / 极简 ZIP 读写 |
| server/worker.js | Cloudflare 心跳服务端（POST/GET /heartbeat、GET /online-count） |
| smoke.js | Electron 无头冒烟（stub IPC，需 escalate） |

## 4. IPC 清单（preload `window.api.*` ↔ main `ipcMain.handle`）
- 配置：config:get/set/selectDir/detectDir/validateDir
- 会话/监听：session:get、watcher:status
- 对局查询：match:queryCurrent、match:queryRoster、match:syncNow
- 报告：search:players、report:player、report:maggot
- 档案：archive:list、archive:clear
- 追踪：tracker:profile、tracker:matches、tracker:matchDetail、**tracker:refreshMatch**、tracker:listAccounts、tracker:deleteAccount、tracker:getBans、tracker:syncBans、tracker:cheaters
- 封禁：test:banNotify、test:versionUpdate
- 版本：app:version；用量：usage:get；心跳：heartbeat:get、heartbeat:ping；API 灯：api:health
- 卡组：deck:paths/list/backup/deploy/delete/openFolder/syncRestore/syncIgnore/syncDismiss
- 其它：shell:open
- 渲染层监听（主进程 → renderer 推送）：session、watcher、match:querying/player/done、budget、heartbeat、api:health、version、bans:changed、bans:alert、matches:changed、deck:changed、deck:syncAlert、archive:changed、maggot:progress

## 5. 关键数据流
- **对局**：logParser → `matchEnd` → `archive.add` + `tracker.recordLogMatch`（只收**数字 fid** 的局）+ 推 `matches:changed`（对局档案/上一局即时刷新）。
- **每小时同步**：`syncMyMatches`（players/matches?stbid=<本机ID>&limit=10）→ `upsertApiMatches`（填 mode/队伍/ELO/评分/胜方）+ `backfillMissingWinners` + `backfillPendingWinners`（`winnerTeamFromMatch` destructionScore 推导，最多 20 局/小时）。
- **封禁**：`syncBanList`（leaderboard/ban?limit=500）→ `applyBanSnapshot` → 仅「之前遇到过」的弹提醒（系统 Notification + 应用内对话框 `bans:alert`）。
- **心跳**：Heartbeat 每 2 分钟；在线人数 GET 直连失败 → `fetchViaProxy`（allorigins/raw → allorigins/get → corsproxy.io，并行）；上报 POST 失败 → 代理 GET /heartbeat?userId=&v= 兜底（服务端已支持）。
- **版本检查**：`checkVersion` 直连 raw.githubusercontent 失败 → `fetchViaProxy`。
- **API 稳定性灯**：`probeApiHealth` 每小时，4 个轻量端点（search/info/ban/matches），不计配额。
- **卡组**：`matchStart`（非回放）→ `deckSync.onMatchStart` 用当前 Decks 覆盖唯一 `上一局卡组包.zip`；换号提醒 `replaceAll` 写回前线。

## 6. 对局档案数据模型（players-db.json → matches，fid 为唯一键）
- 单局字段：fid、mapId、map、endTime、durationSec、winnerTeam(0|1|null)、localWon(bool|null)、localTeam、localTeamId(0|1|100)、localSpectator、mode('ranked'|'custom'|null)、localEloDelta、localEloAfter、localScores{destruction,losses,objectives}、localPlayerId、localPersona、players[]、source('log'|'api')、firstSeenAt、syncedAt。
- players[] 字段：id、name、teamId、team、oldRating、newRating、destructionScore、lossesScore、objectivesCaptured、killed（=API 的 `Destruction` 击毁数）、damageDealt、damageReceived、dlRatio、supplyPoints、exp、medals。
- 上限：matches 500（按 endTime 淘汰）、players 5000（LRU）；knownBans 永久。
- 懒补齐：`tracker:matchDetail` / `tracker:refreshMatch` 在本地缺字段（mode/队伍/评分/名单，或排位缺 ELO）时拉 /api/match（+自定义无 WT 时 /api/analysis/match 用 destructionScore 推胜方），回写本地并推 `matches:changed`（点击触发、24h 缓存）。

## 7. 数据约定（BATrace 接口，实测锁定，改判定先看这里）
- **队伍编码**：`TeamId` 缺失=Alpha(0)、`1`=Bravo、`100`=观战。
- **模式**：`Type` 无=排位，有(1/3)=自定义。
- **胜负判定链（本机视角）**：
  1. 观战（localTeamId=100）→ localWon=null，界面显示「观战」；
  2. **排位且 ELO 增减非 0 → 以 ELO 为权威**（`localWon = delta>0`），并同步校正 `winnerTeam`（输则胜方=对面队伍）——用于纠正旧「占领分判定」留的错误胜方（如 8049993）；
  3. 否则 `WinnerTeam`∈{0,1} 对比本机队伍；
  4. 自定义无 WT → `teamComparison.destructionScore` 高者胜（兜底，仅 WT 缺失时用；7966507 有 WT 的局 destruction 会与 WT 相反，勿当权威）；
  5. 都无 → null（未知）。
- 启动时 `_recomputeLocalWon()` 对排位局按 ELO 重算，修复旧数据。
- **评分** = API 返回的 `DestructionScore / LossesScore`（如 5855/6840）。
- 胜负权威来源顺序：排位 ELO → WinnerTeam → destructionScore（自定义兜底）→ 未知。

## 8. 测试
- **单元测试**：`.patchtmp/*-test.js`（已 gitignore），直接 `node .patchtmp/tracker-archive-test.js` 等运行。当前断言 180 项：对局档案 42、回归 36、多账号 32、快照 20、卡组 25、心跳 16、API 灯 9。
- **冒烟**：`npm run smoke`（Electron 无头，需 escalate 权限；stub IPC 在 smoke.js，含对局档案表格/详情/右键菜单断言）。
- **真实接口冒烟**：临时脚本拉 /api/match 等验证（注意省 API、别刷）。
- 改完必须：`node --check` 相关文件 + 跑相关测试 + `npm run smoke`。

## 9. 打包 / 发布
- `npm run dist`：electron-builder --win（nsis + portable）。**`npmRebuild:false`**（uiohook-napi 是 N-API、自带 win32-x64 预编译，不需要 MSVC）。
- 推 `v*` 标签触发 GitHub Actions 自动打包发布（.github/workflows）。
- 版本升级：只改 package.json + version.txt（界面徽标/关于自动跟随）。
- **git push 在本环境常连不上 GitHub（443）**：改完由用户自己在 PowerShell 执行 `git add -A && git commit && git push && git tag vX.Y.Z && git push origin vX.Y.Z`；LF→CRLF 警告无害。

## 10. 踩坑记录（先读，避免重复踩）
### 编码 / 脚本执行
1. **PowerShell 管道/内联里写中文必乱码**：`@'...'@ | node -` 或 `node -e "...中文..."` 的中文会变 `?`。含中文的代码一律：用 node_repl 直接改文件，或写成 UTF-8 文件再 `node 文件.js`；改完检查 `\?\?\?\?` 是否存在。
2. **node_repl 持久绑定**：kernel 跨调用保留顶层变量，`const` 不能重复声明。用 `var`/新名字，或整段包进 `(async () => {...})()`。
3. **node_repl 里 async IIFE 的 console.log/返回值常不显示**：结果 `writeFileSync` 到临时文件再查看，或写成 `.patchtmp/*.js` 用 exec `node` 跑。
4. **node_repl 里构造含反引号/${} 的代码字符串必炸**：别用外层模板字面量，改用「双引号字符串数组 `join('\n')`」，内部双引号转义 `\"`。
5. **PowerShell 5.1 不支持 `&&`**；`node -e` 嵌引号极易错——优先 Select-String / 写脚本文件。
6. **Node ≥22 的 CJS 文件出现顶层 await 报 ERR_AMBIGUOUS_MODULE_SYNTAX**：测试脚本有顶层 await 必须包 `(async () => {...})().catch(...)`。
7. **`String.replace` 找不到子串会静默失败**（尤其中文锚点因乱码对不上）——每次 replace 后必须验证生效。
### 其它
8. **Electron 冒烟需升级权限**（GUI 进程在沙箱被拒）：`npm run smoke` 用 require_escalated。
9. **git push 到 GitHub 在本环境常连不上（443）**：由用户自己 push/tag。
10. **PowerShell `Set-Content -Encoding UTF8` 会写 BOM**：尽量统一用无 BOM 写入。
11. **smoke.js 的 IPC 桩不能重复注册同名 handler**（ipcMain.handle 第二次会抛错导致冒烟挂起）——加桩前先查重。
