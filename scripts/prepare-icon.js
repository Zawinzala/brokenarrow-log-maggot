// ================= 打包前图标准备 =================
// 把根目录的 logo.png 自动复制为 build/icon.png，
// electron-builder 会把它（要求 ≥256x256）自动转成 Windows .ico 用于 exe 与安装包。
// 没有 logo.png 时保持默认图标，不影响打包。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'logo.png');
const buildDir = path.join(root, 'build');
const dest = path.join(buildDir, 'icon.png');

function pngSize(buf) {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
  } catch (e) {}
  return null;
}

if (fs.existsSync(src)) {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.copyFileSync(src, dest);
  const size = pngSize(fs.readFileSync(src));
  if (size && (size.w < 256 || size.h < 256)) {
    console.warn('[icon] 警告：logo.png 只有 ' + size.w + 'x' + size.h + '，建议使用 ≥256x256，否则图标可能模糊。');
  } else if (size) {
    console.log('[icon] 已使用根目录 logo.png（' + size.w + 'x' + size.h + '）作为软件图标');
  } else {
    console.log('[icon] 已复制 logo.png 作为图标（非 PNG 或无法读取尺寸）');
  }
} else {
  console.log('[icon] 未找到根目录 logo.png，使用 Electron 默认图标（可选：放一张 256x256 的 logo.png 到工程根目录）');
}
