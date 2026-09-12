/* 粉笔刷题 wrapper —— 注入脚本
 *
 * 由 src-tauri/src/lib.rs 通过 WebviewWindowBuilder::initialization_script() 注入。
 *
 * ## 职责边界
 *
 * 这个脚本不查 cookie、不判登录态、不做定时检测——凭证只能由 Rust 侧读
 * （HttpOnly，JS 拿不到）。它消费 Rust 推来的结论：
 *
 *   1. 启动时读一次记录：观测到已登录 -> 什么都不做；没有记录 -> 弹登录框
 *   2. 收到「观测不到会话了」：立刻弹登录框（不分页面，练习区也一样）
 *   3. 收到「观测到凭证了」：取消所有还没执行的弹框
 *
 * ## 不纠正站内跳转
 *
 * 站点把用户带到哪个**粉笔页面**（搜索结果、试卷列表、报告…）都随它去：
 * wrapper 不把窗口拉回目录页。踩过的坑：搜索结果是 `window.open` 打开的，
 * 旧逻辑虽然能在当前窗口接住它，却又立刻 `location.replace` 回目录页，
 * 表现成"搜索点了没反应"。目录页只作为冷启动入口出现（`lib.rs` 的 entry URL）。
 *
 * ## 记录不是真相
 *
 * `login-state` 只是加速缓存，可能过期。真相以 Rust 那次「页面加载完成后」
 * 的判定为准，判定结果会反过来改写记录。
 *
 * ## 为什么不在页面里判登录态
 *
 * 凭证是 HttpOnly cookie，JS 读不到；而冷启动时站点还要靠 `persistent` cookie
 * 把 `sess` 恢复出来，这段空窗期里 DOM 和 cookie 都显示"未登录"。
 * 在页面里判会误判，于是每次启动都白弹一次登录框。观测全部交给 Rust。
 *
 * ## 边界
 *
 * 登录、做题、分类选择都走站点自己的逻辑。脚本不驱动业务动作、不刷新页面；
 * 唯一一次点击是站点自己的登录入口按钮（桌面端没有地址栏，用户点不到别处）。
 */
(function () {
  "use strict";

  var TARGET_URL = __TARGET_URL__;
  var DEBUG = __DEBUG__;

  /* 弹登录框后是否自动切到扫码登录。
   * 默认 false：停在站点默认的短信验证码登录（用户要哪种自己点）。
   * 想要桌面端扫码免输手机号就改成 true。 */
  var OPEN_QR = false;

  /* 切到扫码后等二维码渲染出来的时间 */
  var QR_RENDER_DELAY_MS = 900;

  /* 登录按钮还没渲染出来时的重试参数。这是「启动 0 等待」的唯一落地：
   * 不预先等，发现按钮没出现就快速重试，按钮一出现立刻弹。 */
  var LOGIN_BTN_RETRY_MS = 250;
  var LOGIN_BTN_RETRIES = 24; // 最多约 6 秒

  /* ------------------------------------------------------------------ *
   * 展示层裁剪：隐藏与刷题无关的元素
   *
   * 只改样式，不碰站点逻辑。站点改版时选择器失效的表现只是"该隐藏的没隐藏"，
   * 不影响做题，所以风险很低。
   *
   * 选择器全部实地核对过（目录页 DOM）：
   *   .nav-header-content
   *     ├── a.fenbi-icon-url        粉笔 logo      -> 保留
   *     ├── nav.fb-web-nav          6 个 tab       -> 隐藏
   *     └── .header-content-logon   登录 / 用户头像 -> **必须保留**
   *
   * ⚠️ 不要隐藏整个 header：登录按钮和用户菜单都在里面，
   *    隐藏了就没法登录、也没法退出登录。
   *
   * ⚠️ 顶栏不能用 `display: none` 隐藏。这是踩过的坑：
   *    nav.fb-web-nav 带 `flex-grow: 1`，它占满剩余空间、把右侧的头像顶到最右。
   *    一旦 display:none 让它脱离 flex 流，这个 flex-grow 就失效，
   *    logo 和头像会挤到一起。所以改成「不可见但仍占位」：
   *    visibility:hidden 不脱离流，空间照旧，头像就还在右上角。
   * ------------------------------------------------------------------ */
  var UI_TWEAKS = true;

  /* 整块移除。
   *
   * 目录页的卡片用**白名单**思路维护：只列出要干掉的，其余全部保留。
   * 不要反过来写"保留 xxx"——站点常加新的推广位，黑名单会漏、白名单会误伤。
   *
   * 目录容器 `.fb-ng-tiku-catalog` 的直接子元素（实测）：
   *   UL.info-block                三张卡片：快速练习 / 历年试卷 / 智能组卷  -> 保留
   *   APP-AWARD-EXAM-BANNER        「粉笔模考奖学金争霸赛」横幅 180px       -> 移除
   *   SECTION.mokao-block          「模考大赛」                             -> 保留
   *
   * 父容器高度是被内容撑开的（实测隐藏横幅后每层都恰好 -196px，
   * 即 180 高 + 16 上下 margin），所以不需要手工降高，也不会留空白。 */
  var HIDE_SELECTORS = [
    "app-award-exam-banner", // 「粉笔模考奖学金争霸赛」活动横幅
  ];

  /* A 类：不可见且尺寸归零 —— 用于顶栏这类需要"让出宽度"的元素。
   * visibility 不脱离 flex 流，所以 flex-grow:1 仍然生效，
   * 右侧头像依然被顶到最右。 */
  var COLLAPSE_SELECTORS = [
    "nav.fb-web-nav", // 顶栏 tab：首页 / 课程 / 题库 / 关于粉笔 / 下载客户端 / 投资者关系
  ];

  /* B 类：不可见但**保留原始尺寸** —— 用于"清空内容、留下留白"的场景。
   * 千万不要给这类加 width/height:0，否则留白就没了。 */
  var HIDE_CONTENT_SELECTORS = [
    ".fb-footer-wrapper .public-wrapper", // 页脚上半：关于我们 / 法律声明 / 二维码
    ".fb-footer-wrapper .divider", // 页脚分割线
    ".fb-footer-wrapper .info-wrapper", // 页脚下半：客服热线 / 备案号
  ];

  /* D 类：压掉一部分高度。
   * 页脚外框原本 321px（实测），整块留白太厚，压到一半。
   *
   * 只能改 fb-web-footer：`.fb-footer-wrapper` 的高度是它撑出来的，
   * 给 wrapper 设 height 无效（实测 321 → 321 不动）。 */
  var SHRINK_HEIGHT_CSS =
    "fb-web-footer {\n" +
    "  background: transparent !important;\n" +
    "  height: 50% !important;\n" +
    "  overflow: hidden !important;\n" +
    "}";

  function buildCleanCss() {
    var css = "";
    if (HIDE_SELECTORS.length) {
      css += HIDE_SELECTORS.join(",\n") + " { display: none !important; }\n";
    }
    if (COLLAPSE_SELECTORS.length) {
      css +=
        COLLAPSE_SELECTORS.join(",\n") +
        " {\n" +
        "  visibility: hidden !important;\n" +
        "  pointer-events: none !important;\n" +
        "  width: 0 !important;\n" +
        "  min-width: 0 !important;\n" +
        "  flex-basis: 0 !important;\n" +
        "  height: 0 !important;\n" +
        "  overflow: hidden !important;\n" +
        "}\n";
    }
    if (HIDE_CONTENT_SELECTORS.length) {
      css +=
        HIDE_CONTENT_SELECTORS.join(",\n") +
        " {\n" +
        "  visibility: hidden !important;\n" +
        "  pointer-events: none !important;\n" +
        "}\n";
    }
    // 压高度 + 去底色（页脚自身是深色底，不去掉的话留白是黑的）
    css += SHRINK_HEIGHT_CSS + "\n";
    return css;
  }

  var CLEAN_CSS = UI_TWEAKS ? buildCleanCss() : "";

  /* ------------------------------------------------------------------ *
   * 工具横栏
   *
   * 桌面端没有浏览器 chrome（地址栏、前进后退、刷新、主页），所以在页面最外层
   * 挂一根横栏补上这四个动作。
   *
   * 为什么插在 body 首位：它在文档流里**占位**，把站点内容整体推下去，因此
   * 永远不会盖住站点自己的 header——登录按钮、头像、题目页的返回箭头都在那里。
   *
   * 为什么样式放 Shadow DOM：既不让站点的全局 CSS 改坏按钮，也不让我们自己的
   * 裁剪 CSS 误伤横栏。这是包装层唯一一处注入 DOM 的地方（其余只注入 CSS）。
   * ------------------------------------------------------------------ */
  var TOOLBAR_KEY = "fenbi-wrapper-toolbar";

  var TOOLBAR_CSS =
    ".fenbi-toolbar {\n" +
    "  box-sizing: border-box;\n" +
    "  display: flex;\n" +
    "  align-items: center;\n" +
    "  gap: 8px;\n" +
    "  height: 40px;\n" +
    "  padding: 0 14px;\n" +
    "  background: #ffffff;\n" +
    "  border-bottom: 1px solid #e6e9ef;\n" +
    "  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);\n" +
    "  font: 13px/1 -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;\n" +
    "  color: #46536a;\n" +
    "}\n" +
    ":host([data-fenbi-toolbar='collapsed']) .fenbi-toolbar {\n" +
    "  height: 16px;\n" +
    "  padding: 0 6px;\n" +
    "  border-bottom: none;\n" +
    "  box-shadow: none;\n" +
    "}\n" +
    ".fenbi-toolbar-bar {\n" +
    "  display: flex;\n" +
    "  align-items: center;\n" +
    "  gap: 8px;\n" +
    "}\n" +
    ".fenbi-toolbar-btn {\n" +
    "  display: inline-flex;\n" +
    "  align-items: center;\n" +
    "  gap: 7px;\n" +
    "  height: 28px;\n" +
    "  padding: 0 12px;\n" +
    "  cursor: pointer;\n" +
    "  border: 1px solid #e3e7ef;\n" +
    "  border-radius: 999px;\n" +
    "  background: #f4f6fa;\n" +
    "  color: #46536a;\n" +
    "  font: inherit;\n" +
    "  transition: background 0.12s, border-color 0.12s, color 0.12s;\n" +
    "}\n" +
    ".fenbi-toolbar-btn:hover {\n" +
    "  border-color: #bfd0f8;\n" +
    "  background: #eef3ff;\n" +
    "  color: #2f6ae0;\n" +
    "}\n" +
    ".fenbi-toolbar-icon {\n" +
    "  color: #4a7df0;\n" +
    "}\n" +
    ".fenbi-toolbar-key {\n" +
    "  font-size: 11px;\n" +
    "  color: #8792a6;\n" +
    "}\n" +
    ".fenbi-toolbar-btn:hover .fenbi-toolbar-key {\n" +
    "  color: #5b86e8;\n" +
    "}\n" +
    ".fenbi-toolbar-collapse {\n" +
    "  margin-left: auto;\n" +
    "  height: 24px;\n" +
    "  padding: 0 10px;\n" +
    "  cursor: pointer;\n" +
    "  border: none;\n" +
    "  border-radius: 7px;\n" +
    "  background: transparent;\n" +
    "  color: #8792a6;\n" +
    "  font: inherit;\n" +
    "  font-size: 12px;\n" +
    "}\n" +
    ".fenbi-toolbar-collapse:hover {\n" +
    "  background: #f2f4f8;\n" +
    "  color: #4a7df0;\n" +
    "}\n" +
    ".fenbi-toolbar-handle {\n" +
    "  height: 14px;\n" +
    "  padding: 0 8px;\n" +
    "  cursor: pointer;\n" +
    "  border: 1px solid #e3e7ef;\n" +
    "  border-radius: 0 0 7px 7px;\n" +
    "  background: #ffffff;\n" +
    "  color: #4a7df0;\n" +
    "  font-size: 10px;\n" +
    "  line-height: 1;\n" +
    "}\n";

  function isMacPlatform() {
    var probe = "";
    try {
      probe = (navigator && (navigator.platform || navigator.userAgent)) || "";
    } catch (e) {}
    return /Mac|iPhone|iPad|iPod/i.test(probe);
  }

  /* 按钮上的键位提示，必须和 installShortcuts 真正绑定的键一一对应 */
  function shortcutHints() {
    return isMacPlatform()
      ? { back: "⌘[", forward: "⌘]", reload: "⌘R", catalog: "⌘⇧[" }
      : { back: "Alt+←", forward: "Alt+→", reload: "Ctrl+R", catalog: "Ctrl+⇧[" };
  }

  /* 横栏上的四个动作：这里只写"叫什么"，行为统一在 runShortcut 里，
   * 与快捷键共用同一处实现（少一处会走偏的映射）。 */
  var TOOLBAR_ACTIONS = [
    { action: "back", icon: "←", text: "返回上一页" },
    { action: "forward", icon: "→", text: "前进" },
    { action: "reload", icon: "⟳", text: "刷新" },
    { action: "catalog", icon: "⌂", text: "回题库" },
  ];

  /* 默认**展开**：横栏上的快捷键是主要用法，藏起来等于没有。
   * 只有用户自己点过「收起」才记忆成收起。 */
  function readToolbarState() {
    try {
      return localStorage.getItem(TOOLBAR_KEY) === "collapsed"
        ? "collapsed"
        : "expanded";
    } catch (e) {
      return "expanded";
    }
  }

  function writeToolbarState(state) {
    try {
      localStorage.setItem(TOOLBAR_KEY, state);
    } catch (e) {}
  }

  function installToolbar() {
    if (!document.body || typeof document.body.insertBefore !== "function") return;

    var host = document.createElement("div");
    host.setAttribute("data-fenbi-toolbar", readToolbarState());
    // 宿主元素的样式必须内联：站点的 CSS 与 Shadow DOM 都管不到它
    host.style.cssText =
      "display:block;position:sticky;top:0;left:0;right:0;margin:0;padding:0;z-index:2147483000;";

    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

    var style = document.createElement("style");
    style.textContent = TOOLBAR_CSS;
    root.appendChild(style);

    var bar = document.createElement("div");
    bar.className = "fenbi-toolbar";
    root.appendChild(bar);

    function setToolbarState(next) {
      writeToolbarState(next);
      render(next);
      log("toolbar " + next);
    }

    function render(state) {
      host.setAttribute("data-fenbi-toolbar", state);
      bar.textContent = "";

      // 收起态：只留左上角一个小箭头，点它展开
      if (state !== "expanded") {
        var handle = document.createElement("button");
        handle.className = "fenbi-toolbar-handle";
        handle.textContent = "▼";
        handle.addEventListener("click", function () {
          setToolbarState("expanded");
        });
        bar.appendChild(handle);
        return;
      }

      var row = document.createElement("div");
      row.className = "fenbi-toolbar-bar";
      bar.appendChild(row);

      var hints = shortcutHints();
      TOOLBAR_ACTIONS.forEach(function (item) {
        var button = document.createElement("button");
        button.className = "fenbi-toolbar-btn";
        button.setAttribute("data-fenbi-action", item.action);

        var icon = document.createElement("span");
        icon.className = "fenbi-toolbar-icon";
        icon.textContent = item.icon;
        button.appendChild(icon);

        var label = document.createElement("span");
        label.className = "fenbi-toolbar-label";
        label.textContent = item.text;
        button.appendChild(label);

        var key = document.createElement("span");
        key.className = "fenbi-toolbar-key";
        key.textContent = hints[item.action];
        button.appendChild(key);

        button.addEventListener("click", function () {
          log("toolbar action", item.action);
          runShortcut(item.action);
        });
        row.appendChild(button);
      });

      var collapse = document.createElement("button");
      collapse.className = "fenbi-toolbar-collapse";
      collapse.textContent = "收起 ⌃";
      collapse.addEventListener("click", function () {
        setToolbarState("collapsed");
      });
      bar.appendChild(collapse);
    }

    render(readToolbarState());
    document.body.insertBefore(host, document.body.firstChild || null);
  }


  /* ------------------------------------------------------------------ */

  var host = location.hostname;
  var isFenbi = /(^|\.)fenbi\.com$/i.test(host);
  var isLocalTest =
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!isFenbi && !isLocalTest) return;

  function log(msg, extra) {
    var detail = extra === undefined ? "" : String(extra);
    if (DEBUG) {
      try {
        console.log("[fenbi-wrapper]", msg, detail);
      } catch (e) {}
      // HTTPS 页面不能 fetch localhost，但 Image 请求放行
      try {
        new Image().src =
          "http://127.0.0.1:8799/log?m=" +
          encodeURIComponent(String(msg) + " :: " + detail);
      } catch (e) {}
    }
  }

  /* ------------------------------------------------------------------ *
   * 键盘快捷键
   *
   * WebView 没有浏览器 chrome，所以自己实现。四个动作与顶部横栏一一对应：
   *   macOS            Windows / Linux
   *   Cmd+[            返回上一页
   *   Cmd+]            前进
   *   Cmd+⇧+[          回题库目录页
   *   Cmd+R            刷新
   * 用捕获阶段监听，在站点自己的按键处理之前拿到事件，并 preventDefault，
   * 不让按键漏给站点（站点自己没有任何全局 keydown 处理，实测）。
   * ------------------------------------------------------------------ */

  /* 按键名：优先用 e.code（物理键，不受键盘布局影响），拿不到再退回 e.key。
   * 返回空串表示这个键不参与判断。 */
  function keyName(e) {
    if (e.code === "BracketLeft") return "[";
    if (e.code === "BracketRight") return "]";
    if (e.code === "KeyR") return "r";
    if (e.code === "ArrowLeft") return "left";
    if (e.code === "ArrowRight") return "right";
    var key = typeof e.key === "string" ? e.key.toLowerCase() : "";
    if (key === "[" || key === "{") return "[";
    if (key === "]" || key === "}") return "]";
    if (key === "r") return "r";
    if (key === "arrowleft") return "left";
    if (key === "arrowright") return "right";
    return "";
  }

  /* 键位 → 动作（空串表示不处理）。 */
  function shortcutAction(e, mac) {
    var key = keyName(e);
    if (mac) {
      if (!e.metaKey || e.ctrlKey || e.altKey) return "";
      if (key === "[") return e.shiftKey ? "catalog" : "back";
      if (key === "]") return e.shiftKey ? "" : "forward";
      if (key === "r") return e.shiftKey ? "" : "reload";
      return "";
    }
    // Windows / Linux：返回与前进用浏览器惯例的 Alt+方向键
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (key === "left") return "back";
      if (key === "right") return "forward";
      return "";
    }
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      if (key === "[") return e.shiftKey ? "catalog" : "";
      if (key === "r") return e.shiftKey ? "" : "reload";
    }
    return "";
  }

  function runShortcut(action) {
    if (action === "back") {
      history.back();
    } else if (action === "forward") {
      history.forward();
    } else if (action === "reload") {
      location.reload();
    } else if (action === "catalog") {
      location.replace(TARGET_URL);
    }
  }

  function installShortcuts() {
    var mac = isMacPlatform();
    window.addEventListener(
      "keydown",
      function (e) {
        var action = shortcutAction(e, mac);
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        log("shortcut: " + action);
        runShortcut(action);
      },
      true
    );
  }

  function invoke(cmd, args) {
    var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (!inv) return null;
    try {
      return inv(cmd, args);
    } catch (e) {
      return null;
    }
  }

  function applyUiTweaks() {
    if (!CLEAN_CSS) return;
    try {
      var style = document.createElement("style");
      style.setAttribute("data-fenbi-wrapper", "tweaks");
      style.textContent = CLEAN_CSS;
      (document.head || document.documentElement).appendChild(style);
    } catch (e) {}
  }

  function isVisible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  function loginModalOpen() {
    var nodes = document.querySelectorAll(".login-web-modal, fb-qrcode-login-modal");
    for (var i = 0; i < nodes.length; i++) {
      if (isVisible(nodes[i])) return true;
    }
    return false;
  }

  function loginButton() {
    return document.querySelector(
      ".header-content-logon-btn, .header-content-login-btn"
    );
  }

  /* 弹一次登录框。
   *
   * 「启动 0 等待」的落地：不预先 sleep，直接看按钮在不在；
   * 不在就每 250ms 重试（站点渲染 header 需要一点时间），一出现立刻点。
   *
   * ⚠️ 重试必须能取消，而且每一步都要重新确认还该不该弹。曾经只写了
   * "按钮出现就点"，于是登录已经恢复、Rust 已经判过"观测到凭证"之后，
   * 这个 interval 还会继续点到按钮出现为止。 */
  var promptTimer = null;

  function cancelLoginPrompt(reason) {
    if (promptTimer === null) return;
    clearInterval(promptTimer);
    promptTimer = null;
    log("login prompt cancelled", reason);
  }

  function openLoginOnce(reason) {
    if (verifiedLoggedIn) {
      log("verified logged in, no prompt", reason);
      return;
    }
    if (loginModalOpen()) {
      log("login modal already open", reason);
      return;
    }
    if (loginButton()) {
      doOpenLogin(reason);
      return;
    }

    // 重复事件合并：起新的重试前先掐掉旧的，避免两个 interval 同时点
    cancelLoginPrompt("superseded by new request");

    var tries = 0;
    promptTimer = setInterval(function () {
      tries++;
      if (verifiedLoggedIn) {
        cancelLoginPrompt("verified logged in meanwhile");
        return;
      }
      if (loginModalOpen()) {
        cancelLoginPrompt("modal appeared while waiting");
        return;
      }
      if (loginButton()) {
        cancelLoginPrompt("button appeared");
        doOpenLogin(reason);
        return;
      }
      if (tries >= LOGIN_BTN_RETRIES) {
        cancelLoginPrompt("login button never appeared");
      }
    }, LOGIN_BTN_RETRY_MS);
  }

  function doOpenLogin(reason) {
    var btn = loginButton();
    if (!btn) return;
    log("open login modal", reason);
    btn.click();

    if (!OPEN_QR) return;
    setTimeout(function () {
      var qr = document.querySelector(".qrcode-wrap");
      if (qr) {
        qr.click();
        log("switched to qr login", reason);
      }
    }, QR_RENDER_DELAY_MS);
  }

  /* Rust 侧心跳/判定观测不到会话时推来。
   *
   * 立刻提示，不分页面。练习/考试/报告页也一样：站点自己实时上报答题数据，
   * 包装层不需要（也不该）替它判断"现在打不打扰"。第二个参数是 Rust 早期版本
   * 传来的 deferred 标记，现在忽略。 */
  window.__fenbiLoggedOut = function (why) {
    log("logged out (" + why + ")");
    requestLoginPrompt("logged-out:" + why);
  };

  /* 权威判定说"观测到凭证"时置位：启动路径那个延迟弹框要据此取消。 */
  var verifiedLoggedIn = false;

  /* 请求弹登录框：任何时候都直接弹。 */
  function requestLoginPrompt(reason) {
    if (verifiedLoggedIn) {
      log("verified logged in, drop prompt request", reason);
      return;
    }
    openLoginOnce(reason);
  }

  /* Rust 侧观测到凭证时推来。
   *
   * 只做一件事：把所有还没执行的弹框取消掉——凭证已经在了，再弹就是打扰。
   *
   * ⚠️ 这里**不再**安排「登录后回目录页」。站点登录后会自己重定向到它的
   * 试卷列表页，那是站内页面，用户待在那儿是正常的；wrapper 硬把他拉回
   * 目录页，反而会顶掉他刚打开的搜索结果页。目录页只作为冷启动入口出现。 */
  window.__fenbiLoginSucceeded = function () {
    verifiedLoggedIn = true;
    cancelLoginPrompt("credentials observed");
    log("login succeeded");
  };

  installShortcuts();

  /* 启动：读一次记录就行动，不等任何 cookie。
   *   观测到已登录 -> 什么都不做（用户停在站点当前页面）
   *   没有记录     -> 弹登录框
   *
   * 但记录可能是过期的，而权威判定要等页面加载完成（约 1.5 秒）才有结果。
   * 所以这里**不能立刻弹框**——先短延迟一次，让判定有机会先纠正。
   * 曾因此对一个已登录用户弹出登录框：脚本 0.2 秒就读到过期的 false，
   * 而判定 1.5 秒才把记录改成 true。 */
  var initialPromptDelayMs = 800;

  function start() {
    // 只记路径：完整 URL 的 query 可能带用户信息，不进日志/beacon
    log("wrapper active", location.pathname + " | entry=" + TARGET_URL);
    applyUiTweaks();
    installToolbar();

    var p = invoke("is_known_logged_in");
    if (!p) {
      log("invoke unavailable");
      return;
    }

    p.then(
      function (knownLoggedIn) {
        if (knownLoggedIn) {
          log("record says logged in -> leave the site alone");
          return;
        }
        log("record says logged out, prompt in " + initialPromptDelayMs + "ms");
        setTimeout(function () {
          requestLoginPrompt("not-logged-in");
        }, initialPromptDelayMs);
      },
      function (err) {
        log("is_known_logged_in failed", String(err));
      }
    );
  }

  /* 仅 debug 构建暴露的内部观察口：排查时确认脚本的调度状态。
   * release 构建下 DEBUG 为 false，不会挂这个对象。 */
  if (DEBUG) {
    window.__fenbiWrapperInternals = {
      /* 时间参数一并暴露，测试就不必把生产代码里的数值抄一遍 */
      timings: {
        initialPromptDelayMs: initialPromptDelayMs,
        loginBtnRetryMs: LOGIN_BTN_RETRY_MS,
        loginBtnRetries: LOGIN_BTN_RETRIES,
      },
      verifiedLoggedIn: function () {
        return verifiedLoggedIn;
      },
      promptTimerActive: function () {
        return promptTimer !== null;
      },
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
