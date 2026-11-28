import { cpSync, mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";
const dist = new URL("../dist/", import.meta.url);
// 先清空 dist，免得上次构建的残留文件被带进安装包。
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
// 跳过以 . 开头的文件和目录：toolbar/ 里会有 skill 留下的东西（如 hallmark 的截图目录 .hallmark/），它们不属于应用。
cpSync(new URL("../src-tauri/toolbar/", import.meta.url), dist, {
  recursive: true,
  filter: (src) => !basename(src).startsWith("."),
});
// 设置页面卡片上的应用图标：只有 src-tauri/icons/ 这一处来源，构建时复制一份。
cpSync(new URL("../src-tauri/icons/128x128.png", import.meta.url), new URL("app-icon.png", dist));
