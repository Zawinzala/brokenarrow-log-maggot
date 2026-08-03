// ================= 日志解析器 =================
// 把游戏日志的一行行文本翻译成结构化事件（对局开始/名单/地图/FID/结束等）
// 解析规则基于实测日志格式（见 Gamelog__2026_08_01__23_36.log）

// 常用正则（已按实测日志验证）
const RE = {
  persona: /^Log: GetPersonaName\s+(.+)$/,
  lobbyEnter: /^Log: Enter to lobby \(id: \d+\)/,
  lobbyExit: /^Log: Exit lobby/,
  incoming: /^Log: Incoming client (.*?):(\d+) to lobby/,
  outgoing: /^Log: Outgoing client (.*?):(\d+) exit/,
  battleStart: /^Log: Start loading battle\.\.\. map: ([^,]+),\s*scenario:\s*(.*)$/,
  playerList: /^Log: Player list:\s*$/,
  playerRow: /^ID: (\d+), Name: (.*?), Team: (\w+)$/,
  roomClient: /^Log: Room: \(GameRoom\|\d+\), Client: \(([^|]+)\|(\d+)\)$/,
  fid: /^Log: FID:(\d+)/,
  deck: /^Log: Deck set to: (.*)$/,
  totalPoints: /^Log: TOTAL POINTS: ([0-9.]+)$/,
  gameControllerDispose: /^Log: GameController dispose called/,
  netRoomEnter: /^Log: \[NET_ROOM\] GameRoom entered/,
  netRoomExit: /^Log: \[NET_ROOM\] GameRoom exited/,
  connClosed: /^Log: \[NET_ROOM\] Connection closed\. .*LiveTime: (\d+) sec/
};

function emptyMatch() {
  return {
    fid: null,
    map: '',
    scenario: '',
    startTime: null,
    endTime: null,
    durationSec: null,
    points: null,
    localDeck: '',
    players: [],           // {id, name, team} team: 0=Alpha 1=Bravo
    source: 'log'
  };
}

class LogParser {
  constructor(onEvent) {
    this.onEvent = onEvent || (() => {});
    this.localName = null;
    this.lobbyPlayers = {};   // uid -> name
    this.currentDeck = '';
    this.current = null;      // 当前对局（进行中或最近一次）
    this.archived = [];       // 已完成对局
    this.lastEnded = null;    // 刚结束的对局（等网络统计补时长）
    this._inPlayerList = false;
  }

  // 重置（切换日志文件时调用）
  reset(keepLocalName) {
    if (!keepLocalName) this.localName = null;
    this.lobbyPlayers = {};
    this.currentDeck = '';
    this.current = null;
    this.archived = [];
    this._inPlayerList = false;
  }

  feed(lines) {
    for (const line of lines) {
      this.handleLine(line);
    }
  }

  handleLine(raw) {
    const line = (raw || '').replace(/\r$/, '');
    if (!line) return;
    const ev = (type, data) => this.onEvent(type, data);

    let m;

    if ((m = RE.persona.exec(line))) {
      this.localName = m[1].trim();
      ev('localName', this.localName);
      return;
    }

    if (RE.lobbyEnter.test(line) || RE.lobbyExit.test(line)) {
      // 进入新大厅 = 清空上一局状态（存档过的已经存过）
      this.lobbyPlayers = {};
      this.current = null;
      this._inPlayerList = false;
      ev('lobbyReset');
      return;
    }

    if ((m = RE.incoming.exec(line))) {
      this.lobbyPlayers[m[2]] = m[1].trim();
      ev('lobbyPlayers', { ...this.lobbyPlayers });
      return;
    }
    if ((m = RE.outgoing.exec(line))) {
      delete this.lobbyPlayers[m[2]];
      ev('lobbyPlayers', { ...this.lobbyPlayers });
      return;
    }

    if ((m = RE.battleStart.exec(line))) {
      this._beginMatch(m[1].trim(), m[2].trim());
      return;
    }

    if (RE.netRoomEnter.test(line)) {
      // 进入对局房间（没有 battleStart 行时兜底）
      if (!this.current) this._beginMatch('', '');
      return;
    }

    if (RE.playerList.test(line)) {
      this._inPlayerList = true;
      return;
    }

    if (this._inPlayerList && (m = RE.playerRow.exec(line))) {
      const id = m[1];
      const name = m[2].trim();
      const team = m[3]; // Alpha / Bravo / Spectators
      if (this.current && !this.current.players.some((p) => p.id === id)) {
        this.current.players.push({ id, name, team });
        ev('roster', { fid: this.current.fid, map: this.current.map, players: this.current.players });
      }
      return;
    }

    if ((m = RE.roomClient.exec(line))) {
      // 房间客户端名单（无队伍信息，作为名单兜底）
      const name = m[1].trim();
      const id = m[2];
      if (this.current && !this.current.players.some((p) => p.id === id)) {
        this.current.players.push({ id, name, team: null });
        ev('roster', { fid: this.current.fid, map: this.current.map, players: this.current.players });
      }
      return;
    }

    if ((m = RE.fid.exec(line))) {
      if (this.current) this.current.fid = m[1];
      ev('fid', m[1]);
      return;
    }

    if ((m = RE.deck.exec(line))) {
      const v = m[1].trim();
      this.currentDeck = (v && v.toLowerCase() !== 'null') ? v : '';
      if (this.current) this.current.localDeck = this.currentDeck;
      ev('deck', this.currentDeck);
      return;
    }

    if ((m = RE.totalPoints.exec(line))) {
      if (this.current) this.current.points = parseFloat(m[1]);
      ev('points', this.current ? this.current.points : null);
      return;
    }

    if ((m = RE.connClosed.exec(line))) {
      const sec = parseInt(m[1], 10);
      if (this.current && !this.current.durationSec) {
        this.current.durationSec = sec;
        ev('matchMeta', { ...this.current });
      } else if (!this.current && this.lastEnded && !this.lastEnded.durationSec) {
        // 对局已结束，用网络统计补记时长
        this.lastEnded.durationSec = sec;
        ev('matchMeta', { ...this.lastEnded });
      }
      return;
    }

    if (RE.gameControllerDispose.test(line)) {
      this._endMatch();
    }

    if (RE.netRoomExit.test(line)) {
      // 离开对局房间（部分日志没有 dispose 行，作为兜底结束）
      if (this.current && this.current.players.length) this._endMatch();
    }
  }

  _beginMatch(map, scenario) {
    // 上一局未结束时先收尾
    if (this.current && this.current.players.length) this._endMatch();
    this.current = emptyMatch();
    this.current.map = map;
    this.current.scenario = scenario;
    this.current.startTime = Date.now();
    this.current.localDeck = this.currentDeck;
    this._inPlayerList = false;
    this.onEvent('matchStart', { ...this.current });
  }

  _endMatch() {
    if (!this.current) return;
    this.current.endTime = Date.now();
    if (!this.current.durationSec && this.current.startTime) {
      this.current.durationSec = Math.round((this.current.endTime - this.current.startTime) / 1000);
    }
    const done = { ...this.current };
    this.archived.push(done);
    this.lastEnded = done;
    this.onEvent('matchEnd', done);
    this.current = null;
    this._inPlayerList = false;
  }

  snapshot() {
    return {
      localName: this.localName,
      lobbyPlayers: { ...this.lobbyPlayers },
      currentDeck: this.currentDeck,
      current: this.current ? { ...this.current } : null,
      archivedCount: this.archived.length
    };
  }
}

module.exports = { LogParser };



