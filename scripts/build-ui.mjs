import { cpSync, mkdirSync } from "node:fs";
mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
cpSync(new URL("../src-tauri/toolbar/", import.meta.url), new URL("../dist/", import.meta.url), { recursive: true });
// 设置页面卡片上的应用图标：只有 src-tauri/icons/ 这一处来源，构建时复制一份。
cpSync(new URL("../src-tauri/icons/128x128.png", import.meta.url), new URL("../dist/app-icon.png", import.meta.url));
