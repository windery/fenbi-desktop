# 开发与实现说明

面向要改这个项目的人。**使用说明见 [README.md](README.md)**。

---

## 平台支持

三平台都能**构建**，但"构建通过"和"真机验证过"是两件事，分开记：

| 平台 | 构建 | 真机运行验证 |
| --- | --- | --- |
| macOS（ARM64 / x64） | CI 出包 | 主要开发平台，日常在用 |
| Windows x64 | CI 出包 | **未验证**（无真机记录） |
| Linux x64 | CI 出包 | **未验证**（无真机记录） |

代码里没有平台硬编码：

| 关注点 | 处理方式 |
| --- | --- |
| 快捷键 | mac 用 `metaKey`、Windows/Linux 用 `altKey`/`ctrlKey`，见「工具横栏与快捷键」 |
| 凭证读取 | `Webview::cookies()`，三平台行为一致 |
| 窗口全屏 | `.fullscreen(true)`，各平台原生语义 |

开发入口 `pnpm dev` 目前是 **Unix-only**（Bash + `pkill`，可执行文件路径也没带 `.exe`），
所以 Windows 上开发要用 `cargo build` + 手动启动。

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

三处必须一致，`release.yml` 里的 `verify-version` job 会校验：

| 文件 | 字段 |
| --- | --- |
| `package.json` | `version` |
| `src-tauri/Cargo.toml` | `package.version` |
| `src-tauri/tauri.conf.json` | `version` |

tag 名与它们保持一致（`v0.1.0` ↔ `0.1.0`）。改版本号后要重跑
`cargo build` 让 `Cargo.lock` 的元数据跟上，CI 会检查锁文件是否同步。

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

## 设计原则：只做展示层

wrapper **只负责**：

1. 启动时把窗口落到题库目录页
2. 裁剪与刷题无关的页面元素（只注入 CSS）
3. 在用户即将需要时**点击站点自己的登录入口按钮**，把站点的登录框带出来

wrapper **不碰站点的业务逻辑**：

- ❌ 不驱动答题、不提交试卷、不选分类、不读题目数据
- ❌ 不刷新页面、不参与站点的会话维护
- ❌ 不调用站点的私有接口，也不把站点数据带出窗口

第 3 条曾经被写成"不模拟点击"，但桌面端没有浏览器地址栏，站点自己的登录入口在页内，
所以点击登录按钮是必须的。边界在于**点的是站点自己暴露的入口**，而不是替用户完成业务动作。

### 用血换来的教训

最初的版本为了「登录后自动跳转」，加了一套 cookie 轮询 + 登录态判断 +
`location.reload()`。结果非常糟：用户扫码成功、站点正在建立会话的那一瞬间，
脚本执行了 `location.reload()`，把还没完成的登录流程直接刷掉。
表现就是「登录完马上又让我登录」。

**站点自己的登录流程本来完全正常，是 wrapper 的干预打坏了它。**

---

## 启动逻辑

### 先分清「登录态」的三个层次

这三层常被混为一谈，混淆是这类 bug 的主要来源：

| 层次 | 在哪 | 谁说了算 | 已知局限 |
| --- | --- | --- | --- |
| **登录记录** | app 数据目录的 `login-state` 文件 | wrapper 自己写 | 会过期；只是缓存 |
| **本地凭证信号** | Rust 调的 `Webview::cookies()` | 系统 WebView | 只说明 cookie 在，不说明服务端还认 |
| **网站真实会话** | 粉笔服务端 | 只有站点知道 | wrapper 无法观测 |

所以：**本地凭证存在 ≠ 已登录**。判定的目标是"这一层能观测到的最好证据"，
不是"服务端权威结论"。措辞和注释都不要写成后者。

### 判定时机

登录与否的**权威判定是「页面加载完成后检测一次」**，不是记录文件。
`login-state` 记录只是加速缓存，让启动路径 0 等待。

| 时刻 | 行为 |
| --- | --- |
| 0s（读记录） | 记录 `false` → 弹登录框；记录 `true` → 什么都不做，用户停在站点当前页面 |
| 页面加载完成 +1.5s | **权威判定**：读凭证 → 改写记录；若记录说已登录但实际未登录 → 弹框 |
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
| 已登录 → 凭证消失 | 记录改 `false` + 弹登录框（**不分页面**，做题页也一样） |
| 未登录 → 凭证出现 | 记录改 `true`；页面不跳转 |

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

### 已知假设（尚未在真实站点验证）

这些是当前实现依赖、但**没有实测证据**的判断。改动相关代码前先验证它们，
不要把它们当成既成事实：

| 假设 | 影响 | 怎么验证 |
| --- | --- | --- |
| 站点的心跳期间会话不会自行恢复（登出是单向的） | 心跳把 `true -> false` 之后不再回头；若站点能静默续期，会误判成登出 | 长时间挂着观察，或在 `FENBI_DEBUG_HEARTBEAT_MS` 缩短心跳后观察 |

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

### 站内跳转一律不纠正，目录页只作为冷启动入口

`init.js` 曾经在每次页面加载时做一次「不在目录页就 `location.replace` 回目录页」的
纠正（`goToCatalog`），登录成功后还有一次基于 `sessionStorage` 标记的补跳。
这套逻辑已经删掉：

- 站点把用户带到哪个粉笔页面都是正常的，wrapper 没有资格替他决定
- 旧逻辑会把刚打开的**搜索结果页**立刻顶掉，表现成"搜索点了没反应"

目录页现在只由窗口入口决定：`lib.rs` 用 `FENBI_ENTRY_URL`（默认 `FENBI_PRACTICE_URL`）
作为 `WebviewUrl::External`，冷启动必然落在目录页；之后站点去哪都不再干预。

### 新窗口请求：站内改当前窗口打开，站外丢弃

桌面端只有一扇窗口，也没有标签页。Tauri 在**没接 `on_new_window`** 时会丢掉所有
新窗口请求（macOS 返回 `None`，Windows `SetHandled(true)`），表现就是"点了没反应"。
粉笔搜题正是用 `window.open(..., "_blank")` 打开结果页，所以这个 handler 是必需的：

| 目标 | 处理 |
| --- | --- |
| `https://*.fenbi.com`、回环地址的 http（本地假站点） | 在当前窗口 `navigate` 过去 |
| 其余：站外 http/https、`javascript:` / `file:` / `data:` … | 丢弃，停在当前页 |

判定在 `login_state::new_window_allowed`，与 `entry_url_policy` 共用一套 host 规则，
单元测试覆盖了伪装域（`fenbi.com.evil.example` 不放行）。

⚠️ 这里**只**拦新窗口请求，同窗口的顶层导航没有拦截器。原因是 wry 在 macOS 上把
iframe 的导航也交给同一个回调，按 host 一刀切会误伤站内的第三方 iframe（验证码、
统计）。将来要拦同窗口跳转，先确认真实站点里有哪些跨域 iframe。

### 自定义命令

| 命令 | 注册条件 | 作用 |
| --- | --- | --- |
| `is_known_logged_in` | 始终 | 读登录记录；脚本据此决定要不要弹登录框 |
| `debug_request_logout` | 仅 debug 构建 | 驱动站点自己的「退出登录」，验证登出检测链路 |

就这两个。登录记录的**写入全部在 Rust 侧**（启动空窗期结论、心跳结论），
页面不再上报登录态——页面根本不知道登录态。

凭证判定用 `Webview::cookies()`（能读 HttpOnly，JS 读不到）。
通知页面只通过 `eval` 调 `window.__fenbiLoginSucceeded` / `window.__fenbiLoggedOut`，
**不刷新页面**。

`permissions/wrapper-commands.toml` 把两个命令都列进了 ACL，包括 debug 命令。
这不构成 release 的暴露面：release 下 `debug_request_logout` 根本没注册，
调用会直接被 Tauri 拒绝。真正的收窄（按构建模式隔离本地测试页授权）
要等确认过真实跳转域名之后再做，见「待做」。

`init.js` 里那个 `__TARGET_URL__` 占位符**不带引号**：Rust 用
`serde_json::to_string` 生成完整字符串字面量再替换进去，手工转义被彻底移除。
改占位符写法必须同时改 `lib.rs` 的替换逻辑（有测试盯着）。

### 仅 debug 构建存在的内部观察口

`DEBUG` 为真时（debug 构建，或 release + `FENBI_DEBUG=1`），`init.js` 会挂
`window.__fenbiWrapperInternals`，暴露判定状态与时间参数。
用途是让 JS 测试不必把生产代码里的时间常数抄一遍。**逻辑判断仍然只有一份实现**，
这个对象只是只读观察口。

### 工具横栏与快捷键

WebView 没有浏览器 chrome（地址栏、前进后退、刷新、主页），所以 `init.js` 在页面里
补一根横栏 + 一套快捷键，四个动作一一对应：

| 动作 | macOS | Windows / Linux | 实现 |
| --- | --- | --- | --- |
| 返回上一页 | `Cmd+[` | `Alt+←` | `history.back()` |
| 前进 | `Cmd+]` | `Alt+→` | `history.forward()` |
| 回题库 | `Cmd+⇧+[` | `Ctrl+⇧+[` | `location.replace(目录页)` |
| 刷新 | `Cmd+R` | `Ctrl+R` | `location.reload()` |

**横栏**插在 `<body>` 的第一个子节点：它在文档流里占位，把站点内容整体推下去，
因此不会盖住站点自己的 header（登录按钮/头像、题目页的返回箭头都在那里）。
收起态只留左上角一个 16px 高的小箭头，展开态 40px，按钮文字内联显示当前平台的键位。
样式放在 **Shadow DOM** 里：站点的全局 CSS 改不到按钮，我们的裁剪 CSS 也不会误伤它。
这是包装层唯一一处注入 DOM 的地方（其余只注入 CSS）。

展开/收起状态记在 `localStorage["fenbi-wrapper-toolbar"]`（跨页面加载保持，站点清掉就回到默认收起）。
**没有首次自动展开**：小箭头本身就是入口。

四个按钮**一律可点、不置灰**：Web 没有可靠的"能否前进"API，`history.length` 对 SPA 也不准，
所以没得去时就是点了没反应。

`init.js` **不再区分练习区**：登录提示、横栏、快捷键在所有页面一视同仁。
理由：站点自己实时上报答题数据，包装层不需要（也不该）替它判断"现在打不打扰"；
而"用户是不是在考试"包装层只能靠路径猜，猜错反而制造 bug。这条简化同时删掉了
`installRouteWatcher`——包装层不再 monkey-patch 站点的 `history.pushState`。

⚠️ 已知限制：横栏靠 `position: sticky` 置顶，只在 body（或它所在链路的滚动容器）
就是滚动容器时才会吸附；站点若把滚动放在内层 div，横栏会随页面滚走。这是"不追求美观"的取舍。

按键判定优先用 `e.code`（物理键，不受键盘布局影响），拿不到再退回 `e.key`。
捕获阶段监听并 `preventDefault`，不让按键漏给站点——实测站点自己没有任何全局
`keydown` 处理会 preventDefault（全部 3.55MB JS 完整检查过）。
注意不能用 `location.reload(true)` 做硬刷新——那个参数已废弃、会被静默忽略。

### UI 裁剪

`init.js` 顶部有一组选择器常量（`UI_TWEAKS` 默认 `true` 总开关）。只注入 CSS，
不碰站点逻辑。站点改版时选择器失效的表现只是"该隐藏的没隐藏"，不影响做题。

四组选择器，**按隐藏方式分类**，不能混：

| 常量 | 手法 | 用于 | 当前内容 |
| --- | --- | --- | --- |
| `HIDE_SELECTORS` | `display: none` | 整块移除、不留空间 | `app-award-exam-banner`（活动横幅） |
| `COLLAPSE_SELECTORS` | 不可见且尺寸归零 | 顶栏这类需要"让出宽度"的 flex 子项 | `nav.fb-web-nav`（顶栏 tab） |
| `HIDE_CONTENT_SELECTORS` | 不可见但**保留原始尺寸** | 清空内容、留下留白 | 页脚三段 |
| `SHRINK_HEIGHT_CSS` | 改高度 | 压掉页脚过厚的留白 | `fb-web-footer` 高度 50% |

把 `COLLAPSE_SELECTORS` 和 `HIDE_CONTENT_SELECTORS` 用反，就是踩过的坑：
前者必须让出宽度，后者一旦归零留白就没了。

**刻意保留**：`a.fenbi-icon-url`（logo）与 `.header-content-logon`（登录按钮 / 用户头像）。

> ⚠️ 不要隐藏整个 header。登录按钮和用户菜单都在 `.header-content-logon` 里，
> 隐藏了就没法登录、也没法退出登录。

> ⚠️ 顶栏不能用 `display: none`。`nav.fb-web-nav` 带 `flex-grow: 1`，它占满剩余空间、
> 把右侧头像顶到最右；一旦脱离 flex 流，logo 和头像会挤到一起。
> 所以用"不可见但仍占位"。

---

## 目录结构

```
.
├── AGENTS.md               # 面向 AI 助手的任务边界与验证要求
├── index.html              # 离线兜底页（正常启动不会显示）
├── package.json            # 只有 @tauri-apps/cli
├── tests/                  # 行为测试与模拟页面
└── src-tauri/
    ├── init.js             # 注入脚本：登录提示 + UI 裁剪 + 工具横栏与快捷键
    ├── init-debug.js       # 仅 debug 构建注入的诊断片段
    ├── permissions/
    │   └── wrapper-commands.toml   # app 命令的 ACL 声明
    ├── src/lib.rs          # 窗口、心跳、命令注册
    ├── src/login_state.rs  # 纯决策逻辑：凭证三态、路由分类、调度参数
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

已登录时（`[fenbi-wrapper]` 前缀是 Rust 的 stdout，`BEACON:` 是注入脚本送来的）：

```text
[fenbi-wrapper] watch start
[fenbi-wrapper] page load #1 -> settle in 1500ms
[fenbi-wrapper] settle: creds=Present record=Some(true)
[fenbi-wrapper] first settle done -> heartbeat every 300000ms
BEACON: record says logged in -> leave the site alone
```

记录说已登录、实际已登出（先按记录放行，随后判定纠正并弹框）：

```text
BEACON: record says logged in -> leave the site alone
[fenbi-wrapper] settle: creds=Absent record=Some(true)
[fenbi-wrapper] heartbeat: session gone
BEACON: logged out (session-lost)
BEACON: open login modal :: logged-out:session-lost
```

未登录启动（0 等待，按钮稍后渲染）：

```text
BEACON: record says logged out, prompt in 800ms
BEACON: login prompt cancelled :: button appeared
BEACON: open login modal :: not-logged-in
[fenbi-wrapper] settle: creds=Absent record=Some(false)
```

首次登录成功：

```text
BEACON: open login modal :: not-logged-in
[fenbi-wrapper] settle: creds=Present record=Some(false)
BEACON: login succeeded
```

会话失效 —— 所在页面立刻弹提示：

```text
[fenbi-wrapper] heartbeat: session gone
BEACON: logged out (session-lost)
BEACON: open login modal :: logged-out:session-lost
```

### 诊断信息刻意不记的东西

日志和 beacon 只带**事件、时间和路径**。完整 URL 的 query（`labelId`、试卷 id 等）
一律不发：那些字段会落到本机终端和文件里，属于不必要的用户信息扩散。
`lib.rs` 的 `on_page_load`、`init.js` 的启动日志、`init-debug.js` 的导航追踪都按这个规则写。
加新日志时请沿用。

窗口默认全屏（`lib.rs` 的 `.fullscreen(true)`）；想改成固定尺寸就换成 `.inner_size()`。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `FENBI_DEBUG=1` | 打开诊断日志（debug 构建默认已开） |
| `FENBI_PRACTICE_URL` | 覆盖跳转目标 |
| `FENBI_ENTRY_URL` | 覆盖窗口初始加载 URL，不设则等于目标 |
| `FENBI_DEBUG_DROP_AFTER=8000` | 仅 debug 构建：8 秒后驱动站点退出登录，用来验证登出检测 |
| `FENBI_DEBUG_HEARTBEAT_MS=10000` | 仅 debug 构建：把 5 分钟心跳缩短，便于测试 |
| `FENBI_INIT_JS` | **仅测试用**：让 JS 测试跑另一份 `init.js`（见「检查与测试」） |

两个 URL 覆盖会被校验：只接受 `https`，回环地址额外允许 `http`。
`file:` / `javascript:` 这类 scheme 会在建窗口之前就被拒绝。

后两个用于对着本地假站点验证，不需要真登录。

---

## 已验证的站点事实

改代码时可以参考。**每条都注明了验证平台与方式**；没写平台的都是 macOS 上的实测观察，
Windows / Linux 上的等价行为**未验证**。

复核方法：`FENBI_DEBUG=1` 打开诊断日志 + `CONTRIBUTING.md` 的排查一节里的本地 beacon，
或用 `FENBI_PRACTICE_URL` / `FENBI_ENTRY_URL` 指向本地模拟站点观察。站点改版后这些观察会过期，
以能复现的那次为准。

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
- **搜题走新窗口**：`window.open("/spa/tiku/guide/question/search?q=…&courseSet=…&qType=1", "_blank")`
  （相对 URL，由 WebView 解析成绝对地址）。Tauri 默认丢弃所有新窗口请求，
  所以包装层必须用 `on_new_window` 接住，否则搜索点了没反应
- **站点没有任何全局键盘快捷键**：catalog 当日返回的全部 3.55 MB JS（含 9 个懒加载 chunk，
  由子代理完整核对）里，`BracketLeft/BracketRight` 作为按键 0 次、`keyCode/which 219/221`
  0 次、`keydown.` 模板绑定 0 次；唯二会 `preventDefault` 的是搜索框自己的 Enter 与视频
  元素的方向键。所以包装层的横栏快捷键不会和站点抢键
- 题目标题页在 `spa.fenbi.com/ti/view/questions/solution?…`，自带 `a.back-btn`（回上一页）；
  搜索结果页回目录的入口是一个文本为当前分类名的 `a.quit-btn`（如「事考笔试 · 公基」）
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
  往 `init.js` 对应的选择器常量里加即可，改完不用重编译。
- **缩小远程授权面**：`capabilities/default.json` 目前放行整个 `https://*.fenbi.com`。
  收窄之前要先确认真实登录、目录、练习跳转会用到的域名，不能凭猜测改，
  否则会直接造成登录回归（见 [docs/improvement-proposal.md](docs/improvement-proposal.md) 第 4.2 节）。
- **离线恢复闭环**：根目录 `index.html` 目前只是占位，没有接进构建产物，
  也没有加载失败切换逻辑。

---

## 开发环境

```bash
pnpm dev      # 增量编译 + 启动，约 2-3 秒
pnpm check    # 提交前必跑
```

### 检查与测试

`pnpm check` 依次跑：`pnpm build`（建 `dist` 占位目录，`generate_context!` 编译期要读它）
→ JS 语法检查 → `cargo fmt --check` → `cargo clippy -D warnings` → Rust 测试 → JS 测试。
退出码如实反映失败，CI（`.github/workflows/check.yml`）调用的就是同一个入口。

| 测试 | 位置 | 覆盖什么 |
| --- | --- | --- |
| Rust 单元测试 | `src-tauri/src/login_state.rs`、`lib.rs` | 凭证三态判定、记录文件读写、入口 URL 与新窗口放行策略、判定动作（纯函数，不需要窗口） |
| JS 行为测试 | `tests/js/` | 弹窗次数、重试取消、目录防循环、横栏收起/展开与四个动作、四组快捷键 |

JS 测试用 `tests/js/harness.mjs` 这个最小 DOM + 可控时钟替身驱动真实的 `init.js`
（从磁盘读源码执行，不是复制一份逻辑），模拟页面放在 `tests/fixtures/`。
之所以不用 jsdom：这里真正要控制的是**时钟**和**导航**，而这两样在 jsdom 里都不可控。
模拟页面通过只证明包装层行为，**不能替代真实 WebView 里的登录验证**。

**不再有**跨语言共享的路由样例：练习区概念已删除，`inside_practice` 与
`tests/fixtures/routes.txt` 一并移除，Rust 与 JS 之间只剩「页面通知」这一处薄接口。

想确认某个用例真的拦得住缺陷（而不是恒真），可以拿旧版本跑一遍：

```bash
git show HEAD:src-tauri/init.js > /tmp/old-init.js
FENBI_INIT_JS=/tmp/old-init.js node --test
```

改登录时序、导航或页面注入时建议都做这一次对照：新用例必须在旧代码上变红。

开发**不要**用 `pnpm bundle`。两者耗时要分开看：

| 操作 | 耗时 | 用途 |
| --- | --- | --- |
| `pnpm dev`（debug 增量编译 + 启动） | ~2-3 秒 | 改代码、测试 |
| `pnpm check` | ~10 秒 | 提交前验证 |
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
