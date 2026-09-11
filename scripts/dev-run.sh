#!/usr/bin/env bash
# 开发期的快速启动脚本。
#
# 为什么需要它：`pnpm tauri build` 会跑 release 编译（LTO，约 90 秒）
# 再打 DMG（约 30 秒）。但开发时这两步都不必要 —— 只要 debug 编译
# （增量约 2-3 秒）加一个 open。
#
# `cargo build` 会顺带跑 build.rs，把 init.js / init-debug.js 拷到
# target/debug/ 下；debug 构建启动时从磁盘读脚本，所以改脚本不需要重编译。
set -euo pipefail

cd "$(dirname "$0")/.."

BIN="src-tauri/target/debug/fenbi-desktop"

echo "==> 关闭已在运行的 debug 实例"
pkill -f "target/debug/fenbi-desktop" 2>/dev/null || true
sleep 0.5

echo "==> 增量编译（会顺带同步 init.js）"
cargo build --manifest-path src-tauri/Cargo.toml

echo "==> 启动"
FENBI_DEBUG="${FENBI_DEBUG:-1}" exec "$BIN"
