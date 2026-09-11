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

  /* 是否在练习/考试流程内：此时**绝不能**跳转，否则会把用户从做题页踹走。
   *
   * ⚠️ 这里必须用"黑名单"思路（明确哪些是练习区）而不是"只放行 /tiku"。
   * 踩过的坑：最初只识别 /tiku/exercise 等，结果真实的练习页在
   *   spa.fenbi.com/ti/exam/exercise/<id>
   * ——不在 /tiku 下，于是保护形同虚设：用户一点「去练习」，
   * 新页面加载后脚本发现不在目录页，立刻把他踹回目录页，
   * 表现就是"点了没反应"。 */
  var PRACTICE_PREFIXES = [
    "/ti/", // 真实练习/考试页：/ti/exam/exercise/<id>、/ti/... 等
    "/tiku/exercise",
    "/tiku/guide/realTest",
    "/tiku/report",
  ];

  function insidePractice() {
    var p = location.pathname;
    for (var i = 0; i < PRACTICE_PREFIXES.length; i++) {
      if (p.indexOf(PRACTICE_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  /* 进目录页。
   *
   * ⚠️ 这里的"已在目标页就返回"不只是省事，它是**防重载循环的必要条件**：
   * 若在已位于目录页时还 location.replace，页面会重载 → 脚本重跑 →
   * 又走到这里 → 再次 replace，启动路径直接陷入死循环。 */
  function goToCatalog(reason) {
    if (location.pathname === TARGET_PATH()) {
      log("already at catalog", reason);
      return;
    }
    // 用户在练习页就绝不打扰
    if (insidePractice()) {
      log("inside practice, never redirect", reason + " | " + location.pathname);
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

  /* 权威判定说"已登录"时置位。用来取消启动路径上那个可能已经排队的弹框。 */
  var verifiedLoggedIn = false;

  /* Rust 侧检测到登录成功时推来。
   *
   * 站点在登录后会自己重定向到试卷列表（实测 catalog → /spa/tiku/ →
   * /spa/tiku/guide/home/{courseSet}/{prefix}），所以这里打个一次性标记，
   * 让下一个页面（无论站点把我们带到哪）自己跳回目录页。
   *
   * 为什么不在当前页面直接 location.replace：站点紧接着还会重定向，
   * 我们会被覆盖掉。等它跳完、页面重新加载后再纠正，才抢得过。 */
  window.__fenbiLoginSucceeded = function () {
    verifiedLoggedIn = true;
    log("login succeeded -> schedule return to catalog");
    try {
      sessionStorage.setItem("fenbi-return-catalog", String(Date.now()));
    } catch (e) {}
  };

  /* 登录后的一次性纠正：若刚登录完却不在目录页，跳回去。
   * 标记只用一次，因此不会和"已在目录页就返回"的防循环逻辑冲突。 */
  var RETURN_WINDOW_MS = 60000;
  function applyPendingReturn(reason) {
    var raw = null;
    try {
      raw = sessionStorage.getItem("fenbi-return-catalog");
    } catch (e) {}
    if (!raw) return false;

    try {
      sessionStorage.removeItem("fenbi-return-catalog");
    } catch (e) {}

    var age = Date.now() - parseInt(raw, 10);
    if (!(age >= 0 && age < RETURN_WINDOW_MS)) {
      log("pending return expired, ignore", String(age));
      return false;
    }
    if (location.pathname === TARGET_PATH()) {
      log("pending return: already at catalog", reason);
      return false;
    }
    // 登录后如果用户已经自己进练习页了，别把他拉回目录页
    if (insidePractice()) {
      log("pending return skipped: inside practice", location.pathname);
      return false;
    }

    log("pending return -> back to catalog from " + location.pathname, reason);
    location.replace(TARGET_URL);
    return true;
  }

  installShortcuts();

  /* 启动：读一次记录就行动，不等任何 cookie。
   *   已登录 -> 直接进目录页
   *   未登录 -> 弹登录框
   *
   * 但记录可能是过期的，而权威判定要等页面加载完成（约 1.5 秒）才有结果。
   * 所以这里**不能立刻弹框**——先短延迟一次，让判定有机会先纠正。
   * 曾因此对一个已登录用户弹出登录框：脚本 0.2 秒就读到过期的 false，
   * 而判定 1.5 秒才把记录改成 true。 */
  var initialPromptDelayMs = 800;

  function start() {
    log("wrapper active", location.href + " | target=" + TARGET_URL);
    applyUiTweaks();

    // 刚登录完却被站点带去别处 -> 先纠正回来
    if (applyPendingReturn("start")) return;

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
          return;
        }
        log("record says logged out, prompt in " + initialPromptDelayMs + "ms");
        setTimeout(function () {
          if (verifiedLoggedIn) {
            log("verify said logged in meanwhile -> skip prompt");
            return;
          }
          openLoginOnce("not-logged-in");
        }, initialPromptDelayMs);
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
