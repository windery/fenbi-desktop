# 测试结构

`pnpm check` 先构建本地工具栏，再运行 JS 行为测试、Rust 格式检查、Clippy 和 Rust 单元测试。只跑 JS：`node --test`；只跑一组：`node --test tests/js/toolbar.test.mjs`。

| 文件 | 验证的边界 |
| --- | --- |
| `js/login-prompt.test.mjs` | 网站侧注入脚本的登录提示时序；包括异步决策、重试取消和练习页 |
| `js/toolbar.test.mjs` | 独立本地工具栏的按钮、提示、收起状态与 IPC 请求 |
| `js/navigation-shortcuts.test.mjs` | 网站侧快捷键、目录导航历史和不自动拉回目录页 |
| `js/page-tweaks.test.mjs` | 注入 CSS 的裁剪规则、诊断信息和不向网站 DOM 注入工具栏 |
| `src-tauri/src/*` 中的 `#[cfg(test)]` | 与实现相邻的 Rust 状态机、URL/权限策略、布局计算和导航脚本生成 |

`support/boot.mjs` 只放各组共用的启动、夹具读取与按键辅助。`support/browser-env.mjs` 用最小 DOM、可控时钟、历史栈和 IPC 替身**执行真实的** `init.js`、`toolbar.js` 与快捷键脚本；测试断言点击、导航、可见提示和 IPC 调用等外部结果。`fixtures/*.html` 是登录入口及页面元素的精简样本，用来固定这些输入条件，不是粉笔网页的完整副本。要用旧注入脚本核对回归用例是否会失败，可运行 `FENBI_INIT_JS=/tmp/old-init.js node --test tests/js/login-prompt.test.mjs`。

替身没有浏览器的 CSS 布局、真实 WebView 焦点和站点会话，也不会实际访问粉笔。CSS 用例只检查注入规则文本；工具栏尺寸、命令权限与目标 URL 的编码由 Rust 单元测试覆盖。原生窗口中的点击区域、缩放、焦点交接、持久化文件，以及站点是否恢复原题状态，仍需按 `CONTRIBUTING.md` 的步骤实机验证；JS 测试通过不能代替这些检查。
