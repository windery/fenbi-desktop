# 开发与实现说明

面向要改这个项目的人。**使用说明见 [README.md](README.md)**。

---

## 平台支持

三平台都能**构建**，但"构建通过"和"真机验证过"是两件事，分开记：

| 平台 | 构建 | 真机运行验证 |
| --- | --- | --- |
| macOS（ARM64 / x64） | CI 出包 | 主要开发平台，日常在用 |
| Windows x64 | CI 出包 | Windows 11 ARM64 虚拟机：启动、窗口摆放与恢复（#8 #9）、单实例（#7）、断网页、`pnpm dev` 清理旧实例；**登录、刷题、x64 真机未验证** |
| Linux x64 | CI 出包 | 2026-10-01 在 Xvfb 虚拟显示（WebKitGTK 2.52、openbox）下跑过 debug 构建，见文末验收记录 |

代码里没有平台硬编码：

| 关注点 | 处理方式 |
| --- | --- |
| 快捷键 | mac 用 `metaKey`、Windows/Linux 用 `altKey`/`ctrlKey`，见「工具横栏与快捷键」 |
| 凭证读取 | `Webview::cookies_for_url()`，三平台行为一致 |
| 窗口尺寸 | 首次启动最大化，之后由 `tauri-plugin-window-state` 恢复上次的尺寸与位置 |
| 双 WebView 布局 | macOS / Windows 用 `set_bounds` 绝对定位；**Linux 另有一套**：tauri-runtime-wry 把子 WebView pack 进 GtkBox，`set_bounds` 是空操作，`toolbar.rs` 的 linux 版 `layout` 直接改 GTK packing（工具栏固定高、内容区 expand） |

开发入口 `pnpm dev`（`scripts/dev-run.mjs`）三平台通用。清理旧实例时：macOS / Linux 用 `pkill -f target/debug/fenbi-desktop`；
Windows 用 PowerShell，**只结束完整路径等于本仓库 `target\debug\fenbi-desktop.exe` 的进程**，因为已安装的正式版 exe 也叫 `fenbi-desktop.exe`，不能误杀。
Windows 上的验证情况：清理旧实例、启动、不误杀同名 exe，这三项在 Windows 11 ARM64 虚拟机里实测过（编译步骤用替身短路）；
在 Windows 真机上用 MSVC 原生 `cargo build` 这一步**未验证**。

在 macOS 上用 `cargo xwin` **手动交叉编译** Windows 版时，必须设置 `RUSTFLAGS="-C target-feature=+crt-static"`，静态链接 VC 运行库，
否则在没装 VC++ 运行库的机器上，一启动就会卡在「找不到 VCRUNTIME140.dll」的对话框上。
正式包不受影响，因为 `tauri build` 会自己设置 `STATIC_VCRUNTIME=true`。

Windows 上还有两个已知坑：

- Tauri 文档指出**同步命令里读 cookie 会死锁**（[wry#583](https://github.com/tauri-apps/wry/issues/583)）。
  本项目不在命令里读 cookie——`current_login_decision` 只读内存快照，
  凭证读取跑在独立线程里，所以不受影响。
- 需要 WebView2 Runtime。已配置 `webviewInstallMode: downloadBootstrapper`：
  安装时若系统缺少它，安装包会自动下载微软的 bootstrapper 来装。

Linux 依赖系统 WebKitGTK，`tauri.conf.json` 里已声明 deb 的 depends。
CI 里的 apt 依赖列表见 `.github/workflows/release.yml`。

---

## 发布

### 打 tag 触发

```bash
git tag v<版本>          # 例如 v0.1.3，与三处版本号一致（见下文）
git push origin v<版本>
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

**当前没有正式签名**。macOS 只做了 ad-hoc 整包签名（`tauri.conf.json` 的
`bundle.macOS.signingIdentity` 为 `"-"`），免费、不带开发者身份，作用是让系统提示
从「已损坏」变成可点「仍要打开」的「无法验证开发者」。Windows 完全未签名。
用户首次打开会被 Gatekeeper / SmartScreen 拦，README 里写了放行步骤。
要启用正式签名的话接上 secrets，tauri-action 会自动使用：

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
4. 在做题页提供划词标记：只叠底色，不改站点结构、不读题目数据；按练习落盘只存题号、文字偏移和颜色（见下文「做题页的划词标记」与 `docs/adr/0004`）

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

同一目录下的 `seen-version` 存「已看过的版本号」（一行版本号）：用户在设置页面里看到新版时由 Rust 写下，启动时读回；新版高于它时齿轮才带红点。文件没有或读不懂，当作什么都没看过。

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

### 功能设置（设置页面里的开关和参数）

划词标记、解析页分栏这类功能的开关和参数都在设置页面里改（长期规则见 `AGENTS.md`「新功能默认可配置」）。

- **存法**：`src-tauri/src/settings.rs`。数据目录（`store.rs`：正式版是 `app_data_dir`，debug 构建是它下面的 `dev/`，
  两版可以同时开着，各写各的、互不覆盖）里的 `feature-settings.json`；先在同目录独占创建一个唯一名字的临时文件，写完再改名。
  读不出、不是 JSON、任何一个字段非法（范围外、格式不对、快捷键重复或占了工具栏 / 系统的键）就**整份**回落默认值；缺的字段按默认补，
  以后加设置项老文件照样能读。默认值同时写在 `tests/fixtures/default-settings.json`，Rust 测试锁住两边一致，JS 测试拿它当「Rust 注入的设置」。
- **谁能读写**：`feature_settings` / `save_feature_settings` 只授权给工具栏 WebView（`capabilities/toolbar.json`）。粉笔页面没有读设置的命令。
- **怎么到粉笔页面**：`page-settings.js` 拼在 `initialization_script` 最前面，占位符换成启动时的设置；之后设置页面保存时、
  以及每次页面加载完成（`PageLoadEvent::Finished`，因为 `initialization_script` 里还是启动时那份）时，Rust `eval`
  `window.__fenbiApplySettings(新设置)`。`init.js`（分栏样式）和 `highlight.js` 订阅它，改了立即生效。
  `page-settings.js` 的 `ready()` 在收到这个文档的第一次推送之前是 false，`highlight.js` 在那之前不处理输入、不读写标记——
  设置改过之后整页重载，新文档里烤进去的还是启动时那份，等加载完成的那一推才用最新的。分栏样式先按启动时那份画，收到推送再改。
- **设置页面**：`toolbar/feature-settings.js`。改动按操作顺序排队：界面按「Rust 确认过的那份 + 还没确认的改动依次套上」画，
  同一时间只有一个保存在路上，下一个保存从最新的本地意图算整份（连改两项不会互相盖掉）；某次被拒就只退回那一批，并在那一组底下说原因。
  快捷键录入框录的是 `Ctrl+Alt+Shift+Meta+<KeyboardEvent.code>` 的子集（字母、数字、F1–F12），拒绝和工具栏键位、
  系统常用键（mac 的 `⌘` + A/C/H/M/N/Q/T/V/W/X/Z，Windows / Linux 的 `Ctrl` + 同样的字母、`Alt+F4`）和本组别的键重复。
  工具栏键位和系统常用键是 `shortcuts.js` 里夹在注释中间的两段纯 JSON，`settings.rs` 用 `include_str!` 切出来解析，落盘校验和录入框查的是同一份。

| 设置 | 默认 | 范围 |
| --- | --- | --- |
| 划词标记总开关 | 开 | |
| 标记方式 | 松手即标记 | 松手即标记 / 选中后按键标记 |
| 标记键（只在「选中后按键」时用） | `H` | 快捷键 |
| 显示 / 隐藏标记 | `V` | 快捷键 |
| 切换笔色 | `C` | 快捷键 |
| 3 种颜色 | `#ffd8a8` `#c3f0c8` `#ffc9de` | `#rrggbb` |
| 记住标记 | 开 | |
| 标记保留时长 | 30 天 | 7 / 30 / 90 天 / 永久保留 |
| 解析页分栏总开关 | 开 | |
| 左栏占比 | 50% | 30%–70%，步长 5 |
| 分栏所需窗口宽度 | 1400 像素 | 960–2560 |

**为什么 `V` / `C` 不带修饰键**：`shortcuts.js` 的五个键位全带 `Cmd` / `Ctrl` / `Alt`；mac 的系统快捷键都带 `⌘`；
做题页自己的脚本里没有用到这几个键（见「已验证的站点事实」里 2026-11-28 对做题页脚本的核对）；焦点在输入框里时 `highlight.js` 一律放行，不影响打字。
少按一个键，符合「交互要顺手」。

### 做题页的划词标记

`src-tauri/highlight.js` 是独立的注入脚本，`lib.rs` 把它和 `init.js` 一起拼进 `initialization_script`，
每个粉笔页面都带；它在每次操作时按当前路径判断是不是做题页（站点是 SPA，换页不重载），不是就什么都不做、不拦。
做题页写死成真实页面上核实过的两种：`spa.fenbi.com` 上的 `/ti/exam/exercise/<id>` 和 `/ti/memorize/<id>`，路径必须正好带一个 id
（允许结尾的 `/` 和查询串；别的粉笔子域、没有 id、多一级子路径都不算），见「已验证的站点事实」。

| 操作 | 条件 | 效果 |
| --- | --- | --- |
| 拖选后松开左键 | 标记方式是「松手即标记」，有选区 | 按当前笔色标记、取消选区，并吞掉紧跟着的那次 `click`。选区两端不在同一道题（`app-ti`）里、或有一端在题外（例如全选）时不标、不拦，选区留着 |
| 标记键（默认 `H`） | 标记方式是「选中后按键标记」 | 有选区就标（选区正好是已标的一处时换色）；没有选区、鼠标停在一处标记上就给这处换色 |
| 右键 | 点在一处标记上，且命中的元素就在这处标记所在的题（`app-ti`）里、不在弹层里 | 删掉这一处，`preventDefault` 不弹菜单；别的情况什么都不做 |
| `Shift` + 右键 | 同上 | 这一处换下一种颜色（3 色循环） |
| 切换笔色键（默认 `C`） | | 之后新标的用下一种颜色 |
| 显示 / 隐藏键（默认 `V`） | | 把 3 组高亮从 `CSS.highlights` 登记表里拿掉 / 登记回去，标记数据留着；隐藏时别的操作都不生效 |
| `Shift+Delete` / `Shift+Backspace` | 鼠标在一道题（`app-ti`）上 | 清掉这道题的全部标记；页面上一个 `app-ti` 都没有（站点改版）时清掉本页全部标记 |

- **画法**：只用 CSS Custom Highlight API。3 个 `Highlight` 各管一种颜色（`fenbi-mark-1..3`），
  悬停的那一处另外登记进优先级更高的 `fenbi-mark-hover`，只加一条下划线。第一次标记时往页面加一条
  `<style data-fenbi-wrapper="highlight">`，里面只有这 4 条 `::highlight()` 规则（颜色改了就重写它）；不插别的元素、不改站点节点。
- **颜色**：默认 `#ffd8a8`（浅橙）、`#c3f0c8`（浅绿）、`#ffc9de`（浅粉），可在设置里改；文字固定成 `#1f2328`。
  默认色避开站点的蓝色选中态和站点自带划线库的 `#ff9` 黄；字色固定是为了站点切深色主题时照样读得清。
- **为什么标完要取消选区**：浏览器把选中态画在自定义高亮上面，选区不取消就看不见标成了什么颜色。
- **为什么松手标记要吞掉 click**（借鉴 #11 提议人 fork 的 `suppressClickFor`）：拖选的起止点落在选项上时，浏览器松手后会对它们的公共祖先发 `click`，
  站点会当成点了选项。只在**这次手势拖出来的选区真的标上了**时吞掉紧跟着的那一次（`window` 捕获阶段 `stopImmediatePropagation`），下一次按下鼠标就复位；
  按下时记下选区边界，松手时选区没变（比如站点按钮用 `mousedown.preventDefault()` 保住了旧选区）就不标、不吞。
  单击选项没有选区，不标、不吞。双击选中一个词也会标上它，第二下 click 被吞掉。
- **为什么右键要核对命中的元素**：标记是按屏幕坐标找的，盖在标记上面的站点弹层按钮被右键时坐标也落在标记上。
  所以还要求 `event.target` 在这处标记所在的 `app-ti` 里，且不在弹层里（`role=dialog` / `aria-modal` / `<dialog>`，
  或标签名、class 带 modal / dialog / popup / overlay——实测站点有 `login-web-modal`、`fb-qrcode-login-modal`、`buy-member-app-popup`）。
  焦点在弹层里时 `V` / `C` / 标记键 / `Shift+Delete` 也一律放行。
- **为什么右键删除**：「悬停再按删除键」要两步，右键一步到位；只在点中标记时拦，不在标记上的右键菜单照常。
- **一处标记只属于一道题**：跨题的标记会让「清当前题」误删或删不掉，所以页面上认得出 `app-ti` 时，起点必须落在某道题里、终点在同一道题里，跨题和全选这类两端在题外的选区都拒绝；认不出（站点改版）时不做这道检查（这时的标记算不出题号，不存盘）。
- **鼠标离开内容区就忘掉指针**：工具栏是另一个 WebView，鼠标移过去或窗口失焦时内容区还留着键盘焦点。收到 `relatedTarget` 为空的
  `mouseout`（鼠标离开这个 WebView）或 `blur` 时清掉指针坐标和悬停状态，之后悬停换色、清当前题都不生效，直到鼠标再移回来。
- **不拦的情况**：焦点在文本框、文字类输入框、可编辑区域里（单选框、复选框不算，选完答案焦点停在选项上照样能标），或在站点弹层里；
  修饰键和设置的不全等；输入法组字中；按住不放的自动重复。只有真的生效时才 `preventDefault`。
- **按练习落盘**（2026-11-28 用户授权放开，仅限划词标记；登录态照旧不落盘）：Rust 的 `marks.rs` 存在数据目录（同上，debug 构建在 `dev/`）的 `practice-marks.json`，
  按练习分条（`exercise:<id>` / `memorize:<id>`，练习和背题同 id 也分开），每条是 `[第几道题, 题内起点, 题内终点, 颜色]` 加最后修改时间，
  不存选中的文字。题内偏移 = 这道题里所有文字节点长度之和（`TreeWalker` 数长度，不取文字），元素边界（三击整段）按「第 offset 个子节点之前」算。
  粉笔页面只拿到 `read_practice_marks` / `write_practice_marks` 两条命令：权限 `allow-practice-marks` 单独一份 capability
  （`capabilities/practice-marks.json`，`remote.urls` 只有 `https://spa.fenbi.com`，只给 main WebView），不挂在整个粉笔域的 `default` 上。
  两条命令都**不收练习 id**：Rust 从调用方 WebView 的当前地址认定练习（`marks.rs` 的 `practice_of`，和 `highlight.js` 的 `PRACTICE_PATH` 同一条规则，
  `tests/fixtures/practice-urls.json` 锁住两边），地址不是做题页就拒绝。写入整份替换当前练习，Rust 校验每条的结构（起点 < 终点、颜色 < 3、题号和偏移有上限）、
  单个练习最多 500 处、整个文件最多 2 MB（启动读文件也按 2 MB 封顶），超限拒绝、文件不动。
  - **存储代次**：读回 `[代次, 标记]`，写入带上代次。「清除全部标记」由 Rust 删文件、代次加一，再 `eval` `window.__fenbiClearMarks(新代次)`：
    页面清掉画着的、待恢复的、待保存的，作废还在路上的读取；清除之前发出、之后才到的写入 Rust 按旧代次拒绝（回 `"stale"`，页面不当成失败）。
  - **写失败**（超限、磁盘）：页面上的标记留着，Rust 让工具栏的状态位显示一句「标记没保存上：……」（`toolbar.js` 的 `__fenbiShowError`），
    不往粉笔页面插任何东西；每次写都是整份，下一次改动自然连同没存上的一起重试。
  - 「记住标记」关着时脚本一条命令都不发，Rust 那边也不碰文件；**启动时也不读、不清过期**。打开时（设置保存后）才读文件并按「标记保留时长」清过期的练习。
    「清除全部标记」关着时照常可用。
- **恢复**：进入一份练习时先读回存着的，题目画出来之后按偏移重建 `Range`。题目或文字还没画出来、偏移对不上的都留在「待恢复」里，每 500 毫秒再找一次，
  **不写盘**——站点常常先挂空的 `app-ti`、过一会儿才填文字，一次没找到就写回会把存档抹掉。站点真改了某道题（文字变短）的那一条不画、一直留在存档里，按保留时长过期。
  读回来之前新标的先记着，读回来后合并再写，不覆盖存着的；读失败就不写。
- **换页、站点重绘**：每次操作、鼠标移动、页面滚动和浏览器前进后退（`popstate`）时先检查一遍；站点用 `pushState` 换页不发事件，所以另有一个
  500 毫秒的定时检查看地址变了没有，静置不动也会切换。练习变了就清掉页面上的标记、读新练习的；
  节点被站点摘掉或换掉的那几处退回「待恢复」，按偏移重新画到新节点上。
  认失效时拿标记那一刻记下的四个边界比对，而不是只看范围塌没塌：Chromium 摘节点时把落在里面的边界挪到父节点，
  跨段标记的一端被换掉后范围不塌、两端也都还在文档里。
- **不读题目数据**：只看选区的边界和文字节点的长度，不调 `toString()`。测试替身的 `Range` / `Selection` 被读文字时直接抛错。
- 浏览器没有 `CSS.highlights` 时脚本开头就返回，不加监听、不加样式、不调命令。

### UI 裁剪

`init.js` 顶部有一组选择器常量（`UI_TWEAKS` 默认 `true` 总开关）。只注入 CSS，
不碰站点逻辑。站点改版时选择器失效的表现只是"该隐藏的没隐藏"，不影响做题。

七组规则，**按手法分类**，不能混：

| 常量 | 手法 | 用于 | 当前内容 |
| --- | --- | --- | --- |
| `HIDE_SELECTORS` | `display: none` | 整块移除、不留空间 | 活动横幅；`.member-area`（会员卡入口 + 悬停扫码卡片）；`#userlogout a.popover-content`（我的课程）；`i.paper-tag-help` |
| `COLLAPSE_SELECTORS` | 不可见且尺寸归零 | 顶栏这类需要"让出宽度"的 flex 子项 | `nav.fb-web-nav`（顶栏 tab） |
| `HIDE_CONTENT_SELECTORS` | 不可见但**保留原始尺寸** | 清空内容、留下留白 | 页脚三段 |
| `NON_INTERACTIVE_SELECTORS` | **保留可见**、只去掉点击 | 留着占位但不能再导航的入口 | `a.fenbi-icon-url`（logo） |
| `SHRINK_HEIGHT_CSS` | 改高度 | 压掉页脚过厚的留白 | `fb-web-footer` 高度 50% |
| `UPSELL_BLOCK_SELECTORS` | `display: none`，**单独成一条规则** | 站点正在显示开通入口的整块内容 | 解析页的视频块；申论会员内容块 |
| `splitCss(设置)` | 改布局：`@media (min-width: 设置的宽度)` 里的 grid，**带 `:has()` 守卫、单独一条 `<style data-fenbi-wrapper="split">`**，设置一变只重写它 | 解析页左右分栏 | 题目选项 + 答案统计条在左，解析视频 / 解析 / 考点 / 来源 / 笔记在右 |

把 `COLLAPSE_SELECTORS` 和 `HIDE_CONTENT_SELECTORS` 用反，就是踩过的坑：
前者必须让出宽度，后者一旦归零留白就没了。

**会员卡**（「职测会员卡 / 尚未开通」）的扫码弹窗是**悬停**出来的，但卡片就在
`.member-area` 内部（`article.buy-member-app-popup > fenbi-member-card`），
所以摘掉入口即可，不需要单独处理弹窗；结构常驻、靠透明度显隐，只注入 CSS 就够。

**解析页的开通入口**（用词见 `GLOSSARY.md`）只有一条规则：一块内容里，站点正在显示
开通入口，就把这一整块藏掉；没有开通入口就不动。包装层不读账号、不调站点接口，
因为站点已经把答案写在页面上——账号有权看时，它不渲染开通入口（旧组件是加 `hidden` 属性）。
所以选择器写成 `整块:has(显示着的开通入口)`：

- 视频块 `section.result-common-section`（`spa.fenbi.com/ti/` 的解析页），开通入口是
  `app-solution-video .member-container`；站点只对无权看的账号渲染它，所以不用 `:not([hidden])`；
- 旧解析组件的视频块 `li.video-item`，开通入口是会员遮罩 `.question-video-member`；
- 旧解析组件的申论会员内容块 `.member-solution-accessory`，开通入口是 `.nav-btn`（「立即开通」）。

第一条在真实页面上核对过；后两条只读过站点脚本的模板，没找到不替用户开始一次练习
就能进入的页面，**未核对**。选择器失配的表现只是那一块照旧显示。

会员看到的页面不变。不是会员但有单题观看权限的账号，站点对那道题不显示会员遮罩，
视频块照常显示。试卷列表顶上的图例「代表会员可享受此试题的视频解析」和卷子旁的
小图标**不裁剪**：它没有开通入口，会员靠它分辨哪份卷子有视频讲解。

> ⚠️ 这条规则必须**单独成条**，不能并进 `HIDE_SELECTORS`。不认 `:has()` 的旧 WebView
> （macOS 12.3 之前的系统 WebView）会把含它的整条规则作废，并进去就连累全部裁剪。
> 旧系统上的表现只是这两块照旧显示。`tests/js/page-tweaks.test.mjs` 盯着这一点：
> 带 `:has()` 的规则里，每个选择器都必须带 `:has()`。

**解析页左右分栏**（GitHub #10）：窗口宽度够设置里的宽度（默认 1400 像素）时，每道题的 `.solution-choice-container`
改成两栏的 grid（左栏占比按设置，默认各一半）：左栏 `app-question-choice`（题目选项）接 `app-solution-overall`（答案统计条），
右栏 `app-result-common` 从题目顶端排到统计条下面，里面「解析视频 → 解析 → 考点 → 来源 → 笔记」保持站点原来的顺序。
窄了保持上下排；设置里关掉分栏时这条样式为空。

- **三块都在才分栏**：容器选择器是 `.solution-choice-container:has(> app-question-choice):has(> app-solution-overall):has(> app-result-common)`，
  任何一块改名或挪走（站点改版），规则就不命中，页面退回原来的上下排。不用 Angular 作用域哈希。
- **两栏都是 `minmax(0, Nfr)`**（N 按左栏占比，例如 `50fr` / `50fr`）：站点给所有图片设了 `max-width: 100%`，解析视频也会跟着栏宽缩放
  （1400 宽时 540×315 缩成 496×289），所以两栏都能缩，不会把卡片撑出去。
- 右栏的 `margin-top`（原本是和统计条之间的 20px）去掉，和题目顶端对齐。只改布局，不碰站点节点。
- **和开通入口那条规则一起生效不打架**：没开会员时视频块被藏掉，右栏从「解析」开始。
- 答对的题默认被站点折叠成一条「解析」（右上角箭头展开），这时右栏就是这一条，展开后照常排。
- 不认 `:has()` 的旧 WebView 上只是不分栏。

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
    ├── highlight.js        # 网站注入脚本：做题页的划词标记
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
| `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY`（大小写都认） | 检查更新走的代理。设了就不再读系统设置里的代理；都没设时 Windows、macOS 用系统设置里的 HTTPS 代理（见 `update.rs` 的 `update_proxy`） |
| `NO_PROXY`（大小写都认） | 检查更新不走代理的主机，逗号分隔。代理来自环境变量还是系统设置都生效；系统设置里的排除项只配系统设置里的代理 |

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
- **做题页（`spa.fenbi.com/ti/…`）的脚本也不占 `V` / `C` / `H`**（2026-11-28 核对）：入口页 `index.html` 引用的 6 个文件加上
  它们引用的懒加载 chunk，共 17 个、2.1 MB。里面的 `keydown` 处理只有弹层的 `Esc`（`keyCode 27`）、视频播放器在视频可见且有焦点时的
  空格 / ← / →（`keyCode 32/39/37`），以及一个只记录「有没有动静」的活动监视；`KeyV` / `KeyC` / `KeyH`、`keyCode 86/67/72` 都是 0 次。
  `contextmenu` 只出现在弹层的点外关闭、一个可拖动控件和画布库里，不在题目文字上，所以右键点标记删除不和站点抢
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

**做题页（2026-11-28 用 ego-browser 实测，macOS、Chromium 内核、已登录；从目录页「练习历史 → 继续做题」进入一份没做完的练习，没有答题、没有交卷）**：

| 元素 / 事实 | 实测 | 说明 |
| --- | --- | --- |
| 地址 | 练习 `spa.fenbi.com/ti/exam/exercise/<id>`，背题 `spa.fenbi.com/ti/memorize/<id>` | 「继续做题」直接在当前页打开。`/tiku` 下的旧做题页没有找到入口，未核实 |
| `app-ti` | 一份 15 题的练习里 15 个，每道题一个，整页长列表 | 题目卡片，里面是 `.ti-container > .title`（题号、题型、右侧三个工具）和 `.ti-content > app-question-choice` |
| 选项 | `input.option-radio`，每个选项一个单选框 | 选完答案焦点可能停在它上面 |
| 题目右上的笔形按钮 | 点开后盖上一层 `canvas.pen`（1180×314）和一列「撤销 / 恢复 / 橡皮 / 清空 / 退出」 | 站点自己的手写画笔；开着时文字选不中 |
| `style#highlight-mengshou-style` | `.highlight-mengshou-wrap { background: #ff9 }` | 站点脚本里自带的划线库，靠包 `<span>` 工作；`CSS.highlights` 是空的，站点没用 Custom Highlight API |
| `CSS.highlights` | 存在 | Chromium 内核下实测；系统 WebView 是否支持看系统版本（Safari 17.2 起） |

- **站点在做题页没有处理 `H` / `Delete` / `Backspace`**：document 上唯一的 `keydown` 监听是一个按 1 秒节流记录「最近活动时间」的
  RxJS 订阅；其余按键处理只有弹层的 `Esc` / `←` / `→` 和视频播放器自己元素上的快捷键（读当日 13 个脚本文件）。
  实测不注入划词脚本时按这几个键（含 `Shift+`），`defaultPrevented` 全为假，选区不变，页面没有变化
- 把 `highlight.js`（第一版）临时注入这个真实页面：选字按 H 出底色、选区取消；悬停按 H 三色循环、悬停那处带下划线；
  悬停按 Backspace 删一处；鼠标在第 1 题上按 Shift+Delete 只清第 1 题，第 2 题的标记还在。
  注入到目录页时选字按 H 不登记、不拦键、不加样式

**解析页的视频块（2026-11-27 用内置浏览器实测，已登录、当前考试未开会员，`spa.fenbi.com/ti/exam/solution/<id>`）**：

| 元素 | 实测 | 说明 |
| --- | --- | --- |
| `app-result-common > .result-common-container > section.result-common-section` | 每道题 5 个：解析视频 / 解析 / 考点 / 来源 / 笔记；`margin-bottom: 28px` | 视频块就是标题为「解析视频」的那个 section，842×355，`id=section-video-<题目 id>` |
| `app-solution-video > .solution-video-container > .member-container` | 15 道题里 7 道有视频块，7 个都带 `.member-container` | 会员遮罩：「粉笔 职测 会员 / N人已开通」+ `.member-btn` |

- 藏掉视频块后，同一道题的「解析」正好顶到视频块原来的位置，不留空白
  （临时注入同一条规则实测：命中 7 个，可见的 `app-solution-video` 从 7 变 0）
- 站点脚本里 `.member-container` 的渲染条件是「不是会员 **且** 没有这道题的观看权限」，
  所以会员账号下选择器不命中。**这一条来自脚本模板，没有用会员账号实测**
- `.member-btn` 点了是站点自己开的会员弹窗，不是导航
- 这一页的 WebView 支持 `:has()`（`CSS.supports("selector(li:has(a))")` 为真）

**解析页的版面（2026-11-28 用 ego-browser 实测，macOS、Chromium 内核、已登录、当前考试未开会员；从目录页「练习历史」里一份已完成的练习进入）**：

| 元素 / 事实 | 实测 | 说明 |
| --- | --- | --- |
| `app-ti > .ti-container > .ti-content > app-solution-choice > .solution-choice-container` | 15 道题都是这一层 | 子元素依次是 `app-question-choice`、`app-solution-overall`、`app-result-common`，没有别的 |
| 内容宽度（`.solution-choice-container`） | 视口 1280 / 1400 / 1600 / 1920 时 1140 / 1100 / 1300 / 1620 | 页面两侧留白：1280 时各 50 左右，1400 起各 130 左右 |
| `app-result-common > .result-common-container` | `padding: 20px`、`1px` 边框、`margin-top: 20px`；右上有折叠按钮 `.toggle-btn` | 答对的题默认折叠成 60 高的一条「解析」，答错和没答的展开 |
| `.solution-video-container.medium` | flex：视频 540×315 + 会员遮罩 270×315 | 栏宽不够时视频跟着缩（1400 宽分栏后 496×289） |
| 全局样式 `img { max-width: 100%; height: auto; }` | 站点自带 | 解析和题干里的图片跟着栏宽缩 |

- 临时注入 `init.js` 生成的整份裁剪 CSS，在 1280 / 1399 / 1400 / 1600 / 1920 五个宽度量 15 道题：
  1400 起 15 道全部分栏，左右两栏不重叠，容器和页面都没有横向溢出；1399 及以下全部保持上下排。
  模拟会员（不藏视频块、只藏会员遮罩）时右栏视频完整显示，不被裁。
  复制一份容器、去掉统计条后，这份不分栏（退回上下排）

**/tiku 下旧解析组件的会员相关结构（2026-11-27 读站点当日的脚本模板得到；真实页面未核对）**：

| 元素 | 站点模板里的规则 | 说明 |
| --- | --- | --- |
| `li.video-item` | `display` 由站点按「这道题有没有视频」设成 `flex` / `none` | 视频块，出现在 `app-fb-practice-solution` 与 `app-fb-solution` 两个组件里 |
| `.question-video-member` | `hidden` = 当前考试的会员 **或** 这道题有观看权限 | 会员遮罩，在 `.video-item-content` 内，盖在视频封面上 |
| `.member-solution-accessory` | 有申论附加内容时才渲染 | 申论会员内容块，组件 `app-member-solution-accessory` |
| `.member-solution-accessory .nav-btn` | `hidden` = 当前考试的会员 | 「立即开通」按钮 |

- 会员按考试类型分（职测、申论等各算各的），状态来自站点接口
  `/ke/v3/members/home_members`，只在站点内存里，不写进页面。包装层不读它

---

## 待做

待做项以 `docs/issues/` 下的本地议题为准，本文件不再维护列表。每个文件第二行的 `状态：` 写明能不能交给 agent（`ready-for-agent`）或需要真机和人判断（`ready-for-human`）。用户反馈仍从 [GitHub Issues](https://github.com/windery/fenbi-desktop/issues) 进来。

断网冷启动时三平台的表现，以及为什么目前不做加载失败提示，见 [docs/research/2026-11-05-load-failure-signal.md](docs/research/2026-11-05-load-failure-signal.md)。

issue 跟踪器的操作约定见 `docs/agents/issue-tracker.md`。

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
| JS 行为测试 | `tests/js/` | 弹窗次数、序号去重与轮次、重试取消与预算、目录防循环、工具栏 IPC 动作、收起状态与异步乱序、五组快捷键、网站不注入工具栏 DOM、划词标记的登记表与拦键 |

JS 用例按登录提示、工具栏、导航快捷键、页面裁剪与划词标记拆在 `tests/js/`，测试地图与单独运行方式见 [tests/README.md](tests/README.md)。
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
再在前台启动 app：启动前先关掉上一次的 debug 实例，所以不会有残留实例；
app 退出（或在终端按 Ctrl+C）后命令随之结束，编译失败则不启动、返回非零退出码。

### 改 `init.js` 不用重编译

debug 构建启动时**从磁盘读** `init.js` / `init-debug.js` / `highlight.js` / `shortcuts.js`（由 `build.rs` 拷到
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
- `src-tauri/target/release/bundle/dmg/粉笔刷题_<版本>_aarch64.dmg`

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

### 没有显示器也能跑：Xvfb 验收

Linux 容器里可以这样起一个虚拟显示跑 debug 构建，截图和驱动都用标准 X11 工具：

```bash
sudo apt-get install -y xvfb openbox xdotool wmctrl imagemagick fonts-noto-cjk
Xvfb :99 -screen 0 1600x1000x24 & DISPLAY=:99 openbox &   # 要有窗口管理器，maximize 才有意义
export DISPLAY=:99 FENBI_DEBUG=1 XDG_CONFIG_HOME=/tmp/fb/config XDG_DATA_HOME=/tmp/fb/data
pnpm build && cargo build --manifest-path src-tauri/Cargo.toml && src-tauri/target/debug/fenbi-desktop &
wmctrl -lG                      # 窗口几何；xprop -id <id> _NET_WM_STATE 看是否最大化
xdotool key ctrl+shift+b        # 快捷键要走 XTEST（不要加 --window，GTK 会忽略 XSendEvent）
import -window root shot.png    # 截图
wmctrl -i -c <id>               # 正常关闭，窗口状态插件只在退出时落盘
```

隔离的 `XDG_*` 目录保证不碰真实数据。`pkill` 时用 `-x fenbi-desktop`，别用路径匹配。
想知道内容区 WebView 的真实尺寸，往 `target/debug/init.js`（debug 构建从磁盘读）临时追加一段
把 `innerWidth/innerHeight` 发到 8799 beacon 的代码即可，不用改源码。

2026-09-23 **旧版独立工具栏迁移验收**：`pnpm check` 通过（45 项 JS、30 项 Rust，含 fmt/clippy）。当时的 macOS 原生开发版确认已登录冷启动、刷新后保持会话、页面裁剪、独立工具栏收起展开、网站焦点下 Cmd+Shift+B、全屏退出及重启后收起偏好恢复；没有 URL/加载状态调试行。这条记录不代表本次 36px / 24px 工具栏重做已在真实 WebView 中验证。当时未执行登出、扫码、答题或报告操作，Windows/Linux 也尚未实机验证。

2026-09-29 **36px / 24px 工具栏重做验收**：`pnpm check` 通过（51 项 JS、30 项 Rust，含 fmt/clippy），界面静态质量检查未报问题。macOS 未签名调试版确认全屏与窗口缩放时两个 WebView 无重叠、两种工具栏高度正常、重启后收起偏好恢复、展开后焦点回到网站。从一项已有练习分别用工具栏按钮和网站侧快捷键回题库，再返回，均回到原练习地址；未选答案或交卷。状态读取失败、命令失败和收起条空白区域点击由 JS 行为测试覆盖。Windows/Linux 尚未实机验证。

2026-10-01 **v0.1.2 Linux 验收（Xvfb 1600x1000，WebKitGTK 2.52.6，openbox）**：`pnpm check` 通过（51 项 JS、28 项 Rust，含 fmt/clippy）。debug 构建确认：首次启动最大化（`_NET_WM_STATE_MAXIMIZED_*`），正常关闭后 `.window-state.json` 落盘，取消最大化并改成 1000x700 后重启恢复同一几何；目录页加载、未登录判定 `logged-out`、站点登录框被点出且只点一次；Ctrl+Shift+B 收起/展开、点收起条右侧「展开」、Ctrl+R 刷新、工具栏「回题库」按钮均生效；页面裁剪（顶栏 tab、活动横幅、会员入口）生效。**同时发现并修复**：Linux 上内容区只占窗口下半（v0.1.1 同样如此，是 tauri-runtime-wry 在 GTK 下的 `set_bounds` 空操作），见「平台支持」表的「双 WebView 布局」。未做：登录、答题、报告页；Windows 仍只验证过构建。
