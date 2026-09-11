# 开发与实现说明

面向要改这个项目的人。**使用说明见 [README.md](README.md)**。

---

## 平台支持

macOS / Linux / Windows 三平台。代码里没有平台硬编码：

| 关注点 | 处理方式 |
| --- | --- |
| 快捷键 | `e.metaKey || e.ctrlKey`，mac 用 Cmd、其余用 Ctrl |
| 凭证读取 | `Webview::cookies()`，三平台行为一致 |
| 窗口全屏 | `.fullscreen(true)`，各平台原生语义 |

Windows 上有两个已知坑：

- Tauri 文档指出**同步命令里读 cookie 会死锁**（[wry#583](https://github.com/tauri-apps/wry/issues/583)）。
  本项目不在命令里读 cookie——`is_known_logged_in` 只读文件，
  凭证检测跑在独立线程里，所以不受影响。
- 首次运行需要 WebView2 运行时。已配置 `webviewInstallMode: downloadBootstrapper`，
  安装包会自动下载引导器。

Linux 依赖系统 WebKitGTK，`tauri.conf.json` 里已声明 deb 的 depends。
CI 里的 apt 依赖列表见 `.github/workflows/release.yml`。

---

## 发布

### 打 tag 触发

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 会并行构建四份产物（`.github/workflows/release.yml`）：

| 平台 | 产物 |
| --- | --- |
| macOS ARM64 | `.dmg`、`.app` |
| macOS x64 | `.dmg`、`.app` |
| Linux x64 | `.AppImage`、`.deb`、`.rpm` |
| Windows x64 | `.exe`（NSIS）、`.msi` |

**Release 建出来是 draft 状态**，需要去 Releases 页面点 Publish 才对外可见。
这是故意的：留一个检查产物的机会。

### 只支持 tag 触发（没有手动入口）

workflow 里刻意没有 `workflow_dispatch`。原因：Release 的 tag 名取自
`github.ref_name`，从分支手动跑会生成一个以分支名为 tag 的 draft Release，
是个容易踩的坑。要试构建就在本地跑 `pnpm bundle`。

### 版本号改哪里

`src-tauri/tauri.conf.json` 的 `version`。tag 名与它保持一致（`v0.1.0` ↔ `0.1.0`）。

### 签名

**当前完全未签名**，用户首次打开会被 Gatekeeper / SmartScreen 拦，README 里
写了绕过步骤。要启用签名的话接上 secrets，tauri-action 会自动使用：

- macOS：`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、
  `APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`
- Windows：`WINDOWS_CERTIFICATE`、`WINDOWS_CERTIFICATE_PASSWORD`
  （`tauri.conf.json` 里的 `windows.certificateThumbprint` 也要填）

### 跨平台验证的局限

CI 只保证**能构建出产物**，不保证三个平台都跑得起来。macOS 是主要开发与验证
平台；Windows / Linux 的实际运行需要真机测试。

---

## 为什么是目录页

`/spa/tiku/guide/catalog` 会由粉笔自己**恢复用户上次选择的题库分类**。
所以 wrapper 不需要知道用户刷的是行测还是事业单位，跳过去就行——
不必维护任何分类配置，站点改版换分类也不影响。

---

## 设计原则：不干预站点

wrapper **只负责**：

1. 启动时把窗口落到题库目录页
2. 裁剪与刷题无关的页面元素（只注入 CSS）

wrapper **不做**：

- ❌ 不接管登录流程
- ❌ 不刷新页面
- ❌ 不模拟点击
- ❌ 不参与站点的会话维护
- ❌ 不维护题库分类

### 用血换来的教训

最初的版本为了「登录后自动跳转」，加了一套 cookie 轮询 + 登录态判断 +
`location.reload()`。结果非常糟：用户扫码成功、站点正在建立会话的那一瞬间，
脚本执行了 `location.reload()`，把还没完成的登录流程直接刷掉。
表现就是「登录完马上又让我登录」。

**站点自己的登录流程本来完全正常，是 wrapper 的干预打坏了它。**

---

## 启动逻辑

登录与否的**权威判定是「页面加载完成后检测一次」**，不是记录文件。
`login-state` 记录只是加速缓存，让启动路径 0 等待。

| 时刻 | 行为 |
| --- | --- |
| 0s（读记录） | 记录 `false` → 立刻弹登录框；记录 `true` → 先进目录页 |
| 页面加载完成 +1.5s | **权威判定**：读凭证 → 改写记录；若记录说已登录但实际未登录，且不在练习区 → 弹框 |
| 之后每 5 分钟 | 心跳复查，捕捉运行中的登出 |

### 为什么权威判定放在页面加载之后

`sess` 是会话级 cookie，要靠落盘的 `persistent` 换取。页面加载完成时站点
已经把这一步做完了，所以此刻读到的就是最终状态——**这才是可信的检测时刻**。

启动路径不查凭证，正是为了绕开"页面还没加载完"那段空窗期：那时查必然读到
"未登录"，据此弹框就会误报。记录文件让启动路径不必等待，权威判定则保证正确性。

### 记录文件的角色

它只是**加速缓存**，不是真相来源：

- 它让启动路径 0 等待（不必先查凭证再决定）
- 它可能是过期的（上次退出后会话被服务端撤销），所以加载后必须判定并纠正
- 记录与检测结果不一致时，**以检测为准**，并改写记录

### 心跳

每 5 分钟复查一次凭证，用于捕捉运行中的登出（例如你在页面里点了「退出登录」）：

| 观察 | 动作 |
| --- | --- |
| 已登录 → 凭证消失，**不在练习区** | 记录改 `false` + 弹登录框 |
| 已登录 → 凭证消失，**在练习区** | 只改记录，**不弹框**（不打断做题） |
| 未登录 → 凭证出现 | 记录改 `true` + 进目录页 |

### 凭证认哪一个 cookie

**认 `persistent` / `sess` / `userid` 中任一存在**，这是实测校准过的：

| cookie | 生命周期 | 落盘 |
| --- | --- | --- |
| `persistent` | `Max-Age=31536000`（**1 年**） | 是 |
| `sess` | 会话级 | **否** |
| `userid` | 会话级 | **否** |

关键事实：`sess` **从不落盘**，只存在于内存、由 `persistent` 换取。
所以**不能只看 `sess`**——页面没重载时它可能一直不存在，据此判定"已登出"会误报。
反过来只看 `persistent` 也不行：若某次登录没下发它而 `sess` 有效，会误判成未登录。

### 设计取舍：为什么不做退出检测

曾经加过"程序退出时检测一次并写记录"，后来去掉了：

- 会话失效只有两种来源——**你主动登出**（页面内立刻可测）与**服务端撤销**（本地无从得知）
- 退出检测能覆盖的，加载后判定 + 心跳已经全覆盖
- 每多一套记录状态同步机制，就多一类不同步 bug；这个项目已经在这上面栽过几次

现在的原则是：**记录是缓存，检测是真相，机制越少越好。**

---

## 实现说明

### 窗口直接加载远程站点

`tauri.conf.json` 里 `app.windows` 是空数组，窗口在 Rust 侧创建：

```rust
WebviewWindowBuilder::new(app, "main", WebviewUrl::External(PRACTICE_URL.parse()?))
    .initialization_script(&script)
    .build()?;
```

`initializationScript` 不是 `WindowConfig` 的字段（已核对 `schema.tauri.app/config/2`），
它是 `WebviewWindowBuilder` 独有的方法。要让注入脚本生效，窗口必须走 builder 创建。

### 注入脚本能被外部站点调用，靠的是 capability 的 remote 配置

窗口加载的是 HTTPS 外部站点。capability 默认只对 `local` URL 生效，必须显式授权：

```json
"remote": { "urls": ["https://*.fenbi.com", "http://127.0.0.1:8850"] },
"permissions": ["core:default", "allow-wrapper-commands"]
```

自定义命令的权限在 `src-tauri/permissions/wrapper-commands.toml` 里声明，
由 `tauri-build` 生成清单。少了 `remote` 会报
`not allowed ... allowed on: [windows: "main", URL: local]`。

### 自定义命令

| 命令 | 作用 |
| --- | --- |
| `is_known_logged_in` | 读登录记录；脚本据此决定进目录页还是弹登录框 |

就这一个。登录记录的**写入全部在 Rust 侧**（启动空窗期结论、心跳结论），
页面不再上报登录态——页面根本不知道登录态。

凭证判定用 `Webview::cookies()`（能读 HttpOnly，JS 读不到）。
通知页面只通过 `eval` 调 `window.__fenbiLoginSucceeded` / `window.__fenbiLoggedOut`，
**不刷新页面**。

### 快捷键

WebView 没有浏览器的地址栏和快捷键，所以在 `init.js` 里自己实现：

| 快捷键 | 动作 |
| --- | --- |
| `Cmd+R` / `Ctrl+R` | 重新加载当前页 |

用捕获阶段监听 `keydown`，在站点自己的按键处理之前拦下。
注意不能用 `location.reload(true)` 做硬刷新——那个参数已废弃、会被静默忽略。

### UI 裁剪

`init.js` 里的 `UI_TWEAKS`（默认 `true`）和 `HIDE_SELECTORS`。只注入 CSS，
不碰站点逻辑。站点改版时选择器失效的表现只是"该隐藏的没隐藏"，不影响做题。

当前隐藏（选择器均实地核对过目录页 DOM）：

| 选择器 | 隐藏什么 |
| --- | --- |
| `nav.fb-web-nav` | 顶栏那排 tab：首页 / 课程 / 题库 / 关于粉笔 / 下载客户端 / 投资者关系 |
| `#fenbi-web-footer`、`.fb-footer-wrapper` | 页脚：关于我们 / 法律声明 / 二维码 / 客服热线 / 备案号 |

**刻意保留**：`a.fenbi-icon-url`（logo）与 `.header-content-logon`（登录按钮 / 用户头像）。

> ⚠️ 不要隐藏整个 header。登录按钮和用户菜单都在 `.header-content-logon` 里，
> 隐藏了就没法登录、也没法退出登录。

---

## 目录结构

```
.
├── index.html              # 离线兜底页（正常启动不会显示）
├── package.json            # 只有 @tauri-apps/cli
└── src-tauri/
    ├── init.js             # 注入脚本：登录检查 + 落页 + 可选 UI 裁剪
    ├── permissions/
    │   └── wrapper-commands.toml   # app 命令的 ACL 声明
    ├── src/lib.rs          # 窗口、登录标记、cookie 检查
    ├── src/main.rs         # 入口
    ├── capabilities/default.json   # 含 remote.urls 授权
    └── tauri.conf.json
```

---

## 排查

诊断日志默认关闭，用环境变量打开：

```bash
FENBI_DEBUG=1 open -a 粉笔刷题
```

日志通过本地 beacon 送出（HTTPS 页面不能 `fetch` localhost，但 `Image` 请求放行）。
另开一个终端收：

```bash
python3 - <<'EOF'
from http.server import BaseHTTPRequestHandler, HTTPServer
import urllib.parse
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        p = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        print("BEACON:", p.get('m', [''])[0], flush=True)
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', 8799), H).serve_forever()
EOF
```

已登录时：

```text
[fenbi-wrapper] watch start
[fenbi-wrapper] page load #1 -> settle in 1500ms
[fenbi-wrapper] verify after page load: creds=true record=Some(true)
[fenbi-wrapper] first settle done -> heartbeat every 300000ms
BEACON: record says logged in -> catalog
```

记录说已登录、实际已登出（先进目录页，随后判定纠正并弹框）：

```text
BEACON: record says logged in -> catalog
[fenbi-wrapper] verify after page load: creds=false record=Some(true)
BEACON: logged out (session-lost) -> open login modal
```

未登录启动（0 等待弹框）：

```text
BEACON: record says logged out -> open login modal
[fenbi-wrapper] verify after page load: creds=false record=Some(false)
```

首次登录成功：

```text
BEACON: open login modal :: not-logged-in
[fenbi-wrapper] verify after page load: creds=true record=Some(false)
BEACON: login succeeded -> go to catalog
```

窗口默认全屏（`lib.rs` 的 `.fullscreen(true)`）；想改成固定尺寸就换成 `.inner_size()`。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `FENBI_DEBUG=1` | 打开诊断日志（debug 构建默认已开） |
| `FENBI_PRACTICE_URL` | 覆盖跳转目标 |
| `FENBI_ENTRY_URL` | 覆盖窗口初始加载 URL，不设则等于目标 |
| `FENBI_DEBUG_DROP_AFTER=8000` | 仅 debug 构建：8 秒后驱动站点退出登录，用来验证登出检测 |
| `FENBI_DEBUG_HEARTBEAT_MS=10000` | 仅 debug 构建：把 5 分钟心跳缩短，便于测试 |

`FENBI_DEBUG_DROP_AFTER` 对应的命令用 `#[cfg(debug_assertions)]` 注册，
release 构建里不存在。

后两个用于对着本地假站点验证，不需要真登录。

---

## 已验证的站点事实

改代码时可以参考（全部实测）：

- 题库目录页：`/spa/tiku/guide/catalog`，会自己恢复上次选的分类
- 分类页路由模板：`/tiku/guide/home/{courseSet}/{prefix}`，SPA base href 为 `/tiku`
- `www.fenbi.com` 和 `spa.fenbi.com` 是同一套 SPA，共享存储
- 题库 API 域名：`tiku.fenbi.com`；登录 API 域名：`login.fenbi.com`
- 登录凭证是 HttpOnly cookie，域 `.fenbi.com`：
  `persistent` = `Max-Age=31536000`（1 年，落盘）；`sess` / `userid` = 会话级（**不落盘**，内存里由 `persistent` 换取）
- WKWebView 只把带 Expires/Max-Age 的 cookie 写进 `~/Library/HTTPStorages/*.binarycookies`
- **`sess` 是短命 session cookie，冷启动时由 `persistent` 恢复**，恢复需要一点时间。
  这段时间内 `sess` 不存在、页面头部也仍是未登录的渲染结果——**都不代表未登录**
- **localStorage 里没有任何登录信息**（登录后 `userinfo`、`logints` 均为 null）
- 登录框是常驻 DOM + `display` 控制显隐，判断"是否已弹出"必须判可见性
- 登录方式有三种：短信验证码、账号密码、扫码（`.qrcode-wrap` 切换）
- 未登录时点试卷**不会跳转**，停在原地弹登录框
- `login.fenbi.com/api/users/{info,current}` 在**未登录**时同样返回 `200` 加真实
  `userId`，绝不能用来判断登录态
- 站点存在两套环境：`fenbi.com`（线上）与 `fenbilantian.cn`（测试），按 hostname 切换
- macOS 上 Tauri 的 `initialization_script` 对外部 URL 同样生效（wry 用 `WKUserScript`
  在 `AtDocumentStart` 注入）

---

## 待做

- **窗口状态记忆**：目前每次启动都强制全屏（`lib.rs` 的 `.fullscreen(true)`）。
  如果希望记住上次的窗口尺寸/位置，需要接 `tauri-plugin-window-state`。
- **更多 UI 裁剪**：如果觉得练习页还有噪音（侧边栏推荐、活动横幅等），
  往 `init.js` 的 `HIDE_SELECTORS` 里加选择器即可，改完不用重编译。

---

## 开发环境

```bash
pnpm dev      # 增量编译 + 启动，约 2-3 秒
```

开发**不要**用 `pnpm bundle`。两者耗时要分开看：

| 操作 | 耗时 | 用途 |
| --- | --- | --- |
| `pnpm dev`（debug 增量编译 + 启动） | ~2-3 秒 | 改代码、测试 |
| `cargo build --release` | ~90 秒 | LTO 优化，只有交付才需要 |
| `pnpm bundle`（release + 打 DMG） | ~2 分钟 | 只有交付才需要 |

`pnpm dev` 会先 `cargo build`（顺带把 `init.js` 同步到 `target/debug/`），
再 `exec` 启动，所以它是原地替换进程、不会有残留实例。

### 改 `init.js` 不用重编译

debug 构建启动时**从磁盘读** `init.js` / `init-debug.js`（由 `build.rs` 拷到
`target/debug/`），所以调脚本只要重开 app：

```bash
cargo build --manifest-path src-tauri/Cargo.toml   # 秒级，只为同步脚本
./src-tauri/target/debug/fenbi-desktop
```

改 Rust 代码才需要真正重编译（增量也就几秒）。
release 构建仍然用 `include_str!` 内嵌脚本，产物自包含。

### 打包交付

```bash
pnpm bundle
```

产物：

- `src-tauri/target/release/bundle/macos/粉笔刷题.app`
- `src-tauri/target/release/bundle/dmg/粉笔刷题_0.1.0_aarch64.dmg`

打包完可以直接启动已构建的 app 来测，不必重新打 DMG：

```bash
open "src-tauri/target/release/bundle/macos/粉笔刷题.app"
```

### 想重新走一遍首次登录

```bash
rm -rf ~/Library/Application\ Support/com.fenbi.wrapper
```

### 想换入口页

改 `src-tauri/src/lib.rs` 顶部：

```rust
const PRACTICE_URL: &str = "https://www.fenbi.com/spa/tiku/guide/catalog";
```

其他可用路由（模板 `/tiku/guide/home/{courseSet}/{prefix}`）：

| 类目 | 路由 |
| --- | --- |
| 公务员 行测 | `/tiku/guide/home/xingce/xingce` |
| 公务员 申论 | `/tiku/guide/home/shenlun/shenlun` |
| 事业单位 笔试-公基 | `/tiku/guide/home/sydw/sydw?labelId=4147` |

但用目录页更好——它自己会恢复分类，不用你维护。
