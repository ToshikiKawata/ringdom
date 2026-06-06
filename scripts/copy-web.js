// Capacitor の webDir(www/) にバンドル対象だけをコピーする。
// このアプリはビルド工程が無いので、根本(index.html/manifest.json/icons)を www/ へ複製する。
// www/ は生成物なので git 管理しない(.gitignore)。cap sync の前に必ず実行する。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const www = path.join(root, 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });

fs.copyFileSync(path.join(root, 'index.html'), path.join(www, 'index.html'));
fs.copyFileSync(path.join(root, 'manifest.json'), path.join(www, 'manifest.json'));
fs.cpSync(path.join(root, 'icons'), path.join(www, 'icons'), { recursive: true });

// macOS の拡張属性(Finder情報等)を除去しておく。
// iOS の codesign が "resource fork / Finder information ... not allowed" で
// 失敗するのを防ぐ。(com.apple.provenance はシステム保護のため残ることがある)
if (process.platform === 'darwin') {
  try {
    require('child_process').execSync(`xattr -cr "${www}"`, { stdio: 'ignore' });
  } catch (e) { /* best-effort */ }
}

console.log('[copy-web] www/ を生成しました (index.html / manifest.json / icons)');
