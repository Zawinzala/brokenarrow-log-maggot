import flet as ft
import os
import time
import re
import threading
import glob
import json
import urllib.request
import asyncio
import urllib.error
import math
import sys
import subprocess
import requests
import uuid
from packaging import version
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

# ================= 配置区域 =================
# --- 核心版本与API配置 ---
CURRENT_VERSION = "v1.0.1" # [修改] 版本号升级
GITHUB_USER = "Zawinzala"
GITHUB_REPO = "brokenarrow-log-maggot"
GITHUB_BRANCH = "main"
MEASUREMENT_ID = 'G-YVD13YTXLW'# 谷歌追踪器心跳检测
API_SECRET = 'Paiqfm7qRPmFXmTUBWMihg'# 谷歌追踪器心跳检测
HEARTBEAT_INTERVAL = 10  # <心跳为 10 秒

# --- 游戏路径配置 ---
DEFAULT_STEAM_PATH = r"C:\Program Files (x86)\Steam\steamapps\common\broken_arrow\GameLogs"
CONFIG_FILE = "config.json"
STATS_CACHE_FILE = "stats_cache.json"
MATCH_DB_DIR = "matches_data"
UNIT_DB_FILE = "units_db.json"
STATS_EXPIRY = 15 * 60
UNIT_EXPIRY = 24 * 3600
MAX_MATCH_FILES = 1000
UNIT_API_URL = "https://batrace.aoeiaol.top/api/v1/Units"
MATCH_LIST_URL = "https://www.barmory.net/stb/commander/{}/matches?time={}"
MATCH_DETAIL_URL = "https://www.barmory.net/stb/match/{}"

# --- 勋章配置 ---
MEDAL_CONFIG = [
    {'key': 'Destruction', 'icon': '⚔️', 'name': '口人魔', 'color': '#f87171'},
    {'key': 'Losses', 'icon': '☠️', 'name': '送死王', 'color': '#9ca3af'},
    {'key': 'DamageDealt', 'icon': '💥', 'name': '炸炸炸', 'color': '#fb923c'},
    {'key': 'DamageReceived', 'icon': '🧱', 'name': '耐炸王', 'color': '#94a3b8'},
    {'key': 'SupplyPointsConsumed', 'icon': '🍔', 'name': '大胃袋', 'color': '#facc15'},
    {'key': 'SupplyPointsConsumedFromAllies', 'icon': '🐱', 'name': '小馋猫', 'color': '#f472b6'},
    {'key': 'SupplyPointsConsumedByAllies', 'icon': '🚑', 'name': '奶妈', 'color': '#4ade80'},
    {'key': 'TotalSpawnedUnitScore', 'icon': '🛒', 'name': '采购官', 'color': '#60a5fa'},
    {'key': 'TotalRefundedUnitScore', 'icon': '💸', 'name': '仅退款', 'color': '#2dd4bf'}
]

class UnitManager:
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(UnitManager, cls).__new__(cls)
            cls._instance.units = {}
            cls._instance.loaded = False
        return cls._instance
    
    def _parse_list(self, data):
        for u in data:
            uid = u.get('Id') or u.get('id')
            name = u.get('Name') or u.get('name')
            if uid and name:
                self.units[str(uid)] = name
    
    def load_units(self, log_func=print):
        if self.loaded:
            return
        
        if os.path.exists(UNIT_DB_FILE):
            if time.time() - os.path.getmtime(UNIT_DB_FILE) < UNIT_EXPIRY:
                try:
                    with open(UNIT_DB_FILE, 'r', encoding='utf-8') as f:
                        self._parse_list(json.load(f))
                    self.loaded = True
                    log_func("单位库: 加载本地缓存")
                    return
                except:
                    pass
        
        try:
            log_func("单位库: 同步中...")
            req = urllib.request.Request(UNIT_API_URL, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode())
                self._parse_list(data)
                with open(UNIT_DB_FILE, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False)
                self.loaded = True
                log_func(f"单位库: 更新完成 ({len(self.units)})")
                return
        except Exception as e:
            log_func(f"单位库更新失败: {e}")
        
        if os.path.exists(UNIT_DB_FILE):
            try:
                with open(UNIT_DB_FILE, 'r', encoding='utf-8') as f:
                    self._parse_list(json.load(f))
                self.loaded = True
            except:
                pass
    
    def get_name(self, uid):
        return self.units.get(str(uid), f"Unit {uid}")

class MatchCache:
    _lock = threading.Lock()
    
    @classmethod
    def _get_path(cls, mid):
        os.makedirs(MATCH_DB_DIR, exist_ok=True)
        return os.path.join(MATCH_DB_DIR, f"{mid}.json")
    
    @classmethod
    def _cleanup_old_matches(cls):
        try:
            files = glob.glob(os.path.join(MATCH_DB_DIR, "*.json"))
            if len(files) <= MAX_MATCH_FILES:
                return
            files.sort(key=os.path.getmtime)
            to_delete = files[:-MAX_MATCH_FILES]
            for f in to_delete:
                if os.path.basename(f).endswith(".json"):
                    try:
                        os.remove(f)
                    except:
                        pass
        except Exception as e:
            print(f"清理旧对局文件失败: {e}")
    
    @classmethod
    def get(cls, mid):
        filepath = cls._get_path(mid)
        if os.path.exists(filepath):
            with cls._lock:
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        return json.load(f)
                except:
                    return None
        return None
    
    @classmethod
    def set(cls, mid, data):
        filepath = cls._get_path(mid)
        with cls._lock:
            try:
                with open(filepath, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False)
                cls._cleanup_old_matches()
            except Exception as e:
                print(f"Save match {mid} failed: {e}")

class StatsCacheManager:
    def __init__(self):
        self.cache = {}
        self.load()
    
    def load(self):
        if os.path.exists(STATS_CACHE_FILE):
            try:
                with open(STATS_CACHE_FILE, 'r', encoding='utf-8') as f:
                    self.cache = json.load(f)
            except:
                self.cache = {}
    
    def save(self):
        try:
            with open(STATS_CACHE_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.cache, f, ensure_ascii=False)
        except:
            pass
    
    def get(self, uid):
        uid = str(uid)
        if uid in self.cache:
            entry = self.cache[uid]
            if time.time() - entry.get('timestamp', 0) < STATS_EXPIRY:
                return entry.get('data')
        return None
    
    def set(self, uid, data):
        self.cache[str(uid)] = {'data': data, 'timestamp': time.time()}
        self.save()
    
    def clear(self):
        self.cache = {}
        if os.path.exists(STATS_CACHE_FILE):
            try:
                os.remove(STATS_CACHE_FILE)
            except:
                pass

class GameState:
    def __init__(self):
        self.status = "等待日志..."
        self.current_file = None
        self.in_game = False
        self.lobby_players = {}
        self.game_teams = {"Alpha": [], "Bravo": []}
    
    def reset_lobby(self):
        self.lobby_players.clear()
        self.in_game = False
        self.status = "在大厅中 (Lobby)"
    
    def reset_all(self):
        self.reset_lobby()
        self.game_teams = {"Alpha": [], "Bravo": []}
        self.status = "状态已重置"

class Analyzer:
    @staticmethod
    def fetch_json(url):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.loads(response.read().decode())
        except Exception as e:
            raise e
    
    @staticmethod
    def analyze_player(uid, log_cb=None, progress_cb=None):
        def log(msg):
            if log_cb:
                log_cb(f"[{uid}] {msg}")
        def prog(p, msg):
            if progress_cb:
                progress_cb(uid, p, msg)
        
        log("开始分析...")
        prog(0.05, "连接服务器...")
        time_str = datetime.now().strftime("%Y-%m-%d_%H")
        list_url = MATCH_LIST_URL.format(uid, time_str)
        try:
            match_ids = Analyzer.fetch_json(list_url)
        except:
            return {"error": "网络错误/无记录"}
        
        if not match_ids or not isinstance(match_ids, list):
            return {"error": "无近期对局"}
        
        valid_matches_data = []
        current_index = 0
        TARGET_VALID_COUNT = 12
        
        all_matches = match_ids
        total_available = len(all_matches)
        
        log(f"发现 {total_available} 场记录，开始增量分析...")
        while len(valid_matches_data) < TARGET_VALID_COUNT and current_index < total_available:
            batch_size = 12 if current_index == 0 else 3
            batch_end = min(current_index + batch_size, total_available)
            batch_ids = all_matches[current_index:batch_end]
            
            current_valid = len(valid_matches_data)
            prog(
                0.1 + (current_index / total_available) * 0.8,
                f"加载: {current_valid}/{TARGET_VALID_COUNT} (扫描: {current_index}-{batch_end})"
            )
            
            with ThreadPoolExecutor(max_workers=5) as executor:
                future_to_info = {}
                for offset, mid in enumerate(batch_ids):
                    real_idx = current_index + offset
                    cached = MatchCache.get(mid)
                    if cached:
                        valid_matches_data.append({'id': mid, 'data': cached, 'index': real_idx})
                    else:
                        future_to_info[executor.submit(Analyzer.fetch_json, MATCH_DETAIL_URL.format(mid))] = (mid, real_idx)
                for future in as_completed(future_to_info):
                    mid, real_idx = future_to_info[future]
                    try:
                        data = future.result()
                        if data and 'Data' in data:
                            MatchCache.set(mid, data)
                            valid_matches_data.append({'id': mid, 'data': data, 'index': real_idx})
                            current_valid_dynamic = len(valid_matches_data)
                            prog(
                                0.1 + (current_index / total_available) * 0.8,
                                f"加载中... {current_valid_dynamic}/{TARGET_VALID_COUNT}"
                            )
                    except:
                        pass
            
            valid_matches_data.sort(key=lambda x: x['index'])
            temp_valid_list = []
            for m in valid_matches_data:
                data = m['data'].get('Data', {})
                players = list(data.values())
                if len(players) < 10:
                    continue
                has_elo_change = False
                for p in players:
                    if abs((p.get('NewRating', 0) or 0) - (p.get('OldRating', 0) or 0)) > 0.01:
                        has_elo_change = True
                        break
                if has_elo_change:
                    temp_valid_list.append(m)
            
            if len(temp_valid_list) >= TARGET_VALID_COUNT:
                break
            
            current_index += batch_size
            if current_index >= 60:
                break
        
        final_matches = []
        for m in valid_matches_data:
            data = m['data'].get('Data', {})
            players = list(data.values())
            if len(players) < 10:
                continue
            has_elo_change = False
            for p in players:
                if abs((p.get('NewRating', 0) or 0) - (p.get('OldRating', 0) or 0)) > 0.01:
                    has_elo_change = True
                    break
            if has_elo_change:
                final_matches.append(m)
            if len(final_matches) >= 12:
                break
        
        if len(final_matches) < 3:
            return {"error": f"有效局不足({len(final_matches)})"}
        
        log(f"有效对局: {len(final_matches)} 场")
        prog(0.95, "计算评分...")
        
        return Analyzer.calculate_maggot_index(uid, final_matches)
    
    @staticmethod
    def calculate_maggot_index(my_uid, matches):
        my_uid = str(my_uid)
        stats = []
        medal_counts = {}
        agg_units = {}
        wins = 0
        
        for m in matches:
            data = m['data'].get('Data', {})
            meta = m['data']
            players = []
            for pid, p_data in data.items():
                p_info = p_data.copy()
                p_info['Id'] = pid
                raw_tid = p_info.get('TeamId')
                p_info['TeamId'] = 1 if raw_tid == 1 else 0
                players.append(p_info)
            
            my_p = next((p for p in players if str(p['Id']) == my_uid), None)
            if not my_p:
                continue
            
            my_team_id = my_p['TeamId']
            
            winner_team = meta.get('WinnerTeam')
            if winner_team is None or winner_team > 1:
                t0_delta = sum((p.get('NewRating',0)-p.get('OldRating',0)) for p in players if p['TeamId']==0)
                t1_delta = sum((p.get('NewRating',0)-p.get('OldRating',0)) for p in players if p['TeamId']==1)
                winner_team = 0 if t0_delta > t1_delta else 1
            
            if my_team_id == winner_team:
                wins += 1
            
            ally = [p for p in players if p['TeamId'] == my_team_id]
            
            for conf in MEDAL_CONFIG:
                key = conf['key']
                vals = [p.get(key, 0) for p in ally]
                max_val = max(vals) if vals else 0
                if max_val > 0 and my_p.get(key, 0) == max_val:
                    medal_counts[key] = medal_counts.get(key, 0) + 1
            
            def calc_score(p):
                k = p.get('DestructionScore', 0)
                l = p.get('LossesScore', 0)
                o = p.get('ObjectivesCaptured', 0)
                return (k - l) / 1000.0 + o
            
            ally_sorted = sorted(ally, key=calc_score, reverse=True)
            try:
                my_rank_idx = next(i for i, p in enumerate(ally_sorted) if str(p['Id']) == my_uid)
                my_rank = my_rank_idx + 1
            except:
                my_rank = 5
            
            stats.append({'rank': my_rank, 'elo': my_p.get('NewRating', 0)})
            
            if 'UnitData' in my_p and my_p['UnitData']:
                for u in my_p['UnitData'].values():
                    uid = u.get('Id')
                    if not uid:
                        continue
                    if uid not in agg_units:
                        agg_units[uid] = {'d':0, 'k':0, 't':0}
                    agg_units[uid]['d'] += u.get('TotalDamageDealt', 0)
                    agg_units[uid]['k'] += u.get('KilledCount', 0)
                    agg_units[uid]['t'] += u.get('TotalDamageReceived', 0)
        
        if not stats:
            return {"error": "数据异常"}
        
        avg_rank = sum(s['rank'] for s in stats) / len(stats)
        normalized_rank = (avg_rank - 1) / 4.0
        s_curve_val = (1 - math.cos(normalized_rank * math.pi)) / 2.0
        maggot_score = round(1 + (s_curve_val * 9), 1)
        
        levels = ["👑 神", "🦁 团队支柱", "😐 平平淡淡", "🐛 有点蛆", "💩 蛆！"]
        label_idx = 0
        if maggot_score > 8:
            label_idx = 4
        elif maggot_score > 6:
            label_idx = 3
        elif maggot_score > 4:
            label_idx = 2
        elif maggot_score > 2:
            label_idx = 1
        
        sorted_medals = sorted(medal_counts.items(), key=lambda x: x[1], reverse=True)[:2]
        final_tags = []
        for key, count in sorted_medals:
            conf = next((c for c in MEDAL_CONFIG if c['key'] == key), None)
            if conf:
                final_tags.append(conf)
        
        fav_units = []
        if agg_units:
            top_d = max(agg_units.items(), key=lambda x: x[1]['d'])
            top_k = max(agg_units.items(), key=lambda x: x[1]['k'])
            top_t = max(agg_units.items(), key=lambda x: x[1]['t'])
            um = UnitManager()
            fav_units.append({'type': '⚡', 'val': int(top_d[1]['d']), 'name': um.get_name(top_d[0]), 'color': '#fb923c'})
            fav_units.append({'type': '🔫', 'val': int(top_k[1]['k']), 'name': um.get_name(top_k[0]), 'color': '#f87171'})
            fav_units.append({'type': '🛡️', 'val': int(top_t[1]['t']), 'name': um.get_name(top_t[0]), 'color': '#60a5fa'})
        
        latest_elo = stats[0]['elo'] if stats else 0
        win_rate = int((wins / len(stats)) * 100)
        
        return {
            "score": maggot_score,
            "label": levels[label_idx],
            "tags": final_tags,
            "elo": round(latest_elo),
            "win_rate": win_rate,
            "fav_units": fav_units,
            "match_count": len(stats)
        }

class LogMonitorApp:
    def __init__(self, page: ft.Page):
        self.page = page
        self.page.title = f"Broken Arrow 日志 查蛆指数 by Zola ({CURRENT_VERSION})"
        self.page.window.width = 1200
        self.page.window.height = 900
        self.page.theme_mode = ft.ThemeMode.DARK
        self.page.on_close = self.on_window_close
        
        self.state = GameState()
        self.running = True
        
        self.stats_manager = StatsCacheManager()
        self.mem_cache = {}
        self.loading_status = {}
        self.failed_cache = set()
        self.need_update = False
        
        self.thread_pool = ThreadPoolExecutor(max_workers=5)
        self.log_lock = threading.Lock()
        
        self.config_file = CONFIG_FILE
        self.log_folder = DEFAULT_STEAM_PATH
        self.client_id = str(uuid.uuid4()) # 默认生成

        # 加载配置
        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, "r", encoding="utf-8") as f:
                    config = json.load(f)
                    self.log_folder = config.get("log_folder_path", DEFAULT_STEAM_PATH)
                    saved_cid = config.get("client_id")
                    if saved_cid:
                        self.client_id = saved_cid
            except:
                pass
        
        self.save_config()
        self.build_ui()
        
        threading.Thread(target=lambda: UnitManager().load_units(lambda msg: self.log_message(msg, "SYSTEM")), daemon=True).start()
        
        self.re_lobby_enter = re.compile(r"Log: Enter to lobby \(id: (\d+)\)")
        self.re_incoming = re.compile(r"Incoming client (.*?):(\d+) to lobby")
        self.re_outgoing = re.compile(r"Outgoing client (.*?):(\d+) exit")
        self.re_lobby_exit = re.compile(r"Log: Exit lobby")
        self.re_game_start = re.compile(r"Log: Room entered - GameRoom")
        self.re_game_player = re.compile(r"ID: (\d+), Name: (.*?), Team: (Alpha|Bravo)")
        
        self.monitor_thread = threading.Thread(target=self.monitor_loop, daemon=True)
        self.monitor_thread.start()
        
        self.ui_updater_thread = threading.Thread(target=self.ui_updater_loop, daemon=True)
        self.ui_updater_thread.start()

        # === 启动心跳和更新检测 ===
        threading.Thread(target=self.start_heartbeat_loop, daemon=True).start()
        threading.Thread(target=self.check_update_worker, daemon=True).start()

    def save_config(self):
        try:
            with open(self.config_file, "w", encoding="utf-8") as f:
                json.dump({
                    "log_folder_path": self.log_folder,
                    "client_id": self.client_id
                }, f)
        except:
            pass

    # ================= 心跳 & 更新逻辑 =================
    def send_heartbeat(self):
        url = f"https://www.google-analytics.com/mp/collect?measurement_id={MEASUREMENT_ID}&api_secret={API_SECRET}"
        payload = {
            "client_id": self.client_id,
            "events": [{
                "name": "app_heartbeat",
                "params": {
                    "session_id": str(int(time.time())),
                    "engagement_time_msec": "100",
                    "app_version": CURRENT_VERSION
                }
            }]
        }
        try:
            requests.post(url, json=payload, timeout=5)
        except:
            pass

    def start_heartbeat_loop(self):
        while self.running:
            self.send_heartbeat()
            time.sleep(HEARTBEAT_INTERVAL) # <--- 使用 10 秒间隔

    def check_update_worker(self):
        """后台检测更新"""
        self.log_message("正在检查更新...", "SYSTEM")
        raw_url = f"https://raw.githubusercontent.com/{GITHUB_USER}/{GITHUB_REPO}/{GITHUB_BRANCH}/version.txt"
        release_page = f"https://github.com/{GITHUB_USER}/{GITHUB_REPO}/releases/latest"
        
        try:
            resp = requests.get(raw_url, timeout=10)
            if resp.status_code == 200:
                latest_version = resp.text.strip()
                if not latest_version.startswith("v"):
                    return
                
                if version.parse(latest_version) > version.parse(CURRENT_VERSION):
                    self.log_message(f"发现新版本: {latest_version}", "WARNING")
                    # 有更新：变绿，变文案
                    self.btn_update.text = f"更新: {latest_version}"
                    self.btn_update.bgcolor = ft.Colors.GREEN_600
                    self.btn_update.icon = ft.Icons.CLOUD_DOWNLOAD
                    self.btn_update.data = release_page # 存储下载链接
                    self.btn_update.update()
                    self.show_snack(f"发现新版本 {latest_version}！请点击上方绿色按钮下载。")
                else:
                    self.log_message(f"当前 {CURRENT_VERSION} 已是最新", "SYSTEM")
                    # 无更新：保持默认状态 (访问Github)
        except Exception as e:
            self.log_message(f"更新检查失败: {e}", "WARNING")

    # [修复点] 异步处理点击，确保网页能打开
    async def on_update_click(self, e):
        """点击更新/访问Github按钮"""
        target_url = self.btn_update.data
        if not target_url:
             # 如果没有更新，默认打开仓库主页
             target_url = f"https://github.com/{GITHUB_USER}/{GITHUB_REPO}"
        
        try:
            await self.page.launch_url(target_url)
        except Exception as ex:
            self.show_snack(f"打开网页失败: {ex}")

    # =================================================

    def on_window_close(self, e):
        self.running = False
        try:
            self.thread_pool.shutdown(wait=False, cancel_futures=True)
        except:
            pass

    def show_about_dialog(self, e=None):
        if hasattr(self, "_current_overlay") and self._current_overlay and self._current_overlay in self.page.overlay:
            return
        
        self.log_message("打开关于弹窗", "SYSTEM")

        # [修复点] 修复 padding.only 警告
        scroll_content = ft.Column([
            ft.Row([ft.Icon(ft.Icons.INFO_OUTLINE, size=18, color=ft.Colors.CYAN), ft.Text("软件说明", weight="bold", size=15)], spacing=5),
            ft.Container(
                content=ft.Column([
                    ft.Text("断箭日志查蛆指数 (Broken Arrow Maggot Index)", weight="bold", size=13),
                    ft.Text(f"版本: {CURRENT_VERSION} | 作者: Zola", size=11, color=ft.Colors.GREY_500),
                    ft.Text("使用指南：\n1. 启动软件 -> 2. 进游戏大厅 -> 3. 自动显示数据\n4. 点击玩家分数可跳转网页版。\n5. 点击玩家名可以复制简要信息。", size=12),
                ], spacing=2),
                padding=ft.Padding(left=10, top=0, right=0, bottom=0) # <--- 修复 padding
            ),
            ft.Divider(color=ft.Colors.WHITE_10), # <--- 修复 WHITE10
            ft.Row([ft.Icon(ft.Icons.CALCULATE_OUTLINED, size=18, color=ft.Colors.AMBER), ft.Text("软件揭秘", weight="bold", size=15)], spacing=5),
            ft.Container(
                content=ft.Column([
                    ft.Text("核心系统:", size=11, italic=True, color=ft.Colors.AMBER_200),
                    ft.Container(
                        content=ft.Text("通过读取公开的游戏日志获取用户id，并通过网页api进行查询和统计\n蛆指数=S型曲线系数 × 净贡献\n最大程度本地缓存数据减少api的使用率\n本地缓存数据采用滚动存储的方式，请勿手动删除会增加api负担", font_family="Consolas", size=12),
                        bgcolor=ft.Colors.BLACK_26, padding=8, border_radius=5
                    ),
                    ft.Text("使用了两个网站的数据：（请支持这两个网站）", size=12),
                    ft.Row([
                        ft.Text("👑 https://barmory.net/", color="#f87171", size=11),
                        ft.Text("👑 https://dash.aoeiaol.top", color="#94a3b8", size=11)
                    ], spacing=10),
                ], spacing=5),
                padding=ft.Padding(left=10, top=0, right=0, bottom=0) # <--- 修复 padding
            ),
            ft.Divider(color=ft.Colors.WHITE_10), # <--- 修复 WHITE10
            ft.Row([ft.Icon(ft.Icons.HELP_OUTLINE, size=18, color=ft.Colors.GREEN), ft.Text("常见问题 (FAQ)", weight="bold", size=15)], spacing=5),
            ft.Column([
                ft.ExpansionTile(
                    title=ft.Text("Q: 本工具收费吗？", size=12),
                    controls=[ft.Text("A: 本工具完全免费并且开源，不收取任何费用。", size=11, color=ft.Colors.GREY_400)],
                    min_tile_height=30
                ),
                ft.ExpansionTile(
                    title=ft.Text("Q: 本工具是作弊吗？", size=12),
                    controls=[ft.Text("A: 本工具只本地读取了游戏的log，这是公开数据，并通过公开的战绩统计得到结果。", size=11, color=ft.Colors.GREY_400)],
                    min_tile_height=30
                ),
                ft.ExpansionTile(
                    title=ft.Text("Q: 显示的单位为什么不对应，比如马润预备役？", size=12),
                    controls=[ft.Text("A: 只显示了单位的非升级状态的名称。", size=11, color=ft.Colors.GREY_400)],
                    min_tile_height=30
                ),
                ft.ExpansionTile(
                    title=ft.Text("Q: 为什么显示大厅没有人？", size=12),
                    controls=[ft.Text("A: 日志只能记录到在你之后加入大厅的人。", size=11, color=ft.Colors.GREY_400)],
                    min_tile_height=30
                ),
            ], spacing=0)
        ], scroll=ft.ScrollMode.AUTO, spacing=15, expand=True)

        dialog_card = ft.Container(
            content=ft.Column([
                ft.Row([
                    ft.Text("关于本软件", size=18, weight="bold"),
                    ft.IconButton(ft.Icons.CLOSE, on_click=self.close_about_dialog, tooltip="关闭")
                ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
                ft.Divider(height=1),
                ft.Container(content=scroll_content, expand=True)
            ]),
            width=500, height=600, bgcolor=ft.Colors.SURFACE, border_radius=15, padding=20,
            shadow=ft.BoxShadow(spread_radius=2, blur_radius=20, color=ft.Colors.with_opacity(0.6, ft.Colors.BLACK)),
            on_click=lambda e: None 
        )

        self._current_overlay = ft.Container(
            content=dialog_card,
            alignment=ft.Alignment(0, 0), 
            bgcolor=ft.Colors.with_opacity(0.7, ft.Colors.BLACK),
            blur=ft.Blur(8, 8),
            on_click=self.close_about_dialog,
            expand=True,
        )

        self.page.overlay.append(self._current_overlay)
        self.page.update()

    def close_about_dialog(self, e=None):
        if hasattr(self, "_current_overlay") and self._current_overlay:
            if self._current_overlay in self.page.overlay:
                self.page.overlay.remove(self._current_overlay)
                self.page.update()
                self._current_overlay = None

    def build_ui(self):
        self.txt_folder_path = ft.TextField(value=self.log_folder, label="日志路径", expand=True, text_size=12)
        self.btn_save = ft.FilledButton("保存", icon=ft.Icons.SAVE, on_click=self.on_save_path)
        
        path_hint = ft.Text(
            "提示：Broken Arrow multiplayer 日志默认位于 Steam 安装目录下 \\steamapps\\common\\broken_arrow\\GameLogs\n"
            "仅 multiplayer 模式会生成 Gamelog__*.log 文件，请确保路径正确",
            size=11, color=ft.Colors.AMBER_300, italic=True
        )
        
        about_btn = ft.IconButton(icon=ft.Icons.INFO, tooltip="关于/说明", on_click=self.show_about_dialog)
        
        # === [修改点] 更新按钮 (默认显示访问Github) ===
        self.btn_update = ft.ElevatedButton(
            "访问 Github", # 默认文案
            icon=ft.Icons.CODE, 
            bgcolor=ft.Colors.BLUE_800, # 默认颜色
            color=ft.Colors.WHITE,
            visible=True, # 常驻显示
            on_click=self.on_update_click # 绑定异步点击事件
        )
        # 初始化 data 为 None, 点击时跳转主页
        self.btn_update.data = None 
        
        self.lv_lobby = ft.ListView(expand=True, spacing=8, padding=10)
        
        self.col_lobby = ft.Column([
            ft.Row([
                ft.Icon(ft.Icons.MEETING_ROOM),
                ft.Text("大厅 (Lobby)", size=20, weight="bold"),
                ft.Container(expand=True),
                ft.IconButton(
                    icon=ft.Icons.COPY,
                    tooltip="复制所有玩家信息(极简)",
                    on_click=lambda _: self.copy_player_data("lobby")
                )
            ]),
            ft.Container(self.lv_lobby, bgcolor=ft.Colors.GREY_900, border_radius=10, expand=True)
        ], visible=True, expand=True)
        
        self.lv_alpha = ft.Column(spacing=5)
        self.lv_bravo = ft.Column(spacing=5)
        
        self.col_game = ft.Column([
            ft.Row([ft.Icon(ft.Icons.GAMES), ft.Text("战斗中", size=20, weight="bold", color=ft.Colors.RED_400)]),
            ft.Row([
                ft.Container(ft.Column([
                    ft.Row([
                        ft.Container(ft.Text("ALPHA", weight="bold"), bgcolor=ft.Colors.RED_900, padding=5, border_radius=5),
                        ft.Container(expand=True),
                        ft.IconButton(ft.Icons.COPY, icon_size=18, tooltip="复制A队信息(极简)", on_click=lambda _: self.copy_player_data("game", "Alpha"))
                    ]),
                    self.lv_alpha
                ]), expand=True, bgcolor=ft.Colors.BLACK_26, padding=5, border_radius=10),
                
                ft.Container(ft.Column([
                    ft.Row([
                        ft.Container(ft.Text("BRAVO", weight="bold"), bgcolor=ft.Colors.BLUE_900, padding=5, border_radius=5),
                        ft.Container(expand=True),
                        ft.IconButton(ft.Icons.COPY, icon_size=18, tooltip="复制B队信息(极简)", on_click=lambda _: self.copy_player_data("game", "Bravo"))
                    ]),
                    self.lv_bravo
                ]), expand=True, bgcolor=ft.Colors.BLACK_26, padding=5, border_radius=10)
            ], expand=True)
        ], visible=False, expand=True)
        
        self.txt_status = ft.Text("初始化...", color=ft.Colors.CYAN)
        self.txt_file = ft.Text("", size=12, color=ft.Colors.GREY_500)
        
        # [修改] 日志区域配置，确保自动滚动
        self.log_container = ft.ListView(expand=True, auto_scroll=True, spacing=2)
        
        # [修改] 关键修复：给容器设置固定高度，使其出现内部滚轮
        self.log_scroll = ft.Container(
            content=self.log_container,
            bgcolor=ft.Colors.BLACK,
            padding=10,
            border_radius=8,
            height=300, # <--- 限制高度，使ListView能够处理滚动逻辑
            # expand=True <--- 移除 expand，避免在 ExpansionTile 中无限撑开
        )
        
        self.exp_logs = ft.ExpansionTile(
            title=ft.Text("运行日志", size=12, color=ft.Colors.GREY_400),
            expanded=False,
            controls=[self.log_scroll]
        )
        
        self.page.controls.append(ft.Container(ft.Column([
            ft.Row([self.txt_folder_path, self.btn_save, self.btn_update, about_btn]), # 更新按钮
            path_hint,
            ft.Divider(),
            self.col_lobby,
            self.col_game,
            ft.Divider(),
            ft.Row([self.txt_status, self.txt_file], alignment="space_between"),
            self.exp_logs
        ]), padding=20, expand=True))
        
        self.page.update()

    def show_snack(self, message):
        snack = ft.SnackBar(ft.Text(message))
        self.page.overlay.append(snack)
        snack.open = True
        self.page.update()

    def _copy_to_clipboard(self, text, success_msg="复制成功"):
        try:
            self.page.set_clipboard(text)
            self.show_snack(f"{success_msg} (Flet)")
        except:
            try:
                subprocess.run(['clip'], input=text.strip().encode('gbk', errors='ignore'), check=True)
                self.show_snack(f"{success_msg} (系统命令)")
            except Exception as e:
                self.show_snack(f"系统复制失败: {e}")

    def copy_single_player_info(self, uid, name):
        stats = self.mem_cache.get(uid) or self.stats_manager.get(uid)
        if stats and isinstance(stats, dict) and "elo" in stats:
            elo = stats.get('elo', 0)
            win_rate = stats.get('win_rate', 0)
            score = stats.get('score', 0)
            fav_units = stats.get('fav_units', [])
            
            seen_units = set()
            unique_unit_names = []
            for u in fav_units:
                u_name = u['name']
                if u_name not in seen_units:
                    seen_units.add(u_name)
                    unique_unit_names.append(u_name)
            units_str = ",".join(unique_unit_names) if unique_unit_names else "无数据"
            text = f"{name} ELO:{elo} WR-12G:{win_rate}% maggot:{score} Love:{units_str}"
            self._copy_to_clipboard(text, f"已复制 {name} 的详细信息")
        else:
            self.show_snack(f"尚未获取到 {name} 的详细数据")

    def copy_player_data(self, source_type, team_key=None):
        players = []
        if source_type == "lobby":
            players = [{"id": k, "name": v} for k, v in self.state.lobby_players.items()]
        elif source_type == "game" and team_key:
            players = self.state.game_teams.get(team_key, [])
        if not players:
            self.show_snack("当前列表没有玩家数据")
            return
        
        clipboard_lines = []
        for p in players:
            uid = str(p['id'])
            name = p['name']
            stats = self.mem_cache.get(uid) or self.stats_manager.get(uid)
            
            if stats and isinstance(stats, dict) and "elo" in stats:
                elo = stats.get('elo', 0)
                line_info = f"【{name}: {elo}】"
            elif uid in self.loading_status:
                line_info = f"【{name}: Loading】"
            elif uid in self.failed_cache:
                line_info = f"【{name}: Err】"
            else:
                line_info = f"【{name}: Wait】"
            
            clipboard_lines.append(line_info)
        
        full_text = "".join(clipboard_lines)
        self._copy_to_clipboard(full_text, f"已复制 {len(players)} 条简略信息")

    def log_message(self, msg, level="INFO"):
        try:
            with self.log_lock:
                ts = datetime.now().strftime("%H:%M:%S")
                color = {
                    "INFO": ft.Colors.GREEN_400,
                    "WARNING": ft.Colors.AMBER_300,
                    "ERROR": ft.Colors.RED_400,
                    "SYSTEM": ft.Colors.CYAN_400
                }.get(level, ft.Colors.GREEN_400)
                
                line = ft.Row([
                    ft.Text(f"[{ts}] ", size=10, color=ft.Colors.GREY_500),
                    ft.Text(msg, size=10, color=color)
                ])
                
                self.log_container.controls.append(line)
                if len(self.log_container.controls) > 500:
                    self.log_container.controls.pop(0)
                
                self.log_container.update()
                self.log_scroll.update()
        except:
            pass

    def on_save_path(self, e):
        path = self.txt_folder_path.value.strip()
        if path:
            self.log_folder = path
            self.save_config() # 更新路径同时保存 Client ID
            self.state.current_file = None
            self.state.status = "路径更新..."
            self.log_message("日志路径已保存，重启监控", "SYSTEM")
            self.update_ui()

    def update_player_progress(self, uid, progress, msg):
        self.loading_status[uid] = {"progress": progress, "msg": msg, "start_time": time.time()}
        self.need_update = True

    def fetch_player_stats(self, uid):
        try:
            cached = self.stats_manager.get(uid)
            if cached:
                self.mem_cache[uid] = cached
                if uid in self.loading_status:
                    del self.loading_status[uid]
                self.log_message(f"[{uid}] 命中本地缓存", "INFO")
                self.need_update = True
                return
            
            def on_log(msg):
                self.log_message(msg, "INFO")
            def on_prog(u, p, s):
                self.update_player_progress(u, p, s)
            
            res = Analyzer.analyze_player(uid, log_cb=on_log, progress_cb=on_prog)
            self.mem_cache[uid] = res
            if "error" not in res:
                self.stats_manager.set(uid, res)
                self.log_message(f"[{uid}] 分析完成", "SYSTEM")
            else:
                self.failed_cache.add(uid)
                self.log_message(f"[{uid}] {res.get('error','未知错误')}", "ERROR")
        except Exception as e:
            self.mem_cache[uid] = {"error": f"系统异常: {str(e)}"}
            self.failed_cache.add(uid)
            self.log_message(f"[{uid}] 异常: {str(e)}", "ERROR")
        finally:
            if uid in self.loading_status:
                del self.loading_status[uid]
            self.need_update = True

    def get_player_card(self, uid, name):
        if uid in self.loading_status:
            start_time = self.loading_status[uid].get("start_time", 0)
            if time.time() - start_time > 30:
                del self.loading_status[uid]
                self.failed_cache.add(uid)
                self.log_message(f"[{uid}] 超时强制终止", "WARNING")
        
        should_fetch = uid not in self.mem_cache and uid not in self.loading_status and uid not in self.failed_cache
        
        if should_fetch:
            disk_data = self.stats_manager.get(uid)
            if disk_data:
                self.mem_cache[uid] = disk_data
            else:
                self.loading_status[uid] = {"progress": 0.0, "msg": "排队中...", "start_time": time.time()}
                self.thread_pool.submit(self.fetch_player_stats, uid)
        
        stats = self.mem_cache.get(uid)
        loading_info = self.loading_status.get(uid)
        
        name_col = ft.Container(
            content=ft.Column([
                ft.Text(name, weight="bold", size=16, overflow=ft.TextOverflow.ELLIPSIS),
                ft.Text(f"ID: {uid}", size=10, color=ft.Colors.GREY_500, font_family="Consolas"),
            ], spacing=2, width=140),
            on_click=lambda _: self.copy_single_player_info(uid, name),
            tooltip="点击复制详细信息",
            border_radius=4,
            padding=2,
            ink=True
        )
        
        async def open_maggot_web(e):
            try:
                await self.page.launch_url(f"https://zawinzala.github.io/Broken-Arrow-Maggot/?steamId={uid}")
            except Exception as ex:
                self.show_snack(f"打开网页失败: {ex}")

        content_area = None
        
        if loading_info:
            content_area = ft.Column([
                ft.ProgressBar(value=loading_info["progress"], width=200, color=ft.Colors.CYAN, bgcolor=ft.Colors.GREY_800),
                ft.Text(loading_info["msg"], size=10, color=ft.Colors.CYAN_200)
            ], alignment="center", spacing=2)
            
        elif uid in self.failed_cache:
            content_area = ft.Row([
                ft.Text("获取失败", color=ft.Colors.RED_400, size=12),
                ft.IconButton(ft.Icons.REFRESH, icon_size=16, on_click=lambda _: self.retry_fetch(uid))
            ])
            
        elif isinstance(stats, dict) and "error" in stats:
            content_area = ft.Text(stats["error"], color=ft.Colors.RED_400, size=12)
            
        elif isinstance(stats, dict):
            score = stats['score']
            if score <= 2.0:
                text_col = '#fbbf24'; border_col = '#78350f'
            elif score <= 4.0:
                text_col = '#4ade80'; border_col = '#14532d'
            elif score <= 6.0:
                text_col = '#94a3b8'; border_col = '#334155'
            elif score <= 8.0:
                text_col = '#fb923c'; border_col = '#7c2d12'
            else:
                text_col = '#f87171'; border_col = '#7f1d1d'
            
            score_badge = ft.Container(
                content=ft.Column([
                    ft.Text(str(score), size=20, weight="bold", color=text_col),
                    ft.Text(stats['label'], size=9, color=ft.Colors.WHITE_54, text_align="center")
                ], alignment="center", spacing=0),
                bgcolor=ft.Colors.GREY_900,
                border=ft.Border.all(1, border_col),
                width=65, height=50, border_radius=8, padding=2,
                on_click=open_maggot_web, 
                tooltip="点击打开网页版蛆指数"
            )
            
            medals_row = ft.Row(spacing=4)
            for m in stats['tags']:
                medals_row.controls.append(ft.Container(
                    content=ft.Row([ft.Text(m['icon'], size=12), ft.Text(m['name'], size=10, color=m['color'])], spacing=2),
                    bgcolor=ft.Colors.with_opacity(0.1, m['color']),
                    border=ft.Border.all(1, ft.Colors.with_opacity(0.3, m['color'])),
                    padding=ft.Padding.symmetric(horizontal=4, vertical=2), border_radius=4,
                    tooltip=m['name']
                ))
            
            if stats['elo'] > 0:
                win_rate = stats.get('win_rate', 0)
                wr_color = '#4ade80' if win_rate >= 50 else '#f87171'
                medals_row.controls.insert(0, ft.Container(
                    content=ft.Row([
                        ft.Text(f"ELO {stats['elo']}", size=10, weight="bold", color='#a78bfa'),
                        ft.Text(f"{win_rate}% Win", size=10, weight="bold", color=wr_color)
                    ], spacing=4),
                    bgcolor='#4c1d95', padding=4, border_radius=4
                ))
            
            units_col = ft.Column(spacing=2)
            for u in stats['fav_units']:
                units_col.controls.append(ft.Row([
                    ft.Text(u['type'], size=10),
                    ft.Text(u['name'], size=10, color=u['color'], width=100, no_wrap=True, overflow=ft.TextOverflow.ELLIPSIS),
                    ft.Text(str(u['val']), size=10, color=ft.Colors.GREY_400)
                ], spacing=4))
            
            info_col = ft.Column([medals_row, units_col], spacing=3)
            content_area = ft.Row([score_badge, info_col], alignment="start", vertical_alignment="start")
        
        return ft.Container(
            content=ft.Row([ft.Icon(ft.Icons.PERSON, color=ft.Colors.BLUE_200), name_col, ft.VerticalDivider(width=1, color=ft.Colors.WHITE_10), content_area if content_area else ft.Container()], alignment="start"),
            bgcolor=ft.Colors.WHITE_10, padding=8, border_radius=8, border=ft.Border.all(1, ft.Colors.WHITE_12) # <--- 修复 WHITE10
        )

    def retry_fetch(self, uid):
        if uid in self.failed_cache:
            self.failed_cache.remove(uid)
        if uid in self.mem_cache:
            del self.mem_cache[uid]
        self.need_update = True
        self.log_message(f"[{uid}] 手动重试", "INFO")

    def update_ui(self):
        if not self.running:
            return
        
        self.txt_status.value = f"状态: {self.state.status}"
        self.txt_file.value = os.path.basename(self.state.current_file) if self.state.current_file else ""
        
        if self.state.in_game:
            self.col_lobby.visible = False
            self.col_game.visible = True
            
            alpha_controls = [self.get_player_card(p['id'], p['name']) for p in self.state.game_teams["Alpha"]]
            self.lv_alpha.controls = alpha_controls
            bravo_controls = [self.get_player_card(p['id'], p['name']) for p in self.state.game_teams["Bravo"]]
            self.lv_bravo.controls = bravo_controls
        else:
            self.col_lobby.visible = True
            self.col_game.visible = False
            lobby_controls = [self.get_player_card(uid, name) for uid, name in self.state.lobby_players.items()]
            self.lv_lobby.controls = lobby_controls
        
        self.page.update()

    def find_latest_log(self):
        if not self.log_folder or not os.path.exists(self.log_folder):
            return None
        try:
            files = glob.glob(os.path.join(self.log_folder, "Gamelog__*.log"))
            return max(files, key=os.path.getmtime) if files else None
        except:
            return None

    def process_line(self, line):
        line = line.strip()
        if not line:
            return
        
        if self.re_lobby_enter.search(line):
            self.state.reset_lobby()
            self.state.status = "进入大厅"
            self.log_message("检测到进入大厅", "SYSTEM")
            return
        
        m = self.re_incoming.search(line)
        if m:
            name, uid = m.group(1), m.group(2)
            self.state.lobby_players[uid] = name
            self.log_message(f"玩家加入: {name} ({uid})", "INFO")
            return
        
        m = self.re_outgoing.search(line)
        if m and m.group(2) in self.state.lobby_players:
            uid = m.group(2)
            name = self.state.lobby_players.get(uid, "未知")
            del self.state.lobby_players[uid]
            self.log_message(f"玩家离开: {name} ({uid})", "INFO")
            return
        
        if self.re_lobby_exit.search(line):
            self.state.reset_all()
            self.log_message("退出大厅", "SYSTEM")
            return
        
        if self.re_game_start.search(line):
            self.state.in_game = True
            self.state.game_teams = {"Alpha": [], "Bravo": []}
            self.state.status = "加载中..."
            self.log_message("进入对局房间", "SYSTEM")
            return
        
        m = self.re_game_player.search(line)
        if m and self.state.in_game:
            uid, name, team = m.groups()
            if uid not in [p['id'] for p in self.state.game_teams[team]]:
                self.state.game_teams[team].append({"id": uid, "name": name})
                self.state.status = "战斗中"
                self.log_message(f"{team} 队伍加入: {name} ({uid})", "INFO")

    def ui_updater_loop(self):
        while self.running:
            if self.need_update or self.loading_status:
                self.update_ui()
                self.need_update = False
            time.sleep(0.3)

    def monitor_loop(self):
        last_check = 0
        while self.running:
            latest = self.find_latest_log()
            if not latest:
                self.state.status = "未找到日志文件"
                self.need_update = True
                time.sleep(2)
                continue
            
            if self.state.current_file != latest:
                self.state.current_file = latest
                self.state.reset_all()
                self.need_update = True
                self.log_message(f"检测到新日志文件: {os.path.basename(latest)}", "SYSTEM")
                try:
                    with open(latest, 'r', encoding='utf-8', errors='ignore') as f:
                        for line in f.readlines():
                            self.process_line(line)
                        self.need_update = True
                        f.seek(0, 2)
                        while self.running:
                            if time.time() - last_check > 5:
                                last_check = time.time()
                                if self.find_latest_log() != latest:
                                    break
                            line = f.readline()
                            if line:
                                self.process_line(line)
                                self.need_update = True
                            else:
                                time.sleep(0.1)
                except Exception as e:
                    self.state.status = f"读取错误: {e}"
                    self.log_message(f"日志读取异常: {e}", "ERROR")
                    self.need_update = True
                    time.sleep(2)
            else:
                time.sleep(2)

def main(page: ft.Page):
    app = LogMonitorApp(page)
    page.update()
    
    async def safe_startup_popup():
        await asyncio.sleep(0.5)
        app.show_about_dialog()
    
    page.run_task(safe_startup_popup)

if __name__ == "__main__":
    ft.run(main)
