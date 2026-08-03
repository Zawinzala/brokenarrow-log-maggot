# 断箭蛆工具 byZola（Electron 版）

基于游戏官方 GameLogs 日志 + [BATrace](https://app.batrace.top/) 公开数据查询的本地辅助工具。
替代旧的「断箭蛆工具」（旧工具因 BATrace API 改版已失效，本版本已适配新版接口）。

## 功能

- **日志实时监听**：监听你设置的 GameLogs 目录，自动识别当前对局（地图 / 对局 ID / 玩家名单 / 队伍 / 卡组）。除原生 `Gamelog__*.log` 外，也兼容用户自放的 `.log/.txt` 文本日志（同名/多文件时原生日志优先）。
- **房间内玩家**：开战前就能看到房内玩家名单（日志 Incoming client 行，ID 即 BATrace ID），点「刷新粗查」即可提前查看情报。
- **粗查（多人）**：检测到对局后自动查询每位参战玩家的 ELO、K/D、胜率、样本数、偏好兵种、最爱单位。每名玩家只查 1 次，10v10 一局约 10 次调用（上限 20 次，机器人/观战/重复自动跳过），顶栏实时显示「API 已用 X / 120（24h）」。每个玩家卡片带 📋 复制（一行情报），每队标题带「复制单队」（名字+ELO 一行），方便报备。
- **蛆查（单人）**：只有单人查询触发，算法与「断箭蛆指数」网站 V4 完全同步——拉取最近 12 场带 ELO 变动的有效对局，按每局在己方队伍内的 MVP 名次求平均，经余弦平滑曲线映射到 1.0~10.0。附 12 局明细表、KD/击杀/MVP/经济排名、胜率、变强/变蛆趋势。
- **玩家粗查报告**：一次调用生成 ELO、K/D、DMR、胜率、偏好兵种、最爱单位、地图表现、打法风格、近期对局表，支持复制单行情报。
- **玩家搜索**：按名字或 ID 搜索 BATrace 玩家。
- **对局档案**：本地记录每次解析到的对局，跨会话查看。
- **卡组工具**：备份 / 恢复游戏卡组（前线 Decks/*.dek ⇄ 后勤 DeckBackups/*.zip），支持「备份全部」「备份选中」、一键部署、删除、打开目录（默认按修改时间倒序排列）。卡组目录自动检测（兼容不同机器上的目录名/位置），找不到时明确提示而非静默失败。
- **软件更新提醒**：启动时读取 [version.txt](https://github.com/Zawinzala/brokenarrow-log-maggot/blob/main/version.txt)（第一行为版本号，如 `v3.1.0`；其余行为公告），有新版本时顶部横幅提醒并显示公告。
- **关于与致谢**：内置软件原理声明（只读公开日志与公开接口、不碰内存/注入/反作弊），并附 BATrace 查询站与蛆指数网站的致谢链接。
- **24 小时 API 配额**：软件内置每 24 小时最多 120 次真实请求的保护（缓存命中不计入），防止刷爆查询站；超限后自动暂停查询，次日窗口滚动恢复。该上限固定，不向用户开放修改。
- **使用统计**：默认开启心跳，让作者看到在线人数（只上报匿名 ID + 版本号，不含任何玩家数据；可在「设置」里关闭）。

## 环境要求

- Windows + [Node.js](https://nodejs.org/)（建议 18+）
- 游戏《断箭》（Broken Arrow），日志目录形如：
  `C:\Program Files (x86)\Steam\steamapps\common\broken_arrow\GameLogs`

## 安装与运行

```powershell
# 首次：安装 Electron（需要联网，装一次即可）
npm install

# 启动
npm start
```

启动后在「设置」里选择日志目录：
- 点「自动检测 Steam 目录」会自动找默认安装路径；
- 也可以手动点「浏览…」选择；
- 没有装游戏时，可以把任意 `Gamelog__*.log` 复制到一个文件夹，把目录指过去也能测试。

## 粗查与蛆查

- **粗查**：点搜索结果 = 1 次 API 调用，快速看 ELO/胜率/偏好/最爱单位。
- **蛆查**：点「🐛 蛆查（同步网站）」按钮。冷查需要拉取最近 12 场对局明细，约 13~14 次调用（单局明细 24 小时缓存、分析 6 小时缓存，同一天重复蛆查几乎不消耗调用）。
- 蛆指数只在单人蛆查里出现，多人粗查不涉及。

## 打包为 EXE（发布版）

本工程已内置 [electron-builder](https://www.electron.build/) 配置（`package.json` 的 `build` 字段）。

```powershell
# 1) 安装打包工具（联网，一次即可）
npm install

# 2) 打出安装版 + 便携版（dist/ 下）
npm run dist
```

- 产物在 `dist/`：`断箭蛆工具 byZola Setup x.y.z.exe`（安装版）与 `断箭蛆工具 byZola x.y.z.exe`（便携版，双击即用）。
- 未提供自定义图标时使用 Electron 默认图标；想换图标，把 `build/icon.ico` 放到工程根目录（electron-builder 会自动识别）。
- 版本号改 `package.json` 的 `version` 字段即可（会同时显示在标题栏与「关于」里）。

### GitHub 自动打包（推荐发布方式）

仓库已内置 `.github/workflows/build.yml`，推送版本标签即可自动打包并发布：

```powershell
git add -A
git commit -m "v3.0.0"
git push
git tag v3.0.0
git push origin v3.0.0
```

- Actions 会在 Windows 上自动 `npm install && npm run dist`，把 `dist/*.exe` 上传为构建产物，并（仅打标签时）自动创建一个 GitHub Release 附带安装版/便携版 exe，用户可直接下载。
- 也可以不推标签，在仓库 Actions 页面手动点「Run workflow」只出产物不出 Release。
- 首次使用前确认：本地已跑过一次 `npm install` 生成最新 `package-lock.json`（本工程已把 electron-builder 加进依赖，锁文件需刷新一次再推送）。

## 版本提醒机制

- 工具每次启动会访问 `https://raw.githubusercontent.com/Zawinzala/brokenarrow-log-maggot/main/version.txt`。
- 文件格式：第一行版本号（如 `v3.1.0`），后续行是公告（可空）：
  ```
  v3.1.0
  公告：修复了蛆查，新增房间名单
  ```
- 当远端版本号高于本机 `package.json` 版本时，顶部弹横幅 + 公告，并链接到 GitHub 页面。

## 心跳统计（作者用来统计在线人数）

- 软件默认开启（可在「设置 → 加入使用统计」关闭），每 2 分钟上报一次匿名 ID + 版本号（不包含任何玩家/对局数据），顶栏显示当前在线人数。
- 默认统计服务：`https://heartbeat-service.zawin-zala.workers.dev`（可在设置里改）。
- 客户端接口约定：`POST {url}/heartbeat`（body `{ userId, v }`）+ `GET {url}/online-count`。参考实现见 `server/worker.js`（Cloudflare Workers，一个文件）。
- 上报失败静默忽略，不影响软件使用；「设置 → 测试心跳」可手动触发一次并显示上报结果，便于排查服务器问题。

## 技术要点

- **CORS 与 Electron**：BATrace 接口不带 `Access-Control-Allow-Origin`，浏览器页面无法跨域调用（所以之前只能写油猴脚本）。Electron 主进程是 Node 环境，直接发 HTTP 请求不受 CORS 限制——所有请求都走主进程，界面只通过 IPC 拿数据。
- **日志读取**：只增量读取最新日志文件的新增字节（历史日志可能几百 MB，绝不整读）；游戏重启生成新日志时自动切换文件。文件匹配放宽为 `.log/.txt`（方便自放测试日志），多个文件时 `Gamelog__` 前缀优先、再按修改时间取最新。
- **核心接口（2026-08 实测有效）**：
  - `GET /api/analysis/player?stbid=` 一次返回 ELO 趋势 / 胜负 / 最爱单位 / 偏好兵种 / 地图表现 / 打法——粗查与报告都走它，6 小时磁盘缓存
  - `GET /api/analysis/match?matchid=` 单局完整数据（`mvpRanking` 队内 MVP 得分 + `economy`）——蛆查专用，24 小时磁盘缓存
  - `GET /api/players/search?q=&limit=` 玩家搜索（10 分钟缓存）
- **限流与缓存**：请求默认间隔 350ms（设置里可调），结果写本地磁盘缓存。顶栏「API 已用 X / 120（24h）」只统计真正打到 BATrace 的请求数（缓存命中不计），并受内置的 24 小时 120 次配额保护（固定值，不向用户开放修改）。
- **蛆指数同步**：算法、等级文案（👑神/🦁团队支柱/😐平平淡淡/🐛有点蛆/💩蛆！）、取数口径（近 12 场带 ELO 变动的有效对局、队内 MVP 名次、余弦曲线）与网站 V4 完全一致，核心代码在 `src/analyzer.js` 的 `buildMaggotReport`。

## 已知限制

- 老对局（2026-08 之前的部分对局）在 BATrace 中缺少部分字段，胜负显示为「未知」。
- 有效对局不足 12 场（或对局明细少于 10 人）时无法计算蛆指数，会给出提示。
- 地图名优先从 `mapPerformance` 动态注册（`src/analyzer.js`），只有从未出现过的地图才显示 `地图#N`。
- 只读日志 + 公开接口，不碰内存、不注入、不影响反作弊。

## 目录结构

```
main.js                 Electron 主进程（窗口 / IPC / 版本检查 / 蛆查装配）
preload.js              渲染进程安全桥接
src/config.js           设置读写 + Steam 目录自动检测
src/logParser.js        日志解析状态机（对局 / 房间名单 / 卡组）
src/logWatcher.js       目录轮询 + 增量读取
src/batrace.js          BATrace API 客户端（限流 + 缓存 + 24h 配额计数）
src/heartbeat.js        心跳统计（可选，匿名上报在线）
src/analyzer.js         玩家分析（粗查报告 / 蛆查同步网站算法）
src/storage.js          本地对局档案
renderer/               界面（原生 HTML/CSS/JS）
server/                 心跳统计服务端示例（Cloudflare Workers）
.github/workflows/      GitHub Actions 自动打包（推 v* 标签即发布）
```