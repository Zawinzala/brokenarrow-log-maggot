import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox, filedialog, simpledialog
import os
import glob
import re
import json
import requests
import hashlib
import binascii
import threading
import math
import time
import zipfile
import subprocess
import webbrowser
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
import queue

# 需要安装: pip install requests pycryptodome
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

# ================= 版本配置 =================
CURRENT_VERSION = 'v2.1.0'  # 包含勋章列与ELO快速更新

# ================= 解密配置 =================
SECRET_KEY_STR = '0f5007f22e44207cebdb44da652d7daaa52768c3522eeef19c04b28680fd4f65'
key_hash = hashlib.sha256(SECRET_KEY_STR.encode('utf-8')).digest()
aes_key = key_hash[:32]

def decrypt_match(encrypted_text):
    try:
        if ':' not in encrypted_text:
            return None
        iv_hex, ciphertext_hex = encrypted_text.strip().split(':')
        iv = binascii.unhexlify(iv_hex)
        ciphertext = binascii.unhexlify(ciphertext_hex)
        cipher = AES.new(aes_key, AES.MODE_CBC, iv)
        decrypted_padded = cipher.decrypt(ciphertext)
        decrypted_data = unpad(decrypted_padded, AES.block_size)
        return json.loads(decrypted_data.decode('utf-8'))
    except Exception as e:
        return None

# ================= 单位管理 =================
class UnitManager:
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(UnitManager, cls).__new__(cls)
            cls._instance.units = {}
            cls._instance.loaded = False
        return cls._instance
    
    def load_units(self):
        if self.loaded:
            return
        
        UNIT_API_URL = "https://batrace.aoeiaol.top/api/v1/Units"
        UNIT_DB_FILE = "units_db.json"
        UNIT_EXPIRY = 24 * 3600
        
        if os.path.exists(UNIT_DB_FILE):
            if time.time() - os.path.getmtime(UNIT_DB_FILE) < UNIT_EXPIRY:
                try:
                    with open(UNIT_DB_FILE, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        for u in data:
                            uid = str(u.get('Id') or u.get('id'))
                            name = u.get('Name') or u.get('name')
                            if uid and name:
                                self.units[uid] = name
                    self.loaded = True
                    return
                except:
                    pass
        
        try:
            req = requests.get(UNIT_API_URL, headers={'User-Agent': 'Mozilla/5.0'}, timeout=10)
            if req.status_code == 200:
                data = req.json()
                for u in data:
                    uid = str(u.get('Id') or u.get('id'))
                    name = u.get('Name') or u.get('name')
                    if uid and name:
                        self.units[uid] = name
                with open(UNIT_DB_FILE, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False)
                self.loaded = True
        except:
            pass
    
    def get_name(self, uid):
        return self.units.get(str(uid), f"未知单位 {uid}")

# ================= 勋章配置 =================
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

# ================= 核心计算 =================
def calculate_maggot_index(my_stbid, matches):
    my_uid = str(my_stbid)
    um = UnitManager()
    um.load_units()
    
    stats = []
    medal_counts = {}
    agg_units = {}
    wins = 0
    
    for m in matches:
        decrypted = m
        players_data = decrypted.get('Data', {})
        
        if not players_data:
            continue
        
        players = []
        for pid, p_data in players_data.items():
            p_info = p_data.copy()
            p_info['Id'] = str(pid)
            raw_tid = p_info.get('TeamId')
            p_info['TeamId'] = 1 if raw_tid == 1 else 0
            players.append(p_info)
        
        my_p = next((p for p in players if p['Id'] == my_uid), None)
        if not my_p:
            continue
        
        my_team_id = my_p['TeamId']
        
        winner_team = decrypted.get('WinnerTeam')
        if winner_team is None or winner_team > 1:
            t0_delta = sum(((p.get('NewRating') or 0) - (p.get('OldRating') or 0)) for p in players if p['TeamId'] == 0)
            t1_delta = sum(((p.get('NewRating') or 0) - (p.get('OldRating') or 0)) for p in players if p['TeamId'] == 1)
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
            k = p.get('DestructionScore', 0) or 0
            l = p.get('LossesScore', 0) or 0
            o = p.get('ObjectivesCaptured', 0) or 0
            return (k - l) / 1000.0 + o
        
        ally_sorted = sorted(ally, key=calc_score, reverse=True)
        try:
            my_rank_idx = next(i for i, p in enumerate(ally_sorted) if p['Id'] == my_uid)
            my_rank = my_rank_idx + 1
        except:
            my_rank = 5
        
        stats.append({'rank': my_rank, 'elo': my_p.get('NewRating', 0) or 0})
        
        if 'UnitData' in my_p and my_p['UnitData']:
            for u in my_p['UnitData'].values():
                uid = str(u.get('Id'))
                if uid not in agg_units:
                    agg_units[uid] = {'d': 0, 'k': 0, 't': 0}
                agg_units[uid]['d'] += u.get('TotalDamageDealt', 0) or 0
                agg_units[uid]['k'] += u.get('KilledCount', 0) or 0
                agg_units[uid]['t'] += u.get('TotalDamageReceived', 0) or 0
    
    if not stats:
        return {"error": "无有效数据"}
    
    avg_rank = sum(s['rank'] for s in stats) / len(stats)
    normalized_rank = (avg_rank - 1) / 4.0
    s_curve_val = (1 - math.cos(normalized_rank * math.pi)) / 2.0
    maggot_score = round(1 + (s_curve_val * 9), 1)
    
    levels = ["👑 神", "🦁 团队支柱", "😐 平平淡淡", "🐛 有点蛆", "💩 蛆！"]
    label_idx = 0
    if maggot_score > 8: label_idx = 4
    elif maggot_score > 6: label_idx = 3
    elif maggot_score > 4: label_idx = 2
    elif maggot_score > 2: label_idx = 1
    
    sorted_medals = sorted(medal_counts.items(), key=lambda x: x[1], reverse=True)[:2]
    final_tags = []
    for key, count in sorted_medals:
        conf = next((c for c in MEDAL_CONFIG if c['key'] == key), None)
        if conf:
            final_tags.append(conf)
    
    fav_units = []
    if agg_units:
        try:
            top_d = max(agg_units.items(), key=lambda x: x[1]['d'])
            fav_units.append({'type': '⚡', 'val': int(top_d[1]['d']), 'name': um.get_name(top_d[0]), 'desc': '最高输出'})
            
            top_k = max(agg_units.items(), key=lambda x: x[1]['k'])
            fav_units.append({'type': '🔫', 'val': int(top_k[1]['k']), 'name': um.get_name(top_k[0]), 'desc': '最高击杀'})
            
            top_t = max(agg_units.items(), key=lambda x: x[1]['t'])
            fav_units.append({'type': '🛡️', 'val': int(top_t[1]['t']), 'name': um.get_name(top_t[0]), 'desc': '最高承伤'})
        except:
            pass
    
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

# ================= 日志解析状态 =================
class GameState:
    def __init__(self):
        self.lobby_players = {}
        self.game_teams = {"Alpha": [], "Bravo": []}
        self.all_game_players = []
        self.in_game = False
        self.local_name = None

re_lobby_enter = re.compile(r"Log: Enter to lobby \(id: \d+\)")
re_incoming = re.compile(r"Incoming client (.*?):(\d+) to lobby")
re_outgoing = re.compile(r"Outgoing client (.*?):(\d+) exit")
re_lobby_exit = re.compile(r"Log: Exit lobby")
re_game_start = re.compile(r"Log: Room entered - GameRoom")
re_game_player = re.compile(r"ID: (\d+), Name: (.*?), Team: (Alpha|Bravo)")
re_room_client = re.compile(r"Room: \(GameRoom\|\d+\), Client: \(([^|]+)\|(\d+)\)")
re_persona = re.compile(r"GetPersonaName\s+(.+)")

def process_log_line(line, state):
    line = line.strip()
    if not line:
        return
    
    m = re_persona.search(line)
    if m:
        state.local_name = m.group(1).strip()
    
    if re_lobby_enter.search(line):
        state.lobby_players.clear()
        state.game_teams = {"Alpha": [], "Bravo": []}
        state.all_game_players.clear()
        state.in_game = False
    
    m = re_incoming.search(line)
    if m:
        name, uid = m.group(1).strip(), m.group(2)
        state.lobby_players.pop(uid, None)
        state.lobby_players[uid] = name
    
    m = re_outgoing.search(line)
    if m:
        uid = m.group(2)
        state.lobby_players.pop(uid, None)
    
    if re_lobby_exit.search(line):
        state.lobby_players.clear()
        state.game_teams = {"Alpha": [], "Bravo": []}
        state.all_game_players.clear()
        state.in_game = False
    
    if re_game_start.search(line):
        state.in_game = True
        state.game_teams = {"Alpha": [], "Bravo": []}
        state.all_game_players.clear()
    
    m = re_game_player.search(line)
    if m and state.in_game:
        uid, name, team = m.group(1), m.group(2).strip(), m.group(3)
        if not any(p['id'] == uid for p in state.game_teams[team]):
            state.game_teams[team].append({"id": uid, "name": name})
    
    m = re_room_client.search(line)
    if m and state.in_game:
        name, uid = m.group(1).strip(), m.group(2)
        if not any(p['id'] == uid for p in state.all_game_players):
            state.all_game_players.append({"id": uid, "name": name})

# ================= 单个玩家查询 (修改版：支持ELO快速更新) =================
player_data_cache = {}

def query_single_player(stbid, queue_put, quick_update_func=None):
    def sys_log(msg):
        ui_queue.put(("sys_log", f"[{stbid}] {msg}\n"))

    try:
        sys_log(f"开始查询玩家信息...")
        queue_put(f"正在查询 {stbid} ...\n")
        
        info_resp = requests.get(f"https://app.batrace.top/api/players/info?stbid={stbid}", timeout=20)
        
        if info_resp.status_code != 200:
            err_msg = f"  [{stbid}] 获取失败 (HTTP {info_resp.status_code})\n\n"
            sys_log(err_msg.strip())
            queue_put(err_msg)
            return None
        
        info = info_resp.json()
        player_info = info.get("info")
        if not player_info:
            sys_log("未找到玩家基本信息")
            queue_put(f"  [{stbid}] 未找到玩家\n\n")
            return None
        
        name = player_info.get("name") or "未知玩家"
        current_elo = player_info.get("rating") or 0
        sys_log(f"玩家: {name}, 当前ELO: {current_elo}")

        # === 核心修改：如果提供了回调，立即通知UI更新ELO ===
        if quick_update_func:
            quick_update_func(stbid, current_elo)
        
        fight_ids = info.get("last_fights_data", [])
        sys_log(f"获取到近期对局ID数: {len(fight_ids)}")
        
        if not fight_ids:
            queue_put(f"  {name} ({stbid}) - 无近期对局记录\n\n")
            return None
        
        valid_matches = []
        sys_log(f"开始筛选最近60场中的有效对局...")
        
        for i, fid in enumerate(fight_ids[:60]):
            if len(valid_matches) >= 12:
                break
            
            try:
                match_resp = requests.get(f"https://app.batrace.top/api/match?matchid={fid}", timeout=20)
                if match_resp.status_code != 200:
                    continue
                
                data = match_resp.json()
                encrypted = data.get("matchInfo")
                if not encrypted:
                    continue
                
                decrypted = decrypt_match(encrypted)
                if not decrypted:
                    continue
                
                players_data = decrypted.get('Data', {})
                if not players_data or len(players_data) < 10:
                    continue
                
                has_elo_change = False
                for p_data in players_data.values():
                    old = p_data.get('OldRating')
                    new = p_data.get('NewRating')
                    if old is not None and new is not None and abs(new - old) > 0.01:
                        has_elo_change = True
                        break
                
                if has_elo_change:
                    valid_matches.append(decrypted)

            except Exception as e:
                pass
        
        sys_log(f"有效对局筛选完成，共 {len(valid_matches)} 场")
        
        if len(valid_matches) < 12:
            msg = f"有效排位不足12局 (仅{len(valid_matches)}局)"
            sys_log(msg)
            queue_put(f"  {name} ({stbid}) - {msg}，无法准确计算\n\n")
            return None
        
        final_matches = valid_matches[:12]
        result = calculate_maggot_index(stbid, final_matches)
        
        if "error" in result:
            sys_log(f"计算过程返回错误: {result['error']}")
            queue_put(f"  {name} ({stbid}) - 计算错误: {result['error']}\n\n")
            return None
        
        result["name"] = name
        
        tags_str = " ".join([f"{t['icon']}{t['name']}" for t in result['tags']]) if result['tags'] else "无"
        units_str = " | ".join([f"{u['type']}{u['name']}({u['val']})" for u in result['fav_units']]) if result['fav_units'] else "无数据"
        
        log_summary = f"计算成功: Score={result['score']}, Label={result['label']}"
        sys_log(log_summary)
        
        queue_put(f"  {name} ({stbid})\n")
        queue_put(f"    蛆指数: {result['score']} —— {result['label']}\n")
        queue_put(f"    最近{result['match_count']}局胜率: {result['win_rate']}%\n")
        queue_put(f"    最新ELO: {result['elo']}\n")
        queue_put(f"    常见勋章: {tags_str}\n")
        queue_put(f"    最爱单位: {units_str}\n\n")
        
        return result 
        
    except Exception as e:
        err = f"查询过程发生未捕获异常: {str(e)}"
        sys_log(err)
        queue_put(f"  [{stbid}] 查询异常: {str(e)}\n\n")
        return None

# ================= UI 主程序 =================
root = tk.Tk()
root.title(f"Broken Arrow 蛆工具 by Zola {CURRENT_VERSION}") 
root.geometry("1100x750") 

# ================= 更新检查功能 =================
def check_update():
    try:
        url = "https://raw.githubusercontent.com/Zawinzala/brokenarrow-log-maggot/main/version.txt"
        resp = requests.get(url, timeout=5)
        
        if resp.status_code != 200:
            ui_queue.put(("sys_log", f"更新检查失败: HTTP {resp.status_code}\n"))
            return

        content = resp.text.strip().split('\n')
        remote_version = content[0].strip() if len(content) > 0 else "0.0.0"
        
        update_note = ""
        if len(content) > 1:
            update_note = "\n".join(content[1:])
        
        ui_queue.put(("sys_log", f"检查更新: 本地={CURRENT_VERSION}, 远程={remote_version}\n"))

        def parse_ver(v_str):
            clean = v_str.lower().replace('v', '')
            try:
                return tuple(map(int, clean.split('.')))
            except:
                return (0, 0, 0)

        if parse_ver(remote_version) > parse_ver(CURRENT_VERSION):
            def show_update_dialog():
                msg = f"发现新版本: {remote_version}\n当前版本: {CURRENT_VERSION}\n"
                if update_note:
                    msg += f"\n[更新内容]:\n{update_note}"
                else:
                    msg += "\n(暂无更新说明)"
                
                choice = messagebox.askokcancel("发现新版本", msg, icon='info')
                
                if choice: 
                    webbrowser.open("https://github.com/Zawinzala/brokenarrow-log-maggot/releases/latest")
                else: 
                    root.destroy()
                    os._exit(0)

            root.after(0, show_update_dialog)
            
    except Exception as e:
        ui_queue.put(("sys_log", f"更新检查出错: {str(e)}\n"))

threading.Thread(target=check_update, daemon=True).start()

# 线程安全队列
ui_queue = queue.Queue()

# 全局进度变量
progress_val = tk.IntVar(value=0)
progress_max = tk.IntVar(value=100)

def process_ui_queue():
    try:
        while True:
            msg_data = ui_queue.get_nowait()
            
            if isinstance(msg_data, tuple):
                msg_type, content = msg_data
                if msg_type == "text_log":
                    pass 
                elif msg_type == "text_query":
                    result_text.insert(tk.END, content)
                    result_text.see(tk.END)
                elif msg_type == "sys_log":
                    sys_log_text.config(state=tk.NORMAL)
                    sys_log_text.insert(tk.END, f"{datetime.now().strftime('%H:%M:%S')} {content}")
                    sys_log_text.see(tk.END)
                    sys_log_text.config(state=tk.DISABLED)
                elif msg_type == "progress_set_max":
                    progress_max.set(content)
                    progress_val.set(0)
                elif msg_type == "progress_inc":
                    progress_val.set(progress_val.get() + content)
                elif msg_type == "status":
                    status_label.config(text=content, fg="blue")
                
                # === 核心修改：处理ELO单独更新 ===
                elif msg_type == "update_elo_only":
                    uid, elo_val = content
                    uid_str = str(uid)
                    if tree_log.exists(uid_str):
                        tree_log.set(uid_str, "elo", round(elo_val))

                # === 核心修改：处理完整行更新(含勋章) ===
                elif msg_type == "update_table_row":
                    uid, res = content
                    player_data_cache[str(uid)] = res
                    if tree_log.exists(str(uid)):
                        unit_summary = ""
                        if res.get('fav_units'):
                            unit_summary = " ".join([f"{u['type']}{u['name']}" for u in res['fav_units']])
                        
                        tags_summary = ""
                        if res.get('tags'):
                            tags_summary = " ".join([f"{t['icon']}{t['name']}" for t in res['tags']])
                        
                        tree_log.set(str(uid), "elo", res.get('elo', 0))
                        tree_log.set(str(uid), "score", res.get('score', 0))
                        tree_log.set(str(uid), "label", res.get('label', ''))
                        tree_log.set(str(uid), "tags", tags_summary)
                        tree_log.set(str(uid), "units", unit_summary)
            else:
                pass
                
    except queue.Empty:
        pass
    root.after(100, process_ui_queue)

# ==================== 布局优化核心区域 ====================

# 1. 先定义底部日志框
log_frame = tk.LabelFrame(root, text="系统详细日志 (Debug Log)", font=("Microsoft YaHei", 9))
log_frame.pack(side="bottom", fill="x", padx=10, pady=(0, 10))

sys_log_text = scrolledtext.ScrolledText(log_frame, font=("Consolas", 9), height=6, state=tk.DISABLED)
sys_log_text.pack(fill="both", expand=True, padx=5, pady=5)

# 2. 再定义上面的 Notebook
notebook = ttk.Notebook(root)
notebook.pack(side="top", expand=True, fill="both", padx=10, pady=5)

tab_query = ttk.Frame(notebook)
tab_log = ttk.Frame(notebook)
tab_decks = ttk.Frame(notebook)
tab_info = ttk.Frame(notebook)

notebook.add(tab_query, text="蛆指数查询/Maggot")
notebook.add(tab_log, text="日志玩家解析/logMaggot")
notebook.add(tab_decks, text="卡组工具/DecksTool")
notebook.add(tab_info, text="关于/Info")

# ---------- Tab 1: 蛆指数查询 & 玩家搜索 ----------
search_frame = tk.LabelFrame(tab_query, text="搜索玩家 (双击列表自动填入ID)", font=("Microsoft YaHei", 10), padx=10, pady=10)
search_frame.pack(fill="x", padx=10, pady=5)

search_input_frame = tk.Frame(search_frame)
search_input_frame.pack(fill="x")

tk.Label(search_input_frame, text="玩家名关键字:", font=("Microsoft YaHei", 10)).pack(side="left")
entry_search_name = tk.Entry(search_input_frame, width=20, font=("Consolas", 10))
entry_search_name.pack(side="left", padx=5)

def search_player_action():
    keyword = entry_search_name.get().strip()
    if not keyword:
        messagebox.showwarning("提示", "请输入玩家名关键字")
        return
    
    for item in tree_search.get_children():
        tree_search.delete(item)
        
    def run_search():
        try:
            ui_queue.put(("sys_log", f"正在搜索玩家关键字: {keyword}...\n"))
            url = f"https://app.batrace.top/api/players/search?q={keyword}&limit=20"
            resp = requests.get(url, timeout=10)
            ui_queue.put(("sys_log", f"搜索API返回: {resp.status_code}\n"))
            
            if resp.status_code == 200:
                data = resp.json()
                players = data.get("players", [])
                ui_queue.put(("sys_log", f"搜索到 {len(players)} 名玩家\n"))
                
                def update_tree():
                    if not players:
                        messagebox.showinfo("结果", "未找到匹配玩家")
                        return
                    for p in players:
                        uid = p.get("id")
                        name = p.get("name")
                        level = p.get("level")
                        rating = p.get("rating") or 0
                        tree_search.insert("", "end", values=(uid, name, level, round(rating)))
                
                root.after(0, update_tree)
            else:
                root.after(0, lambda: messagebox.showerror("错误", f"API请求失败: {resp.status_code}"))
        except Exception as e:
            ui_queue.put(("sys_log", f"搜索异常: {str(e)}\n"))
            root.after(0, lambda: messagebox.showerror("异常", f"搜索出错: {str(e)}"))

    threading.Thread(target=run_search, daemon=True).start()

tk.Button(search_input_frame, text="🔍 搜索", command=search_player_action, bg="#60a5fa", fg="white").pack(side="left", padx=5)

tree_columns = ("id", "name", "level", "elo")
tree_search = ttk.Treeview(search_frame, columns=tree_columns, show="headings", height=5)
tree_search.heading("id", text="ID (stbid)")
tree_search.heading("name", text="玩家名")
tree_search.heading("level", text="等级")
tree_search.heading("elo", text="ELO分数")
tree_search.column("id", width=80)
tree_search.column("name", width=150)
tree_search.column("level", width=50)
tree_search.column("elo", width=80)
tree_search.pack(fill="x", pady=5)

def on_tree_double_click(event):
    item = tree_search.selection()
    if item:
        vals = tree_search.item(item, "values")
        if vals:
            target_id = vals[0]
            entry_stbid.delete(0, tk.END)
            entry_stbid.insert(0, target_id)
            query_maggot() 

tree_search.bind("<Double-1>", on_tree_double_click)

query_frame = tk.LabelFrame(tab_query, text="精确查询 (stbid)", font=("Microsoft YaHei", 10), padx=10, pady=10)
query_frame.pack(fill="both", expand=True, padx=10, pady=5)

input_box = tk.Frame(query_frame)
input_box.pack(pady=5)
tk.Label(input_box, text="玩家 stbid:", font=("Microsoft YaHei", 12)).pack(side="left")
entry_stbid = tk.Entry(input_box, width=20, font=("Consolas", 12))
entry_stbid.pack(side="left", padx=5)

def query_maggot():
    stbid = entry_stbid.get().strip()
    if not stbid.isdigit():
        result_text.insert(tk.END, "请输入有效的 stbid（数字）\n")
        return
    
    result_text.delete(1.0, tk.END)
    result_text.insert(tk.END, f"正在查询 stbid: {stbid} ...\n\n")
    
    def run():
        def append_msg(msg):
            ui_queue.put(("text_query", msg))
            
        query_single_player(stbid, append_msg)
        ui_queue.put(("text_query", f"\n查询完成 ({datetime.now().strftime('%H:%M:%S')})\n"))
    
    threading.Thread(target=run, daemon=True).start()

tk.Button(input_box, text="开始计算蛆指数", command=query_maggot, font=("Microsoft YaHei", 12), bg="#4ade80", fg="white").pack(side="left", padx=10)

result_text = scrolledtext.ScrolledText(query_frame, font=("Microsoft YaHei", 11), wrap=tk.WORD)
result_text.pack(expand=True, fill="both", padx=10, pady=10)

# ---------- Tab 2: 日志玩家解析 (优化布局) ----------
DEFAULT_LOG_PATH = r"C:\Program Files (x86)\Steam\steamapps\common\broken_arrow\GameLogs"
CONFIG_FILE = "log_config.json"

log_folder = DEFAULT_LOG_PATH
if os.path.exists(CONFIG_FILE):
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
            if cfg.get("log_folder_path"):
                log_folder = cfg.get("log_folder_path")
    except:
        pass

# 顶部控制区
top_ctrl_frame = tk.Frame(tab_log)
top_ctrl_frame.pack(fill="x", padx=10, pady=(10, 5))

tk.Label(top_ctrl_frame, text="日志路径:", font=("Microsoft YaHei", 10)).pack(side="left")
path_entry = tk.Entry(top_ctrl_frame, font=("Consolas", 9))
path_entry.insert(0, log_folder)
path_entry.pack(side="left", fill="x", expand=True, padx=5)

tk.Button(top_ctrl_frame, text="保存", width=6, command=lambda: (
    (lambda p=path_entry.get().strip(): (
        globals().update(log_folder=p),
        json.dump({"log_folder_path": p}, open(CONFIG_FILE, "w", encoding="utf-8")),
        messagebox.showinfo("成功", "路径已保存")
    ) if p else None)()
)).pack(side="left")

# 按钮和进度条
action_frame = tk.Frame(tab_log)
action_frame.pack(fill="x", padx=10, pady=5)

tk.Button(action_frame, text="刷新日志", font=("Microsoft YaHei", 9), bg="#60a5fa", fg="white",
          command=lambda: refresh_log()).pack(side="left", padx=(0, 5))
tk.Button(action_frame, text="批量查询蛆指数", font=("Microsoft YaHei", 9), bg="#ef4444", fg="white",
          command=lambda: query_all_players()).pack(side="left", padx=5)

tk.Label(action_frame, text="进度:", font=("Microsoft YaHei", 9)).pack(side="left", padx=(15, 5))
pb = ttk.Progressbar(action_frame, orient="horizontal", mode="determinate", variable=progress_val, maximum=100)
def update_pb_max(*args):
    pb.configure(maximum=progress_max.get())
progress_max.trace_add("write", update_pb_max)
pb.pack(side="left", fill="x", expand=True)

# 状态标签
info_label_frame = tk.Frame(tab_log)
info_label_frame.pack(fill="x", padx=10, pady=2)
status_label = tk.Label(info_label_frame, text="状态: 等待刷新", font=("Microsoft YaHei", 9), fg="gray")
status_label.pack(side="left")
file_label = tk.Label(info_label_frame, text="| 当前日志: 无", font=("Microsoft YaHei", 9), fg="gray")
file_label.pack(side="left", padx=5)

# 复制按钮
copy_frame = tk.Frame(tab_log)
copy_frame.pack(fill="x", padx=10, pady=5)

def copy_team_info(team_name):
    if team_name not in current_state.game_teams:
        return
    
    info_list = []
    for p in current_state.game_teams[team_name]:
        uid = str(p['id'])
        name = p['name']
        elo = "????"
        if uid in player_data_cache:
            elo = str(player_data_cache[uid].get('elo', '????'))
        
        info_list.append(f"【{name} ELO：{elo}】")
    
    full_str = "".join(info_list)
    root.clipboard_clear()
    root.clipboard_append(full_str)
    messagebox.showinfo("复制成功", f"已复制 {team_name} 队信息:\n{full_str}")

tk.Button(copy_frame, text="复制 Alpha 队", command=lambda: copy_team_info("Alpha"), bg="#e2e8f0", width=12).pack(side="left", padx=(0,5))
tk.Button(copy_frame, text="复制 Bravo 队", command=lambda: copy_team_info("Bravo"), bg="#e2e8f0", width=12).pack(side="left", padx=5)
tk.Label(copy_frame, text="(提示: 单击表格行复制详情)", font=("Microsoft YaHei", 8), fg="gray").pack(side="left", padx=10)

# 表格区域 (核心修改：增加tags列)
tree_frame = tk.Frame(tab_log)
tree_frame.pack(expand=True, fill="both", padx=10, pady=(0, 10))

tree_log_cols = ("team", "name", "id", "elo", "score", "label", "tags", "units")
tree_log = ttk.Treeview(tree_frame, columns=tree_log_cols, show="headings")

tree_log.heading("team", text="队伍")
tree_log.heading("name", text="玩家名")
tree_log.heading("id", text="ID (stbid)")
tree_log.heading("elo", text="ELO")
tree_log.heading("score", text="蛆指数")
tree_log.heading("label", text="评价")
tree_log.heading("tags", text="常见勋章")
tree_log.heading("units", text="常用单位 (输出/击杀/承伤)")

tree_log.column("team", width=50, anchor="center")
tree_log.column("name", width=130)
tree_log.column("id", width=80, anchor="center")
tree_log.column("elo", width=50, anchor="center")
tree_log.column("score", width=50, anchor="center")
tree_log.column("label", width=80, anchor="center")
tree_log.column("tags", width=150)
tree_log.column("units", width=350)

scroll_tree = tk.Scrollbar(tree_frame, orient="vertical", command=tree_log.yview)
tree_log.config(yscrollcommand=scroll_tree.set)
scroll_tree.pack(side="right", fill="y")
tree_log.pack(side="left", fill="both", expand=True)

def on_log_tree_select(event):
    item_id = tree_log.selection()
    if not item_id:
        return
    
    uid = item_id[0] 
    
    data = player_data_cache.get(str(uid))
    if not data:
        return
    
    name = data.get('name', 'Unknown')
    elo = data.get('elo', '????')
    score = data.get('score', '??')
    
    units = "无数据"
    if data.get('fav_units'):
        u_names = [f"{u['type']}{u['name']}" for u in data['fav_units']]
        units = "，".join(u_names)
    
    copy_str = f"【{name} ELO：{elo}】【maggot: {score}】【{units}】"
    
    root.clipboard_clear()
    root.clipboard_append(copy_str)
    
    status_label.config(text=f"已复制: {name}", fg="green")

tree_log.bind("<ButtonRelease-1>", on_log_tree_select)

current_state = GameState()

def refresh_log():
    global current_state
    
    for item in tree_log.get_children():
        tree_log.delete(item)
    player_data_cache.clear()
    
    status_label.config(text="状态: 正在解析...", fg="orange")
    ui_queue.put(("sys_log", "开始解析本地游戏日志...\n"))
    root.update()
    
    folder = path_entry.get().strip()
    if not folder or not os.path.exists(folder):
        status_label.config(text="状态: 路径错误", fg="red")
        ui_queue.put(("sys_log", f"错误: 日志路径不存在 {folder}\n"))
        return
    
    files = glob.glob(os.path.join(folder, "Gamelog__*.log"))
    if not files:
        status_label.config(text="状态: 无日志文件", fg="red")
        ui_queue.put(("sys_log", "错误: 目录下无Gamelog文件\n"))
        return
    
    latest_file = max(files, key=os.path.getmtime)
    file_label.config(text=f"| 日志: {os.path.basename(latest_file)}")
    ui_queue.put(("sys_log", f"读取日志文件: {latest_file}\n"))
    
    current_state = GameState()
    try:
        with open(latest_file, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                process_log_line(line, current_state)
        
        if current_state.in_game:
            for team_name in ["Alpha", "Bravo"]:
                for p in current_state.game_teams[team_name]:
                    tree_log.insert("", "end", iid=str(p['id']), values=(team_name, p['name'], p['id'], "-", "-", "-", "-", "-"))
            
            for p in current_state.all_game_players:
                if not tree_log.exists(str(p['id'])):
                    tree_log.insert("", "end", iid=str(p['id']), values=("Unknown", p['name'], p['id'], "-", "-", "-", "-", "-"))
                    
        else:
            for uid, name in sorted(current_state.lobby_players.items(), key=lambda x: x[1].lower()):
                tree_log.insert("", "end", iid=str(uid), values=("Lobby", name, uid, "-", "-", "-", "-", "-"))
        
        status_label.config(text="状态: 解析成功（请点击查询）", fg="green")
        ui_queue.put(("sys_log", "日志解析完成，玩家列表已更新。\n"))
        
    except Exception as e:
        status_label.config(text="状态: 解析失败", fg="red")
        ui_queue.put(("sys_log", f"解析日志异常: {str(e)}\n"))
        messagebox.showerror("错误", str(e))

def query_all_players():
    if not tree_log.get_children():
        messagebox.showwarning("警告", "请先刷新解析日志，获取当前在场玩家")
        return
    
    uids = tree_log.get_children()
    
    if not uids:
        return
    
    total_count = len(uids)
    ui_queue.put(("progress_set_max", total_count))
    ui_queue.put(("status", f"正在批量查询 {total_count} 名玩家..."))
    ui_queue.put(("sys_log", f"=== 开始批量查询 {total_count} 名玩家 ===\n"))
    
    def worker(stbid):
        def no_op(msg): pass
        
        # 定义快速更新ELO的回调
        def quick_elo_callback(uid, elo_val):
            ui_queue.put(("update_elo_only", (uid, elo_val)))

        # 传入回调
        res = query_single_player(stbid, no_op, quick_update_func=quick_elo_callback)
        
        if res:
            ui_queue.put(("update_table_row", (stbid, res)))
        
        ui_queue.put(("progress_inc", 1))
    
    def run_batch():
        with ThreadPoolExecutor(max_workers=6) as executor:
            for uid in uids:
                executor.submit(worker, uid)
        
        ui_queue.put(("status", "批量查询完成"))
        ui_queue.put(("sys_log", "=== 批量查询结束 ===\n"))

    threading.Thread(target=run_batch, daemon=True).start()

# ---------- Tab 3: 卡组工具 ----------
user_home = os.path.expanduser("~")
local_low_path = os.path.join(user_home, 'AppData', 'LocalLow')

DEFAULT_DECK_PATH = os.path.join(local_low_path, 'SteelBalalaikaStudio', 'BrokenArrow', 'Decks')
DEFAULT_BACKUP_PATH = os.path.join(local_low_path, 'SteelBalalaikaStudio', 'BrokenArrow', 'DeckBackups')

if not os.path.exists(DEFAULT_BACKUP_PATH):
    try:
        os.makedirs(DEFAULT_BACKUP_PATH)
    except:
        pass

deck_main_frame = tk.Frame(tab_decks)
deck_main_frame.pack(fill="both", expand=True, padx=10, pady=10)

frame_left = tk.LabelFrame(deck_main_frame, text="前线卡组 (.dek)", font=("Microsoft YaHei", 10))
frame_left.pack(side="left", fill="both", expand=True)

list_front = tk.Listbox(frame_left, font=("Microsoft YaHei", 9), selectmode="extended")
scroll_front = tk.Scrollbar(frame_left, orient="vertical", command=list_front.yview)
list_front.config(yscrollcommand=scroll_front.set)
scroll_front.pack(side="right", fill="y")
list_front.pack(side="left", fill="both", expand=True)

frame_mid = tk.Frame(deck_main_frame)
frame_mid.pack(side="left", fill="y", padx=10)

frame_right = tk.LabelFrame(deck_main_frame, text="后勤仓库 (.zip)", font=("Microsoft YaHei", 10))
frame_right.pack(side="right", fill="both", expand=True)

list_back = tk.Listbox(frame_right, font=("Microsoft YaHei", 9), selectmode="single")
scroll_back = tk.Scrollbar(frame_right, orient="vertical", command=list_back.yview)
list_back.config(yscrollcommand=scroll_back.set)
scroll_back.pack(side="right", fill="y")
list_back.pack(side="left", fill="both", expand=True)

path_info_frame = tk.Frame(tab_decks)
path_info_frame.pack(fill="x", padx=10, pady=5)

def open_folder(path):
    if os.path.exists(path):
        subprocess.Popen(f'explorer "{path}"')
    else:
        messagebox.showerror("错误", "文件夹不存在")

tk.Button(path_info_frame, text="📂 打开前线目录", command=lambda: open_folder(DEFAULT_DECK_PATH)).pack(side="left", padx=5)
tk.Button(path_info_frame, text="📂 打开后勤目录", command=lambda: open_folder(DEFAULT_BACKUP_PATH)).pack(side="right", padx=5)

def refresh_decks():
    list_front.delete(0, tk.END)
    list_back.delete(0, tk.END)
    
    if os.path.exists(DEFAULT_DECK_PATH):
        files = glob.glob(os.path.join(DEFAULT_DECK_PATH, "*.dek"))
        files.sort(key=os.path.getmtime, reverse=True)
        for f in files:
            list_front.insert(tk.END, os.path.basename(f))
            
    if os.path.exists(DEFAULT_BACKUP_PATH):
        files = glob.glob(os.path.join(DEFAULT_BACKUP_PATH, "*.zip"))
        files.sort(key=os.path.getmtime, reverse=True)
        for f in files:
            list_back.insert(tk.END, os.path.basename(f))

def backup_decks():
    selections = list_front.curselection()
    if not selections:
        messagebox.showwarning("提示", "请先在左侧选择要备份的卡组文件（支持多选）")
        return
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    default_name = f"Backup-{timestamp}"
    
    custom_name = simpledialog.askstring("备份命名", "请输入备份包名称:", initialvalue=default_name, parent=root)
    
    if not custom_name:
        return 
        
    if not custom_name.lower().endswith(".zip"):
        custom_name += ".zip"
    
    zip_name = custom_name
    zip_path = os.path.join(DEFAULT_BACKUP_PATH, zip_name)
    
    if os.path.exists(zip_path):
        if not messagebox.askyesno("覆盖确认", f"文件 {zip_name} 已存在，是否覆盖？"):
            return

    try:
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for idx in selections:
                fname = list_front.get(idx)
                fpath = os.path.join(DEFAULT_DECK_PATH, fname)
                if os.path.exists(fpath):
                    zf.write(fpath, fname)
        messagebox.showinfo("成功", f"已备份 {len(selections)} 个卡组到: {zip_name}")
        refresh_decks()
    except Exception as e:
        messagebox.showerror("失败", str(e))

def deploy_decks():
    selection = list_back.curselection()
    if not selection:
        messagebox.showwarning("提示", "请先在右侧选择要部署的备份包")
        return
    
    zip_name = list_back.get(selection[0])
    zip_path = os.path.join(DEFAULT_BACKUP_PATH, zip_name)
    
    if not messagebox.askyesno("确认部署", f"确定要从 {zip_name} 部署卡组吗？\n同名文件将被覆盖！"):
        return
    
    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(DEFAULT_DECK_PATH)
        messagebox.showinfo("成功", "部署完成，请在游戏中检查")
        refresh_decks()
    except Exception as e:
        messagebox.showerror("失败", str(e))

def delete_file(is_front):
    lst = list_front if is_front else list_back
    base_path = DEFAULT_DECK_PATH if is_front else DEFAULT_BACKUP_PATH
    
    selections = lst.curselection()
    if not selections:
        return
    
    if not messagebox.askyesno("删除", f"确定删除选中的 {len(selections)} 个文件吗？"):
        return
        
    try:
        for idx in reversed(selections):
            fname = lst.get(idx)
            fpath = os.path.join(base_path, fname)
            if os.path.exists(fpath):
                os.remove(fpath)
        refresh_decks()
    except Exception as e:
        messagebox.showerror("错误", str(e))

tk.Button(frame_mid, text="刷新列表", command=refresh_decks).pack(fill="x", pady=5)
tk.Label(frame_mid, text="---").pack(pady=5)
tk.Button(frame_mid, text="备份到后勤 ->\n(生成zip包)", command=backup_decks, bg="#60a5fa", fg="white", height=3).pack(fill="x", pady=10)
tk.Button(frame_mid, text="<- 部署到前线\n(解压zip包)", command=deploy_decks, bg="#4ade80", fg="white", height=3).pack(fill="x", pady=10)
tk.Label(frame_mid, text="---").pack(pady=5)
tk.Button(frame_mid, text="删除左侧选中", command=lambda: delete_file(True), bg="#ef4444", fg="white").pack(fill="x", pady=5)
tk.Button(frame_mid, text="删除右侧选中", command=lambda: delete_file(False), bg="#ef4444", fg="white").pack(fill="x", pady=5)

refresh_decks()

# ---------- Tab 4: Info 页面 ----------

info_container = tk.Frame(tab_info)
info_container.pack(expand=True, fill="both", padx=50, pady=50)

tk.Label(info_container, text=f"Broken Arrow 蛆工具 {CURRENT_VERSION}", font=("Microsoft YaHei", 20, "bold")).pack(pady=10)

intro_text = """
本工具提供以下功能：
1. 蛆指数查询：输入 ID 查询玩家近期排位表现。
2. 日志解析：自动读取游戏日志，批量查询当前房间内所有玩家。
3. 卡组管理：便捷备份和恢复游戏卡组 (.dek)。
"""
tk.Label(info_container, text=intro_text, font=("Microsoft YaHei", 11), justify="left", fg="#4b5563").pack(pady=10)

tk.Label(info_container, text="作者: Zola ⭐ 软件：Python ⭐ 数据提供：Eero", font=("Microsoft YaHei", 12, "bold")).pack(pady=5)

btn_frame = tk.Frame(info_container)
btn_frame.pack(pady=20)

def open_web_maggot():
    webbrowser.open("https://zawinzala.github.io/Broken-Arrow-Maggot/")

def open_dash_aoeiaol():
    webbrowser.open("https://dash.aoeiaol.top/")

btn_style = {"font": ("Microsoft YaHei", 11), "width": 20, "height": 2}

tk.Button(btn_frame, text="🌐 访问网页版蛆指数", command=open_web_maggot, bg="#60a5fa", fg="white", **btn_style).pack(side="left", padx=20)
tk.Button(btn_frame, text="📊 访问 Eero 的 aoeiaol", command=open_dash_aoeiaol, bg="#f59e0b", fg="white", **btn_style).pack(side="left", padx=20)

tk.Label(info_container, text="特别鸣谢 Eero 开发的 API 支持！", font=("Microsoft YaHei", 10), fg="gray").pack(pady=(30, 0))
tk.Label(info_container, text="(I love him ❤️)", font=("Microsoft YaHei", 10, "italic"), fg="#ec4899").pack(pady=(0, 10))


root.after(100, process_ui_queue)

root.mainloop()