# 🐛 断箭蛆工具 byZola（Broken Arrow Log Assistant）

[中文](#中文) · [English](#english) · [日本語](#日本語) · [Русский](#русский)

---

## 中文

基于游戏官方 GameLogs 日志 + [BATrace](https://app.batrace.top/) 公开数据的本地复盘辅助工具。
只读公开日志与公开接口：不碰内存、不注入进程、不影响反作弊。

### 功能
- **日志实时监听**：自动识别当前对局、房间内玩家名单（开战前即可查看）
- **自动粗查**：对局玩家 ELO / 胜率 / 偏好兵种 / 最爱单位，每局约 10 次调用，内置 24h 配额保护
- **查蛆指数**：单人触发，算法与断箭蛆指数网站同步（MVP 名次 → 1~10 分）
- **对局录像（行车记录仪）**：每局自动录制**你自己的屏幕视角**（1080p、1 秒 1 帧），纯本地保存，可在「对局档案」里直接播放
- **卡组工具**：备份 / 恢复游戏卡组，支持一键备份全部
- **玩家追踪（仿 VRCX）**：本地数据库持续记录见过的玩家；右键「调查」查看相遇次数、同队/敌对胜负、改名历史、是否被封
- **封禁监控**：每小时检查 BATrace 封禁名单，发现新被封玩家弹窗提醒
- **房间工具用户**：同一房间里谁也在用本工具（隐私保护，只显示匹配结果）
- **上一局**：当前房间卡片可一键查看上一局名单并自动粗查
- **四主题 + 四语言**：黑 / 白 / 青 / 橙 主题；中文 / English / 日本語 / Русский 界面切换
- **心跳统计**：匿名在线人数（默认开启，可关闭）

### 下载

最新版本见 **[Releases](https://github.com/Zawinzala/brokenarrow-log-maggot/releases)**，推荐下载普通版（免安装）。

### 快速开始
1. 安装后打开软件，点右上角「设置」
2. 选择断箭的日志目录（`...\broken_arrow\GameLogs`），可点「自动检测 Steam 目录」
3. 进入对局即自动粗查玩家；搜索玩家后点「🐛 查蛆指数」看蛆指数

> ⚠️ 粗查数据来自 BATrace 历史数据，存在数天延迟，并非实时对战数据。

### 致谢
玩家数据由 [BATrace 查询站](https://app.batrace.top/) 提供；蛆指数算法与 [断箭蛆指数网站](https://github.com/Zawinzala/Broken-Arrow-Maggot) 保持同步。

---

## English

A local post-match review tool based on the official GameLogs + [BATrace](https://app.batrace.top/) public data.
Read-only: no memory access, no injection, no effect on anti-cheat.

### Features
- **Live log monitoring**: auto-detect the current match and lobby players (visible before the battle starts)
- **Auto player query**: ELO / win rate / favorite units per match (~10 calls per match, built-in 24h quota guard)
- **Maggot Index**: per-player trigger, algorithm synced with the Maggot Index website (MVP rank → 1~10)
- **Dashcam recordings**: auto-record **your own screen** every match (1080p, 1 frame/sec), stored locally and playable from the Match Archive
- **Deck tools**: backup / restore game decks, one-click full backup
- **Player tracker (VRCX-like)**: keeps a local database of players you met; right-click "Investigate" for encounters, W/L vs teammates/enemies, name history, bans
- **Ban monitor**: checks the BATrace ban list hourly, alerts on newly banned players you met
- **Room tool users**: shows who else in the room is using this tool (privacy-preserving, only matching results)
- **Previous match**: one-click view of the previous match roster with auto-query
- **4 themes + 4 languages**: dark / light / cyan / orange; UI in 中文 / English / 日本語 / Русский
- **Heartbeat stats**: anonymous online count (on by default, can be disabled)

### Download

Latest release: **[Releases](https://github.com/Zawinzala/brokenarrow-log-maggot/releases)** (portable version recommended).

### Quick start
1. Launch the app and open "Settings" (top-right)
2. Choose the Broken Arrow log folder (`...\broken_arrow\GameLogs`) or click "Auto-detect Steam folder"
3. Players are queried automatically during a match; search a player and click "Maggot Index"

> ⚠️ Query data comes from BATrace historical data with a few days of delay; it is not real-time.

### Credits
Player data by [BATrace](https://app.batrace.top/); Maggot Index algorithm synced with the [Broken Arrow Maggot](https://github.com/Zawinzala/Broken-Arrow-Maggot) website.

---

## 日本語

ゲーム公式の GameLogs ログと [BATrace](https://app.batrace.top/) 公開データを使ったローカル対局レビューツール。
読み取り専用：メモリ操作・プロセス注入・アンチチートへの影響は一切ありません。

### 機能
- **ログ常時監視**：現在の対局と部屋のプレイヤー一覧を自動認識（開戦前でも閲覧可）
- **自動照会**：対局プレイヤーの ELO / 勝率 / 得意兵科 / お気に入りユニット（1対局あたり約10回、24時間クォータ内蔵）
- **蛆指数**：単独トリガー。蛆指数サイトと同期（MVP 順位 → 1〜10 点）
- **ドライブレコーダー（対局録画）**：毎対局、**自分の画面**を自動録画（1080p・1秒1フレーム）。ローカル保存のみで、「対局アーカイブ」から直接再生可能
- **デッキツール**：デッキのバックアップ / 復元、全件一括バックアップ対応
- **プレイヤートラッカー（VRCX風）**：出会ったプレイヤーをローカルDBに記録。右クリック「調査」で遭遇回数・同チーム/敵対の勝敗・改名履歴・BAN状態を表示
- **BANモニタリング**：毎時 BATrace の BAN リストをチェックし、出会ったプレイヤーの新規 BAN を通知
- **部屋のツール利用者**：同じ部屋で誰がこのツールを使っているか表示（プライバシー保護、マッチのみ）
- **前の対局**：ワンクリックで前の対局の名簿を表示し自動照会
- **4テーマ + 4言語**：ダーク / ライト / シアン / オレンジ；中文 / English / 日本語 / Русский のUI切替
- **ハートビート統計**：匿名オンライン人数（初期オン、オフ可）

### ダウンロード

最新版は **[Releases](https://github.com/Zawinzala/brokenarrow-log-maggot/releases)** から（ポータブル版推奨）。

### クイックスタート
1. アプリを起動し、右上「設定」を開く
2. Broken Arrow のログフォルダ（`...\broken_arrow\GameLogs`）を選択するか「Steam フォルダを自動検出」
3. 対局中は自動でプレイヤーを照会。プレイヤーを検索して「蛆指数」で指数を確認

> ⚠️ 照会データは BATrace の履歴データで数日遅延があります。リアルタイムではありません。

### 謝辞
プレイヤーデータ：[BATrace](https://app.batrace.top/)。蛆指数アルゴリズムは [Broken Arrow Maggot](https://github.com/Zawinzala/Broken-Arrow-Maggot) と同期。

---

## Русский

Локальный инструмент для разбора матчей на основе официальных логов GameLogs и открытых данных [BATrace](https://app.batrace.top/).
Только чтение: без доступа к памяти, без внедрения, без влияния на античит.

### Возможности
- **Мониторинг логов**: автоопределение текущего матча и игроков в комнате (видно до начала боя)
- **Автозапрос игроков**: ELO / винрейт / любимые юниты (около 10 запросов за матч, защита лимита 24ч)
- **Индекс Maggot**: по отдельному игроку, алгоритм синхронизирован с сайтом Maggot (место MVP → 1~10)
- **Видеорегистратор**: автоматическая запись **вашего экрана** каждый матч (1080p, 1 кадр/сек), хранится локально, просмотр из архива матчей
- **Колоды**: резервное копирование / восстановление, полный бэкап одним кликом
- **Трекер игроков (как VRCX)**: локальная БД встреченных игроков; ПКМ «Исследовать» — встречи, победы/поражения, история имён, баны
- **Мониторинг банов**: проверка списка банов BATrace каждый час, уведомление о новых банах встреченных игроков
- **Пользователи инструмента в комнате**: показывает, кто ещё в комнате использует этот инструмент (приватно, только совпадения)
- **Предыдущий матч**: список игроков прошлого матча одним кликом с автозапросом
- **4 темы + 4 языка**: тёмная / светлая / циан / оранжевая; интерфейс на 中文 / English / 日本語 / Русский
- **Статистика heartbeat**: анонимное число онлайн (вкл. по умолчанию, можно отключить)

### Скачать

Последняя версия: **[Releases](https://github.com/Zawinzala/brokenarrow-log-maggot/releases)** (рекомендуется портативная).

### Быстрый старт
1. Запустите приложение и откройте «Настройки» (справа сверху)
2. Укажите папку логов Broken Arrow (`...\broken_arrow\GameLogs`) или «Автоопределение папки Steam»
3. Во время матча игроки запрашиваются автоматически; найдите игрока и нажмите «Индекс Maggot»

> ⚠️ Данные запроса — исторические данные BATrace с задержкой в несколько дней, не в реальном времени.

### Благодарности
Данные игроков: [BATrace](https://app.batrace.top/). Алгоритм индекса Maggot синхронизирован с [Broken Arrow Maggot](https://github.com/Zawinzala/Broken-Arrow-Maggot).
