// ================= 本地对局档案 =================
// 把日志里解析出的对局（含 FID/地图/名单）持久化到本地 JSON，
// 以便跨会话查看历史。
const fs = require('fs');
const path = require('path');

class MatchArchive {
  constructor(file) {
    this.file = file;
    this.matches = [];
    try {
      if (fs.existsSync(file)) {
        this.matches = JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch (e) {
      this.matches = [];
    }
  }

  // 按 FID 去重后追加
  add(match) {
    if (!match || !match.players || !match.players.length) return false;
    const key = match.fid ? `fid:${match.fid}` : `t:${match.startTime}`;
    if (this.matches.some((m) => (m.fid && match.fid && m.fid === match.fid))) return false;
    const record = {
      fid: match.fid || null,
      map: match.map || '',
      scenario: match.scenario || '',
      startTime: match.startTime || null,
      endTime: match.endTime || null,
      durationSec: match.durationSec || null,
      points: match.points || null,
      localDeck: match.localDeck || '',
      players: match.players,
      archivedAt: Date.now()
    };
    this.matches.unshift(record);
    if (this.matches.length > 200) this.matches.length = 200;
    this.flush();
    return true;
  }

  list() {
    return this.matches;
  }

  clear() {
    this.matches = [];
    this.flush();
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.matches, null, 2), 'utf8');
    } catch (e) {}
  }
}

module.exports = { MatchArchive };
