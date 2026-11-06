// 开发期的快速启动入口（`pnpm dev`），macOS / Linux / Windows 通用。
//
// 为什么需要它：`pnpm bundle` 会跑 release 编译（LTO，约 90 秒）再打安装包，
// 开发时都不必要 —— 只要 debug 增量编译（约 2-3 秒）加启动。
//
// `cargo build` 会顺带跑 build.rs，把 init.js / init-debug.js 拷到
// target/debug/ 下；debug 构建启动时从磁盘读脚本，所以改脚本不需要重编译。
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const isWindows = process.platform === "win32";
const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);

const bin = fileURLToPath(
  new URL(`../src-tauri/target/debug/fenbi-desktop${isWindows ? ".exe" : ""}`, import.meta.url),
);

console.log("==> 关闭已在运行的 debug 实例");
if (isWindows) {
  // 只按完整路径匹配：已安装的正式版 exe 同样叫 fenbi-desktop.exe，不能误杀
  const literal = bin.replaceAll("'", "''");
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-Process fenbi-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${literal}' } | Stop-Process -Force`,
    ],
    { stdio: "inherit" },
  );
} else {
  spawnSync("pkill", ["-f", "target/debug/fenbi-desktop"], { stdio: "ignore" });
}
await sleep(500);

console.log("==> 增量编译（会顺带同步 init.js）");
await import("./build-ui.mjs");
// Windows 上 cargo 可能是 .cmd 包装（如 rustup 代理以外的安装方式），走 shell 才能找到
const build = spawnSync("cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml"], {
  stdio: "inherit",
  shell: isWindows,
});
if (build.status !== 0) {
  console.error("==> 编译失败，未启动");
  process.exit(build.status ?? 1);
}

console.log("==> 启动");
const app = spawn(bin, [], {
  stdio: "inherit",
  env: { ...process.env, FENBI_DEBUG: process.env.FENBI_DEBUG ?? "1" },
});

// 终端的 Ctrl+C 会同时发给整个前台进程组，app 自己会收到；
// 这里只需要让本进程别先退出，等 app 结束后按它的结果退出。
const forward = (signal) => () => app.kill(signal);
const handlers = { SIGINT: forward("SIGINT"), SIGTERM: forward("SIGTERM") };
for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);

app.on("error", (err) => {
  console.error(`==> 启动失败：${err.message}`);
  process.exit(1);
});
app.on("exit", (code, signal) => {
  for (const [s, handler] of Object.entries(handlers)) process.off(s, handler);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
