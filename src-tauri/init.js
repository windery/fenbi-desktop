/* 粉笔刷题 wrapper —— 注入脚本
 *
 * 由 src-tauri/src/lib.rs 通过 WebviewWindowBuilder::initialization_script() 注入。
 *
 * ## 职责边界
 *
 * 登录态的**唯一权威**是 Rust 侧维护的状态记录（app 数据目录下的 `login-state`）。
 * 这个脚本不查 cookie、不判登录态、不做定时检测，只做三件事：
 *
 *   1. 启动时读一次记录：已登录 -> 进目录页，未登录 -> 立刻弹登录框
 *   2. 响应 Rust 推来的「已登出」事件：弹登录框
 *   3. 响应 Rust 推来的「已登录」事件：进目录页
 *
 * ## 为什么不在页面里判登录态
 *
 * 凭证是 HttpOnly cookie，JS 读不到；而冷启动时站点还要靠 `persistent` cookie
 * 把 `sess` 恢复出来，这段空窗期里 DOM 和 cookie 都显示"未登录"。
 * 在页面里判会误判，于是每次启动都白弹一次登录框。判定全部交给 Rust。
 *
 * ## 不干预站点
 *
 * 登录、做题、分类选择都走站点自己的逻辑。脚本不刷新页面、不模拟站点操作。
 */
(function () {
  "use strict";

  var TARGET_URL = "__TARGET_URL__";
  var DEBUG = __DEBUG__;

  /* 弹登录框后是否自动切到扫码登录。
   * 默认 false：停在站点默认的短信验证码登录（用户要哪种自己点）。
   * 想要桌面端扫码免输手机号就改成 true。 */
  var OPEN_QR = false;

  /* 切到扫码后等二维码渲染出来的时间 */
  var QR_RENDER_DELAY_MS = 900;

  /* 登录成功后进目录页前的小停顿，避免和站点自己的收尾流程打架。 */
  var GO_AFTER_LOGIN_DELAY_MS = 600;

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

  /* 整块移除（页脚本来就不参与顶栏布局，display:none 没问题） */
  var HIDE_SELECTORS = [
    "#fenbi-web-footer",
    ".fb-footer-wrapper",
  ];

  /* 不可见但保留占位（用于顶栏这类参与 flex 布局的元素） */
  var INVISIBLE_SELECTORS = [
    "nav.fb-web-nav", // 首页 / 课程 / 题库 / 关于粉笔 / 下载客户端 / 投资者关系
  ];

  function buildCleanCss() {
    var css = "";
    if (HIDE_SELECTORS.length) {
      css += HIDE_SELECTORS.join(",\n") + " { display: none !important; }\n";
    }
    if (INVISIBLE_SELECTORS.length) {
      // 宽度归零 + 不可见，但都保留在 flex 流里（visibility 不脱离流，
      // 所以 nav 的 flex-grow:1 仍然生效，把右侧头像顶到最右）
      css +=
        INVISIBLE_SELECTORS.join(",\n") +
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
    return css;
  }

  var CLEAN_CSS = UI_TWEAKS ? buildCleanCss() : "";

  /* ------------------------------------------------------------------ */

  var host = location.hostname;
  var isFenbi = /(^|\.)fenbi\.com$/i.test(host);
  var isLocalTest = host === "127.0.0.1" || host === "localhost";
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
   * WebView 没有浏览器的地址栏和快捷键，所以自己实现。
   *   Cmd+R / Ctrl+R  重新加载当前页
   *
   * 用捕获阶段监听，尽量在站点自己的按键处理之前拿到事件。
   * ------------------------------------------------------------------ */
  function installShortcuts() {
    window.addEventListener(
      "keydown",
      function (e) {
        var mod = e.metaKey || e.ctrlKey;
        if (!mod || e.altKey || e.shiftKey) return;
        if (e.key !== "r" && e.key !== "R") return;

        e.preventDefault();
        e.stopPropagation();
        log("shortcut: reload");
        location.reload();
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
   * 不在就每 250ms 重试（站点渲染 header 需要一点时间），
   * 一出现立刻点，然后切扫码。 */
  function openLoginOnce(reason) {
    if (loginModalOpen()) {
      log("login modal already open", reason);
      return;
    }
    if (loginButton()) {
      doOpenLogin(reason);
      return;
    }

    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (loginModalOpen()) {
        clearInterval(timer);
        log("login modal appeared while waiting", reason);
        return;
      }
      if (loginButton()) {
        clearInterval(timer);
        doOpenLogin(reason);
        return;
      }
      if (tries >= LOGIN_BTN_RETRIES) {
        clearInterval(timer);
        log("login button never appeared, giving up", reason);
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

  /* 进目录页。目录页会自己恢复上次选的分类，所以不需要我们关心分类。 */
  function goToCatalog(reason) {
    if (location.pathname === TARGET_PATH()) {
      log("already at catalog", reason);
      return;
    }
    log("go to catalog", reason + " | from=" + location.pathname);
    location.replace(TARGET_URL);
  }

  function TARGET_PATH() {
    return TARGET_URL.replace(/^https?:\/\/[^/]+/i, "").split("?")[0];
  }

  /* Rust 侧心跳/运行时检测到会话失效时推来。 */
  window.__fenbiLoggedOut = function (why) {
    log("logged out (" + why + ") -> open login modal");
    openLoginOnce("logged-out:" + why);
  };

  /* Rust 侧检测到登录成功时推来。 */
  window.__fenbiLoginSucceeded = function () {
    log("login succeeded -> go to catalog");
    setTimeout(function () {
      goToCatalog("login-succeeded");
    }, GO_AFTER_LOGIN_DELAY_MS);
  };

  installShortcuts();

  /* 启动：读一次记录就行动，不等任何 cookie。
   *   已登录 -> 直接进目录页
   *   未登录 -> 立刻弹登录框
   */
  function start() {
    log("wrapper active", location.href + " | target=" + TARGET_URL);
    applyUiTweaks();

    var p = invoke("is_known_logged_in");
    if (!p) {
      log("invoke unavailable");
      return;
    }

    p.then(
      function (knownLoggedIn) {
        if (knownLoggedIn) {
          log("record says logged in -> catalog");
          goToCatalog("known-logged-in");
        } else {
          log("record says logged out -> open login modal");
          openLoginOnce("not-logged-in");
        }
      },
      function (err) {
        log("is_known_logged_in failed", String(err));
      }
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
