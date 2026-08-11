// ================= WebM Duration 补丁（修复进度条） =================
// MediaRecorder 产出的 WebM 不写 Duration/Cues，播放器时长=Infinity，进度条/拖动失效。
// 在保存前给 Segment/Info 补一个 Duration 元素（timecodeScale=1ms，值为 秒×1000 的 float64）。
function patchWebmDuration(buf, durationSec) {
  try {
    if (!buf || !buf.length) return buf;
    const b = Buffer.from(buf);
    const readId = (off) => {
      const first = b[off];
      let mask = 0x80, len = 1;
      while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
      if (len > 8) return null;
      let val = 0;
      for (let i = 0; i < len; i++) val = val * 256 + b[off + i];
      return { len, val };
    };
    const readSize = (off) => {
      const first = b[off];
      if (first === 0) return null;
      let mask = 0x80, len = 1;
      while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
      if (len > 8) return null;
      let val = first & (mask - 1);
      for (let i = 1; i < len; i++) val = val * 256 + b[off + i];
      return { len, val };
    };
    const idTop = readId(0);
    if (!idTop || idTop.val !== 0x1a45dfa3) return buf;
    const szTop = readSize(idTop.len);
    if (!szTop) return buf;
    const segOff = idTop.len + szTop.len + szTop.val;
    const idSeg = readId(segOff);
    if (!idSeg || idSeg.val !== 0x18538067) return buf;
    const szSeg = readSize(segOff + idSeg.len);
    if (!szSeg) return buf;
    const infoOff = segOff + idSeg.len + szSeg.len;
    const idInfo = readId(infoOff);
    if (!idInfo || idInfo.val !== 0x1549a966) return buf;
    const szInfo = readSize(infoOff + idInfo.len);
    if (!szInfo) return buf;
    const dataOff = infoOff + idInfo.len + szInfo.len;
    const dataLen = szInfo.val;
    const oldInfo = b.slice(dataOff, dataOff + dataLen);
    if (oldInfo.includes(Buffer.from([0x44, 0x89]))) return buf; // 已有 Duration，跳过
    const secs = Number(durationSec) || 0;
    if (secs <= 0) return buf;
    const durElem = Buffer.alloc(11);
    durElem[0] = 0x44; durElem[1] = 0x89; durElem[2] = 0x88;
    durElem.writeDoubleBE(Math.round(secs * 1000), 3);
    const newDataLen = dataLen + durElem.length;
    const vintBytes = (n) => {
      if (n <= 126) return Buffer.from([0x80 | n]);
      if (n < 16383) return Buffer.from([0x40 | ((n >> 8) & 0x3f), n & 0xff]);
      if (n < 2097151) return Buffer.from([0x20 | ((n >> 16) & 0x1f), (n >> 8) & 0xff, n & 0xff]);
      return Buffer.from([0x10 | ((n >> 24) & 0x0f), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
    };
    return Buffer.concat([
      b.slice(0, infoOff + idInfo.len),
      vintBytes(newDataLen),
      durElem,
      oldInfo,
      b.slice(dataOff + dataLen)
    ]);
  } catch (e) { return buf; }
}

module.exports = { patchWebmDuration };