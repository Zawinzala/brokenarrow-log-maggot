// ================= 日志目录监听 =================
// 周期性扫描用户设置的 GameLogs 目录：
//  - 始终读取“最新”的 Gamelog__*.log（按修改时间）
//  - 只增量读取新增字节，绝不整文件重读（历史日志可能几百 MB）
//  - 检测到新文件（游戏重启）时自动切换
const fs = require('fs');
const path = require('path');

// 兼容性：除了游戏原生的 Gamelog__*.log，也接受用户自放的 .log/.txt 文本日志；
// 多个文件时按“Gamelog__ 前缀优先 + 修改时间最新”排序。
const LOG_RE = /\.(log|txt)$/i;
const GAMELOG_RE = /^Gamelog__/i;

class LogWatcher {
  /**
   * @param {object} opts
   * @param {string} opts.dir           日志目录
   * @param {number} opts.pollMs        轮询间隔
   * @param {import('./logParser').LogParser} opts.parser
   */
  constructor(opts) {
    this.dir = opts.dir || '';
    this.pollMs = opts.pollMs || 1500;
    this.parser = opts.parser;
    this.timer = null;
    this.currentFile = null;   // 当前跟踪的文件名
    this.offset = 0;           // 已读字节位置
    this.pending = '';         // 未完成的行尾
    this.lastSnapshot = '';
    this.lastMtime = 0;        // 最新日志文件修改时间（判断日志是否新鲜）
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.poll();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // 目录下最新的日志文件（按修改时间）
  findNewest() {
    try {
      if (!this.dir || !fs.existsSync(this.dir)) return null;
      const files = fs.readdirSync(this.dir)
        .filter((f) => LOG_RE.test(f))
        .map((f) => {
          const full = path.join(this.dir, f);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch (e) {}
          return { name: f, full, mtime };
        })
        .sort((a, b) => {
          const aG = GAMELOG_RE.test(a.name) ? 1 : 0;
          const bG = GAMELOG_RE.test(b.name) ? 1 : 0;
          if (aG !== bG) return bG - aG;
          return b.mtime - a.mtime;
        });
      return files[0] || null;
    } catch (e) {
      return null;
    }
  }

  poll() {
    const newest = this.findNewest();
    if (!newest) {
      if (this.currentFile) {
        this.currentFile = null;
        this.offset = 0;
        this.pending = '';
        this.lastMtime = 0;
        this._emit('watcher', { file: null, listening: false });
      }
      return;
    }

    this.lastMtime = newest.mtime;

    // 文件切换：重置解析器（保留本地玩家名）并从头读
    if (newest.name !== this.currentFile) {
      this.currentFile = newest.name;
      this.offset = 0;
      this.pending = '';
      this.parser.reset(true);
      this._emit('watcher', { file: newest.name, listening: true });
    }

    let size = 0;
    try { size = fs.statSync(newest.full).size; } catch (e) { return; }

    if (size < this.offset) {
      // 文件被截断/轮换，从头读
      this.offset = 0;
      this.pending = '';
    }
    if (size === this.offset) {
      this._emitState();
      return;
    }

    let chunk;
    try {
      const fd = fs.openSync(newest.full, 'r');
      chunk = Buffer.alloc(size - this.offset);
      fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      fs.closeSync(fd);
    } catch (e) {
      return;
    }

    this.offset = size;
    let text = this.pending + chunk.toString('utf8');
    const lines = text.split('\n');
    this.pending = lines.pop() || ''; // 最后一段可能是半个行，留到下次
    if (lines.length) {
      this.parser.feed(lines);
    }
    this._emitState();
  }

  _emit(type, data) {
    if (typeof this.parser.onEvent === 'function') {
      this.parser.onEvent(type, data);
    }
  }

  _emitState() {
    const snap = this.parser.snapshot();
    const json = JSON.stringify(snap);
    if (json !== this.lastSnapshot) {
      this.lastSnapshot = json;
      this._emit('session', snap);
    }
  }

  status() {
    return {
      dir: this.dir,
      file: this.currentFile,
      listening: !!this.currentFile
    };
  }
}

module.exports = { LogWatcher };
