# 粉笔刷题

粉笔题库的桌面版。打开就进题库，不用每次在浏览器里翻菜单。

macOS / Windows / Linux 都能用。

## 它解决什么

在浏览器里刷题的麻烦：

- 题库入口藏得深，每次都要点好几层
- 标签页一多就找不到了
- 登录完还停在原地

这个 app 就干一件事：**打开它，你就在题库里。** 登录一次之后长期有效，之后每次打开直接可用。

## 安装

### macOS

下载 `.dmg`，把「粉笔刷题」拖进「应用程序」。

未签名，首次打开会被 Gatekeeper 拦。两个办法：

- 在「应用程序」里**右键 →「打开」**，然后确认
- 或者执行一次：`xattr -dr com.apple.quarantine /Applications/粉笔刷题.app`

### Windows

下载 `.exe`（安装包），双击安装。

未签名，SmartScreen 会提示。点**「更多信息」→「仍要运行」**。

首次运行会自动准备 WebView2 运行时。

### Linux

- `.AppImage`：加执行权限后直接运行
  ```bash
  chmod +x 粉笔刷题_*.AppImage && ./粉笔刷题_*.AppImage
  ```
- `.deb`：`sudo dpkg -i 粉笔刷题_*.deb`
- `.rpm`：`sudo rpm -i 粉笔刷题-*.rpm`

## 用法

打开 app 就直接落在题库目录页，**上次选的考试分类会自动恢复**，不用重新选。

| 情况 | 行为 |
| --- | --- |
| 第一次打开 | 自动弹出登录框，用**手机验证码**登录（想扫码就点登录框右上角的二维码图标） |
| 之后打开 | 直接进题库，不用再登录 |
| 登录过期了 | 自动弹出登录框让你重新登录 |
| 正在做题时登录过期 | 不打断你，等你做完再说 |

快捷键：

| 快捷键 | 作用 |
| --- | --- |
| `Cmd + R` / `Ctrl + R` | 刷新页面 |

### 重新登录 / 换个账号

想在 app 里退出登录：点右上角头像 →「退出登录」。之后会重新弹登录框。

如果 app 的登录状态和网站不一致（比如你想彻底重置），删掉本地记录即可：

```bash
# macOS
rm -rf ~/Library/Application\ Support/com.fenbi.wrapper
```

```powershell
# Windows（PowerShell）
Remove-Item -Recurse -Force "$env:APPDATA\com.fenbi.wrapper"
```

```bash
# Linux
rm -rf ~/.local/share/com.fenbi.wrapper
```

下次打开就会重新要求登录。

## 常见问题

**界面和网页版一样吗？**

基本一样，但去掉了顶部的「首页 / 课程 / 关于粉笔」等 tab 和整个页脚，只留题库相关的内容。

**会不会影响账号安全？**

不会。它就是内置浏览器打开粉笔官网，登录走粉笔自己的流程，凭证由系统 WebView 保管。
这个 app 不接触你的账号密码。

**能加别的考试分类吗？**

目录页会自己恢复你上次选的分类，所以在网页里选一次就行，不需要改 app。

**窗口能不全屏吗？**

目前启动即全屏。想要窗口模式可以自行改 `src-tauri/src/lib.rs` 里的 `.fullscreen(true)`。

## 开发

```bash
pnpm install
pnpm dev      # 编译并启动，约 3 秒
```

实现细节、架构说明、排查手册、以及踩过的坑，都在 **[CONTRIBUTING.md](CONTRIBUTING.md)**。

## 发布

打 tag 触发 GitHub Actions 自动构建三平台并创建 Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```
