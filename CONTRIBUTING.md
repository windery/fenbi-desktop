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
| 凭证读取 | `Webview::cookies_for_url()`，三平台行为一致 |
| 窗口尺寸 | 首次启动最大化（`.maximized(true)`），之后由 `tauri-plugin-window-state` 恢复上次的尺寸与位置 |

开发入口 `pnpm dev` 目前是 **Unix-only**（Bash + `pkill`，可执行文件路径也没带 `.exe`），
所以 Windows 上开发要用 `cargo build` + 手动启动。

Windows 上有两个已知坑：

- Tauri 文档指出**同步命令里读 cookie 会死锁**（[wry#583](https://github.com/tauri-apps/wry/issues/583)）。
  本项目不在命令里读 cookie——`current_login_decision` 只读内存快照，
  凭证读取跑在独立线程里，所以不受影响。
- 首次运行需要 WebView2 运行时。已配置 `webviewInstallMode: downloadBootstrapper`，
  安装包会自动下载引导器。

Linux 依赖系统 WebKitGTK，`tauri.conf.json` 里已声明 deb 的 depends。
CI 里的 apt 依赖列表见 `.github/workflows/release.yml`。

---

## 发布

### 打 tag 触发

```bash
git tag v0.1.1
git push origin v0.1.1
```

GitHub Actions 会并行构建四份产物（`.github/workflows/release.yml`）：

| 平台 | 产物 |
| --- | --- |
| macOS ARM64 | `.dmg`、`.app` |
| macOS x64 | `.dmg`、`.app` |
| Linux x64 | `.AppImage`、`.deb`、`.rpm` |
| Windows x64 | `.exe`（NSIS） |

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

tag 名与它们保持一致（`v0.1.1` ↔ `0.1.1`）。改版本号后要重跑
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

### 先分清「登录态」的两个层次

这两层常被混为一谈，混淆是这类 bug 的主要来源：

| 层次 | 在哪 | 谁说了算 | 已知局限 |
| --- | --- | --- | --- |
| **本地凭证信号** | Rust 调的 `Webview::cookies_for_url()` | 系统 WebView | 只说明 cookie 在，不说明服务端还认 |
| **网站真实会话** | 粉笔服务端 | 只有站点知道 | wrapper 无法观测 |

所以：**本地凭证存在 ≠ 已登录**。观察的目标是"这一层能观测到的最好证据"，
不是"服务端权威结论"。措辞和注释都不要写成后者。

### 观察时机

登录观察只在**页面 `Finished` 之后**起一轮窗口，观察结果只存在内存里，不落盘：

| 时刻 | 行为 |
| --- | --- |
| 页面 `Started` | 旧观察立刻作废，当前结果置为 `pending`（未知），暂停观察与心跳 |
| `Finished` 后等 1500ms | 等待观察窗口，**窗口内不读 cookie**；窗口结束后读一次 cookie，作为这一代页面的本地观察 |
| 读取成功但无已知凭证（`Absent`）/ 读到已知凭证（`Present`） | 更新内存快照；结果变化时唤醒页面重读当前结果 |
| 读取失败（`Unknown`：cookie 读取调用失败） | 不改快照、不新增提示，500ms 后重试 |
| 之后每 5 分钟 | 心跳复查，**双向**捕捉凭证出现/消失 |

1500ms 只是给站点一点时间把会话恢复出来的**本地观察窗口**，不是会话恢复完成的保证；
本地读到凭证也不等于服务端仍接受它。

### 为什么在 `Finished` 之后观察

`sess` 是会话级 cookie，要靠落盘的 `persistent` 换取。加载期间凭证状态可能尚未稳定，
不能据暂时缺少凭证做启动提示；据此写 `false`、弹框都是误报。所以：

- 页面 `Started` 一律不读，先把这一代结果清成 `pending`
- 只有 `Finished` 之后才允许起观察窗口
- 窗口内不读 cookie；窗口结束后读取失败（`Unknown`）保持未知，500ms 后重试而不是下结论

### 为什么没有登录记录文件

早期版本把每次观察结果写进 app 数据目录的 `login-state` 文件。后来它退化成
"只写不读"：启动时读出来的值只用来决定要不要再写一次同样的内容，判定、弹框、
心跳都不依赖它。一个不参与决策的持久化状态只会制造"文件说登录了、站点说没有"
这类假问题，所以整个删掉了。**现在包装层唯一落盘的状态是工具栏的收起偏好和窗口位置。**

### 心跳

每 5 分钟复查一次凭证，双向捕捉运行中的凭证变化：

| 观察 | 动作 |
| --- | --- |
| `Present` → 凭证消失（`Absent`） | 快照改 `logged-out`，唤醒页面处理（**不分页面**，做题页也一样） |
| `Absent` → 凭证出现（`Present`） | 快照改 `logged-in`，唤醒页面取消待执行的提示；页面不跳转 |

### 凭证认哪一个 cookie

**认 `persistent` / `sess` / `userid` 中任一存在**，这是实测校准过的。
只看粉笔域下的 cookie（`cookies_for_url(PRACTICE_URL)`）：站内第三方 iframe 若恰好也有
同名 cookie，不能把它当成粉笔凭证。

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
- 退出检测能覆盖的，加载后观察 + 心跳已经全覆盖
- 每多一套记录状态同步机制，就多一类不同步 bug；这个项目已经在这上面栽过几次

现在的原则是：**机制越少越好——观察结果只活在内存里，任何时候都不拿它当服务端会话的结论。**

---

## 实现说明

### 一个窗口、两个 WebView

`tauri.conf.json` 的 `app.windows` 为空，Rust 用 `WindowBuilder` 创建窗口，再用 `Window::add_child` 添加本地 `toolbar` 与远程 `main` 两个 WebView。网站脚本通过 `WebviewBuilder::initialization_script` 注入，工具栏通过本地 HTML 加载。初始布局与缩放均由 Rust 控制，内容区域从工具栏底部开始。窗口首次启动最大化，之后由 `tauri-plugin-window-state` 在建窗后 `restore_state` 恢复上次的尺寸、位置与最大化状态（关窗时自动保存到 app 数据目录）。

### 注入脚本能被外部站点调用，靠的是 capability 的 remote 配置

窗口加载的是 HTTPS 外部站点。capability 默认只对 `local` URL 生效，必须显式授权：

```json
"remote": { "urls": ["https://*.fenbi.com", "https://fenbi.com"] },
"webviews": ["main"],
"local": false,
"permissions": ["allow-wrapper-commands", "allow-toggle-toolbar"]
```

`*.fenbi.com` 不匹配裸域，而 `new_window_allowed` 会放行 `https://fenbi.com/...`，
所以裸域单独列一条，否则跳过去之后注入脚本的 invoke 会被 ACL 静默拒绝。

自定义命令的权限在 `src-tauri/permissions/wrapper-commands.toml` 里声明，
由 `tauri-build` 生成清单；新增应用命令还需在 `build.rs` 的 `AppManifest::commands` 注册。缺少 `remote` 会导致网站调用被 ACL 拒绝。

**授权按构建模式分开**：`capabilities/*.json` 是 release 也带的；`capabilities/dev/` 里的
回环地址授权（`http://127.0.0.1:8850`，对着本地假站点验证用）和 `allow-debug-logout`
只在 debug 构建编进去——`build.rs` 按 `PROFILE` 选 `capabilities_path_pattern`，
release 只读顶层目录。

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

判定在 `login_state::new_window_allowed`：https 只放行粉笔域名，http 只放行回环地址。
它与 `entry_url_policy` **不共用 host 规则**——入口 https 允许任意 host，新窗口 https 只放行粉笔。
单元测试覆盖了伪装域（`fenbi.com.evil.example` 不放行）。

⚠️ 这里**只**拦新窗口请求，同窗口的顶层导航没有拦截器。原因是 wry 在 macOS 上把
iframe 的导航也交给同一个回调，按 host 一刀切会误伤站内的第三方 iframe（验证码、
统计）。将来要拦同窗口跳转，先确认真实站点里有哪些跨域 iframe。

### 自定义命令

| 命令 | 注册条件 | 作用 |
| --- | --- | --- |
| `current_login_decision` | 始终 | 返回当前观察快照 `[seq, kind]`（`kind`：`pending` / `logged-in` / `logged-out`）；脚本据此决定弹不弹登录框 |
| `debug_request_logout` | 仅 debug 构建 | 驱动站点自己的「退出登录」，验证登出检测链路 |

就这两个。观察**全部在 Rust 侧**（页面加载后的观察、心跳观察），
页面不上报登录态，只在被唤醒时重读 Rust 的当前结果。

凭证读取用 `Webview::cookies_for_url()`（能读 HttpOnly，JS 读不到；只取粉笔域），在锁外进行；
拿回结果后在锁内核对页面代号，过期结果不改结论。
唤醒页面只通过 `eval` 调 `window.__fenbiRefreshLoginDecision()`，**不带结论、不刷新页面**；
页面被唤醒后自己重读当前结果，所以落在旧页面上的唤醒不会把上一代的结论带进新页面。

`permissions/wrapper-commands.toml` 把 debug 命令单独声明成 `allow-debug-logout`，
只被 `capabilities/dev/` 引用；release 下它既没注册也没授权。

`init.js` 里那个 `__TARGET_URL__` 占位符**不带引号**：Rust 用
`serde_json::to_string` 生成完整字符串字面量再替换进去，手工转义被彻底移除。
改占位符写法必须同时改 `lib.rs` 的替换逻辑（有测试盯着）。

### 页面侧的登录提示状态机

`init.js` 不再按本地记录在固定延迟后弹框，提示完全由 Rust 的观察快照驱动：

- `DOMContentLoaded` 后重读一次 `current_login_decision`；Rust 唤醒只调
  `__fenbiRefreshLoginDecision`，页面再重读。就绪前到达的唤醒不单独排队——
  `start()` 的那次重读拿到的快照至少和它一样新，早期通知不会丢
- 读回的 `[seq, kind]` 按 `seq` 去重：较旧或重复的序号一律丢弃
- `pending`：取消还没执行的「等按钮」重试，不新增提示，也不碰已经 `requested` 的闩锁
- `logged-in`（`Present`）：取消所有待执行的提示
- `logged-out`（`Absent`）：进入提示状态机；同一轮里只点一次登录按钮

一个"轮"由凭证变化划定：发出一次请求后，同一轮里的重复 `Absent` 合并；只有真正
观察到 `Present` 之后的 `Absent` 才开新一轮。登录框消失或时间流逝本身不算一轮结束。
按钮还没渲染出来时每 250ms 重试、最多 24 次；预算用尽后即便再收到重复通知也不重置。
包装层不因登录态变化做任何自动导航或刷新。

### 仅 debug 构建存在的内部观察口

`DEBUG` 为真时（debug 构建，或 release + `FENBI_DEBUG=1`），`init.js` 会挂
`window.__fenbiWrapperInternals`，暴露提示状态机与时间参数。
用途是让 JS 测试不必把生产代码里的时间常数抄一遍。**逻辑判断仍然只有一份实现**，
这个对象只是只读观察口。

### 工具横栏与快捷键

一个原生窗口包含两个 child WebView：`toolbar` 加载本地工具栏，`main` 加载粉笔网站。
Rust 负责布局和受限命令；网站仍由 `init.js` 注入快捷键与裁剪 CSS。按钮与快捷键对应：

| 动作 | macOS | Windows / Linux | 实现 |
| --- | --- | --- | --- |
| 返回上一页 | `Cmd+[` | `Alt+←` | `history.back()` |
| 前进 | `Cmd+]` | `Alt+→` | `history.forward()` |
| 回题库 | `Cmd+⇧+[` | `Ctrl+⇧+[` | 将目录页加入历史记录；已在目录页时不重复加载 |
| 刷新 | `Cmd+R` | `Ctrl+R` | `location.reload()` |
| 展开 / 收起横栏 | `Cmd+⇧+B` | `Ctrl+⇧+B` | 切换应用的 `toolbar-state` 偏好 |

**键位只有一处定义**：`src-tauri/toolbar/shortcuts.js` 的 `KEY_BINDINGS`。同一张表既生成匹配逻辑
（`shortcutAction` / `bindingMatches`），也生成悬停或键盘聚焦时在横栏空白处显示的提示文字（`bindingLabel`）。
**不要再手写键位提示字符串**——曾经这里是两份实现，于是「收起 ⌃」写着一个根本没有绑定的键
（`⌃` 在 mac 上是 Control，而什么都没绑），按下去毫无反应。

**横栏独立于网站 DOM**：本地 `toolbar/index.html` 加载自己的 CSS 和脚本，不使用 Shadow DOM 或 sticky。Rust 按窗口逻辑尺寸划分 36px 展开横栏与剩余内容区域，收起时高度为 24px。网站滚动、刷新和整页跳转都不会重建工具栏。
展开态是平整的白色细条，左侧四个仅图标 SVG 按钮、右侧收起按钮；蓝色只用于强调和交互反馈。按钮保留无障碍名称，悬停、按下、键盘聚焦有清晰反馈；悬停或聚焦时在横栏空白处显示操作名称与当前平台快捷键。正式 UI 不显示当前 URL 等调试行。
状态读取失败时显示可点击的「重试工具栏」，命令被拒绝时显示简短错误；技术细节留在控制台。

**权限按 WebView 授予**：`toolbar` 仅有本地工具栏状态和导航权限；`main` 的粉笔远程页面只获登录判定与切换工具栏权限。不能用 `windows: ["main"]` 为整个窗口授权，否则两个 WebView 都会获权。应用命令通过 `AppManifest::commands` 纳入 ACL，导航命令还检查调用者标签。

**平台约束**：Tauri 2.11.5 的多 WebView API 需启用 `unstable`。macOS 使用 Transparent 标题栏，避免默认 Visible 的 FullSizeContentView 把 child WebView 挤到标题栏下面；没有硬编码系统标题栏高度。主窗口 Resized / ScaleFactorChanged 统一重新布局。仍需 Windows/Linux 实机验收。

**展开/收起是同一个控件**（`.fenbi-toolbar-toggle`）：始终在横栏最右，点击与快捷键共用
`runShortcut("toggle")`。收起后横栏是一条 24px 的点击区，右侧显示明确的「展开」把手；
点这条横栏任意位置都能展开。

行为测试验证按钮与快捷键的动作一致性、收起态整条可点、状态读取失败后的重试及命令失败提示。

偏好存于应用数据目录的 `toolbar-state`，由 Rust 管理，整页跳转不会改变它；状态版本号防止异步读取乱序回退布局。首次迁移默认展开，不读取原先粉笔域名下的 localStorage。网站凭证及原 `main` WebView 标签保持不变，不启用无痕模式或更换数据目录。

四个按钮**一律可点、不置灰**：Web 没有可靠的"能否前进"API，`history.length` 对 SPA 也不准，
所以没得去时就是点了没反应。

`init.js` **不再区分练习区**：登录提示、横栏、快捷键在所有页面一视同仁。
理由：站点自己实时上报答题数据，包装层不需要（也不该）替它判断"现在打不打扰"；
而"用户是不是在考试"包装层只能靠路径猜，猜错反而制造 bug。这条简化同时删掉了
`installRouteWatcher`——包装层不再 monkey-patch 站点的 `history.pushState`。

按键判定优先用 `e.code`（物理键，不受键盘布局影响），拿不到再退回 `e.key`。
捕获阶段监听并 `preventDefault`，不让按键漏给站点——实测站点自己没有任何全局
`keydown` 处理会 preventDefault（全部 3.55MB JS 完整检查过）。
注意不能用 `location.reload(true)` 做硬刷新——那个参数已废弃、会被静默忽略。

### UI 裁剪

`init.js` 顶部有一组选择器常量（`UI_TWEAKS` 默认 `true` 总开关）。只注入 CSS，
不碰站点逻辑。站点改版时选择器失效的表现只是"该隐藏的没隐藏"，不影响做题。

五组选择器，**按隐藏方式分类**，不能混：

| 常量 | 手法 | 用于 | 当前内容 |
| --- | --- | --- | --- |
| `HIDE_SELECTORS` | `display: none` | 整块移除、不留空间 | 活动横幅；`.member-area`（会员卡入口 + 悬停扫码卡片）；`#userlogout a.popover-content`（我的课程）；`i.paper-tag-help` |
| `COLLAPSE_SELECTORS` | 不可见且尺寸归零 | 顶栏这类需要"让出宽度"的 flex 子项 | `nav.fb-web-nav`（顶栏 tab） |
| `HIDE_CONTENT_SELECTORS` | 不可见但**保留原始尺寸** | 清空内容、留下留白 | 页脚三段 |
| `NON_INTERACTIVE_SELECTORS` | **保留可见**、只去掉点击 | 留着占位但不能再导航的入口 | `a.fenbi-icon-url`（logo） |
| `SHRINK_HEIGHT_CSS` | 改高度 | 压掉页脚过厚的留白 | `fb-web-footer` 高度 50% |

把 `COLLAPSE_SELECTORS` 和 `HIDE_CONTENT_SELECTORS` 用反，就是踩过的坑：
前者必须让出宽度，后者一旦归零留白就没了。

**会员卡**（「职测会员卡 / 尚未开通」）的扫码弹窗是**悬停**出来的，但卡片就在
`.member-area` 内部（`article.buy-member-app-popup > fenbi-member-card`），
所以摘掉入口即可，不需要单独处理弹窗；结构常驻、靠透明度显隐，只注入 CSS 就够。

**刻意保留可见但不可点**：`a.fenbi-icon-url`（logo）。整块拿掉会让顶栏左端空一截，
而它原本跳 fenbi.com 首页，属于"离开刷题"的入口。做法是
`NON_INTERACTIVE_SELECTORS`（`pointer-events: none` + `cursor: default`），
鼠标点击与键盘 Enter 激活都会失效；`href` 仍在 DOM 里（本层只注入 CSS，不动站点节点）。

**必须完整保留**：`.header-content-logon`（登录按钮 / 用户头像 / 退出登录）。
用户菜单只藏了 `#userlogout a.popover-content` 这一条——账号行与「退出登录」都是
`div.popover-content`，不在这条选择器的作用范围内，所以退出登录照旧可用。

> ⚠️ 不要隐藏整个 header。登录按钮和用户菜单都在 `.header-content-logon` 里，
> 隐藏了就没法登录、也没法退出登录。

> ⚠️ 顶栏不能用 `display: none`。`nav.fb-web-nav` 带 `flex-grow: 1`，它占满剩余空间、
> 把右侧头像顶到最右；一旦脱离 flex 流，logo 和头像会挤到一起。
> 所以用"不可见但仍占位"。

> ⚠️ 选择器要**不带 Angular 作用域哈希**（`.member-area` 上是 `ng-tns-c38-0` 这类），
> 否则站点下次构建哈希一变就失配。

**CSS 文本有测试盯着，效果没测**：`tests/js/page-tweaks.test.mjs` 的裁剪用例只断言
注入的那份 CSS 里写了哪些选择器与手法——harness 没有 CSS 引擎，算不出真实效果。
真实页面上的表现按下面的「UI 裁剪怎么复核」人工核对。

### UI 裁剪怎么复核

CSS 选择器只能对着**真实页面**定，`pnpm check` 证明不了它们还命中。加或改选择器时：

1. 用 ego-browser 打开 `https://www.fenbi.com/spa/tiku/guide/catalog`（登录态），
   在 `page.evaluate` 里按 class 读 `getBoundingClientRect()` 与 `getComputedStyle()`，
   确认盒子、`href`、显隐；
2. 涉及时显时隐的元素（用户菜单、会员卡悬停卡片）要真的把鼠标移上去/点开，
   再读一次 DOM——它们的结构常驻，只看初始状态会误判；
3. 改完在 App 里人工过一遍「必须保护的用户流程」那条清单：登录、退出登录、
   切考试类型、搜题、进练习页都要照旧。

实测记录（2026-09-12，macOS，已登录）见下面「已验证的站点事实」。

---

## 目录结构

```
.
├── AGENTS.md               # 面向 AI 助手的任务边界与验证要求
├── scripts/build-ui.mjs    # 本地工具栏资源复制到 dist
├── package.json            # 只有 @tauri-apps/cli
├── tests/                  # 行为测试与模拟页面
└── src-tauri/
    ├── init.js             # 网站注入脚本：登录提示 + UI 裁剪 + 快捷键
    ├── init-debug.js       # 仅 debug 构建注入的诊断片段
    ├── permissions/
    │   └── wrapper-commands.toml   # app 命令的 ACL 声明
    ├── src/lib.rs          # 窗口、观察调度线程、命令注册
    ├── toolbar/            # 本地工具栏 HTML/CSS/JS，共享快捷键表
    ├── src/toolbar.rs      # 双 WebView 布局、工具栏命令与状态
    ├── src/login_state.rs  # 纯逻辑：凭证三态、Started/Finished 观察调度、路由分类
    ├── src/main.rs         # 入口
    ├── capabilities/default.json   # 含 remote.urls 授权（release 也带）
    ├── capabilities/dev/           # 仅 debug 构建：回环地址与诊断命令授权
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
BEACON: login decision :: 1 pending
BEACON: login decision :: 2 logged-in
```

记录说已登录、实际已登出（观察到 `Absent` 后记录被纠正，页面弹框）：

```text
BEACON: login decision :: 1 pending
BEACON: login decision :: 2 logged-out
BEACON: open login modal :: logged-out
```

未登录启动，按钮稍后渲染：

```text
BEACON: login decision :: 1 pending
BEACON: login decision :: 2 logged-out
BEACON: login prompt cancelled :: button appeared
BEACON: open login modal :: logged-out
```

用户手动登录成功（页面重载或心跳观察到 `Present`）：

```text
BEACON: login decision :: 3 logged-in
```

会话失效 —— 所在页面立刻弹提示：

```text
BEACON: login decision :: 4 logged-out
BEACON: open login modal :: logged-out
```

### 诊断信息刻意不记的东西

日志和 beacon 只带**事件、时间和路径**。完整 URL 的 query（`labelId`、试卷 id 等）
一律不发：那些字段会落到本机终端和文件里，属于不必要的用户信息扩散。
`lib.rs` 的 `on_page_load`、`init.js` 的启动日志、`init-debug.js` 的导航追踪都按这个规则写。
加新日志时请沿用。

窗口首次启动最大化，之后记住上次尺寸；想固定尺寸就删掉 `lib.rs` 的 `restore_state` 并改 `.inner_size()`。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `FENBI_DEBUG=1` | 打开诊断日志（debug 构建默认已开） |
| `FENBI_PRACTICE_URL` | 覆盖跳转目标 |
| `FENBI_ENTRY_URL` | 覆盖窗口初始加载 URL，不设则等于目标 |
| `FENBI_DEBUG_DROP_AFTER=8000` | 仅 debug 构建：8 秒后驱动站点退出登录，用来验证登出检测 |
| `FENBI_DEBUG_HEARTBEAT_MS=10000` | 把 5 分钟心跳缩短，便于测试 |
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

**目录页的推广 / 无关入口（2026-09-12 用 ego-browser 实测，已登录，同一份 DOM 读的盒子）**：

| 元素 | 实测 | 说明 |
| --- | --- | --- |
| `a.fenbi-icon-url` | 80×40，`href=https://www.fenbi.com/` | logo，跳首页 |
| `.member-area` | 83×28 | 内含 `app-exam-member-tag.member-icon.member-icon-off`（"尚未开通"）与 `article.buy-member-app-popup > fenbi-member-card`（280×268 扫码卡片） |
| `#userlogout` | `div.popover.bottom` | 用户菜单：`div.popover-content`（账号）、`a.popover-content`（我的课程，`target=_blank` → `/spa/pwa/tourist/gwy`）、`div.popover-content`（退出登录） |
| `i.paper-tag-help` | 10×10 | 帮助问号；实测挂在 `app-award-exam-banner` 内部（不是顶栏） |
| `.current-exam` / `.question-search-area` | 181×36 / 250×34 | 当前考试（可下拉切换）+ 搜题框，做题必需，**不要动** |
| `a.cube-module-button` | 24×24，`href=//spa.fenbi.com/cube-module-cms/` | 「粉笔魔方」，**明确保留**，是实用功能不是广告 |

- 用户菜单里的「我的课程」是**唯一**一个 `<a class="popover-content">`，账号行与退出登录
  都是 `div.popover-content`——菜单项的 class 完全一样，标签是唯一稳定的区分点
- 会员卡的悬停弹窗（`.buy-member-app-popup`）**结构常驻**，靠透明度/尺寸显隐；
  实测悬停前后 `opacity` 变化。所以它不需要 JS 移除，摘掉 `.member-area` 即可
- `.member-area`、`app-exam-member-tag`、`.buy-member-app-popup` 在目录页各只出现 1 次
  且互为父子，所以整块隐藏是安全的，也不会留下空白
- `a.cube-module-button`（粉笔魔方）**不要加进隐藏列表**：它是实用功能，不是推广位。
  `tests/js/page-tweaks.test.mjs` 的「别误伤」用例按字面盯着这条
- 该页共 23 个链接，除上表之外没有别的同类推广位

---

## 待做

- **更多 UI 裁剪**：目录页的推广位与无关入口已清过一轮（见上方「已验证的站点事实」）。
  练习页的噪音（侧边栏推荐、活动横幅等）还没动——往 `init.js` 对应的选择器常量里加，
  改完不用重编译；选择器要先按「UI 裁剪怎么复核」在真实页面上核对。
- **缩小远程授权面**：`capabilities/default.json` 目前放行整个 `https://*.fenbi.com`。
  收窄之前要先确认真实登录、目录、练习跳转会用到的域名，不能凭猜测改，
  否则会直接造成登录回归。
- **加载失败页**：断网冷启动时内容区是系统 WebView 的空白/错误页，没有包装层自己的提示。
  工具栏的「刷新」按钮在这种状态下仍可用，所以恢复路径是存在的，只是不好看。
  Tauri 目前没有稳定的加载失败回调，做的话要先确认三平台都能拿到失败信号。
- **Windows 开发入口**：`pnpm dev` 是 Bash + `pkill`，Windows 上要 `cargo build` 后手动启动。
- **三平台实机冒烟**：Windows / Linux 只验证过构建，启动、登录、重启恢复、退出都没有真机记录。

---

## 开发环境

```bash
pnpm dev      # 增量编译 + 启动，约 2-3 秒
pnpm check    # 提交前必跑
```

### 检查与测试

`pnpm check` 依次跑：`pnpm build`（把本地工具栏资源复制到 `dist`，`generate_context!` 编译期读取）
→ JS 语法检查（`node --check`）→ JS 测试（`node --test`）→ `cargo fmt --check`
→ `cargo clippy -D warnings` → Rust 测试。
退出码如实反映失败，CI（`.github/workflows/check.yml`）调用的就是同一个入口。

| 测试 | 位置 | 覆盖什么 |
| --- | --- | --- |
| Rust 单元测试 | `src-tauri/src/login_state.rs`、`lib.rs`、`toolbar.rs` | 凭证三态、`Started`/`Finished` 观察窗口、过期读取丢弃、入口 URL、新窗口策略、工具栏来源检查与分区尺寸（纯函数，不需要窗口） |
| JS 行为测试 | `tests/js/` | 弹窗次数、序号去重与轮次、重试取消与预算、目录防循环、工具栏 IPC 动作、收起状态与异步乱序、五组快捷键、网站不注入工具栏 DOM |

JS 用例按登录提示、工具栏、导航快捷键与页面裁剪拆在 `tests/js/`，测试地图与单独运行方式见 [tests/README.md](tests/README.md)。
共用的 `tests/support/browser-env.mjs` 用最小 DOM + 可控时钟替身执行真实的 `init.js`、`toolbar.js` 和快捷键脚本；
启动辅助在 `tests/support/boot.mjs`，模拟页面放在 `tests/fixtures/`。
替身按需控制时钟和导航历史；它不执行浏览器布局，也不访问粉笔站点。
模拟页面通过只证明包装层行为，**不能替代真实 WebView 里的登录验证**。

**不再有**跨语言共享的路由样例：练习区概念已删除，`inside_practice` 与
`tests/fixtures/routes.txt` 一并移除，登录链路用 `current_login_decision` 快照与 `__fenbiRefreshLoginDecision` 唤醒；工具栏另有独立命令与状态接口。

想确认某个用例真的拦得住缺陷（而不是恒真），可以拿**修改前的工作区快照**跑一遍。
不要无条件用 `git show HEAD:src-tauri/init.js`：那会丢掉工作区里未提交的修改。
改代码前先复制一份：

```bash
snapshot="$(mktemp -t fenbi-init.XXXXXX.js)"
cp src-tauri/init.js "$snapshot"
# 然后修改 src-tauri/init.js，用快照跑测试
FENBI_INIT_JS="$snapshot" node --test
```

对照的判据是**新用例按缺陷行为失败**：旧实现必须出现预期的错误行为。
接口缺失或测试环境不兼容导致的失败不算复现，只说明这份快照跑不了该用例——
不能据此宣称所有新版协议测试都能原样跑在旧版上。

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

debug 构建启动时**从磁盘读** `init.js` / `init-debug.js` / `shortcuts.js`（由 `build.rs` 拷到
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
- `src-tauri/target/release/bundle/dmg/粉笔刷题_0.1.1_aarch64.dmg`

打包完可以直接启动已构建的 app 来测，不必重新打 DMG：

```bash
open "src-tauri/target/release/bundle/macos/粉笔刷题.app"
```

### 想重新走一遍首次登录

登录会话在系统 WebView 里，不在 app 数据目录，所以这个目录里只有工具栏偏好和窗口位置；
想重新登录直接在页面里点「退出登录」。

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

### 独立工具栏迁移验收

原型证据：`../fenbi-toolbar-prototype` 的 `codex/toolbar-prototype` 分支；macOS 原生 WebView 验证过导航、收起展开、全屏、窗口缩放及内容页越权拒绝。正式迁移保留原有登录观察状态机与 cookie 存储，不能把原型的无痕设置带进来。

修改本地工具栏后用 `pnpm dev` 重新复制资源并编译；`pnpm check` 检查真实脚本和 Rust。模拟页面通过不能替代真实登录、做题和报告页验证。

2026-09-23 **旧版独立工具栏迁移验收**：`pnpm check` 通过（45 项 JS、30 项 Rust，含 fmt/clippy）。当时的 macOS 原生开发版确认已登录冷启动、刷新后保持会话、页面裁剪、独立工具栏收起展开、网站焦点下 Cmd+Shift+B、全屏退出及重启后收起偏好恢复；没有 URL/加载状态调试行。这条记录不代表本次 36px / 24px 工具栏重做已在真实 WebView 中验证。当时未执行登出、扫码、答题或报告操作，Windows/Linux 也尚未实机验证。

2026-09-29 **36px / 24px 工具栏重做验收**：`pnpm check` 通过（51 项 JS、30 项 Rust，含 fmt/clippy），界面静态质量检查未报问题。macOS 未签名调试版确认全屏与窗口缩放时两个 WebView 无重叠、两种工具栏高度正常、重启后收起偏好恢复、展开后焦点回到网站。从一项已有练习分别用工具栏按钮和网站侧快捷键回题库，再返回，均回到原练习地址；未选答案或交卷。状态读取失败、命令失败和收起条空白区域点击由 JS 行为测试覆盖。Windows/Linux 尚未实机验证。
