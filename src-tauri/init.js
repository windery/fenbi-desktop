/* 粉笔刷题 wrapper —— 注入脚本
 *
 * 由 src-tauri/src/lib.rs 通过 WebviewBuilder::initialization_script() 注入。
 *
 * ## 职责边界
 *
 * 这个脚本不查 cookie、不判登录态、不做定时检测——凭证只能由 Rust 侧读
 * （HttpOnly，JS 拿不到）。它只消费 Rust 收敛出的「当前登录决策」：
 *
 *   1. 文档就绪后重读一次 current_login_decision() -> (seq, kind)
 *   2. Rust 每次 wake 只 eval __fenbiRefreshLoginDecision()，**不带结论**；
 *      页面收到就再重读一次当前快照
 *   3. pending 未知不动；logged-in 取消待执行的提示；logged-out 弹登录框
 *
 * wake 不带结论是关键：旧文档留下的 eval 落到新文档，也只会读到新快照的
 * pending，因此不需要 document token 去识别陈旧结论。
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
 * `login-state` 是本地凭证观察记录，不参与页面启动提示决策；页面只消费 Rust 当前
 * 快照，本地凭证不代表服务端会话有效。
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

  /* 收到有效 logged-out 结果后，按钮尚未渲染时每 250ms 重试，最多 24 次。 */
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
   *     ├── a.fenbi-icon-url        粉笔 logo      -> 保留可见但**不可点**（见下）
   *     ├── nav.fb-web-nav          6 个 tab       -> 隐藏
   *     └── .header-content-logon   登录 / 用户头像 -> **必须保留**
   *         └── #userlogout.popover 用户菜单：账号 / 我的课程 / 退出登录
   *                                  -> 只藏「我的课程」，其余保留
   *
   * ⚠️ 不要隐藏整个 header：登录按钮和用户菜单都在里面，
   *    隐藏了就没法登录、也没法退出登录。
   *
   * ⚠️ 顶栏不能用 `display: none` 隐藏。这是踩过的坑：
   *    nav.fb-web-nav 带 `flex-grow: 1`，它占满剩余空间、把右侧的头像顶到最右。
   *    一旦 display:none 让它脱离 flex 流，这个 flex-grow 就失效，
   *    logo 和头像会挤到一起。所以改成「不可见但仍占位」：
   *    visibility:hidden 不脱离流，空间照旧，头像就还在右上角。
   *
   * ⚠️ logo 保留可见、只去掉点击：整块拿掉会让顶栏左端空一截。
   *    它原本跳到 fenbi.com 首页，属于「离开刷题」的入口。
   *    做法是 pointer-events:none（见 NON_INTERACTIVE_SELECTORS），
   *    同时挡掉鼠标点击与键盘 Enter 激活；href 仍在 DOM 里。
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
   * 目录页 `.course-bar > li.exam-header-row` 里的入口（实测）：
   *   DIV.current-exam             当前考试 + 下拉箭头（切考试类型）          -> 保留
   *   DIV.member-area              「职测会员卡 / 尚未开通」+ 悬停扫码卡片    -> 移除
   *   A.cube-module-button         「粉笔魔方」                              -> 保留（实用功能）
   *   DIV.question-search-area     搜题框（试题 / 试卷）                     -> 保留
   *
   * 父容器高度是被内容撑开的（实测隐藏横幅后每层都恰好 -196px，
   * 即 180 高 + 16 上下 margin），所以不需要手工降高，也不会留空白。 */
  var HIDE_SELECTORS = [
    "app-award-exam-banner", // 「粉笔模考奖学金争霸赛」活动横幅
    // 「职测会员卡 / 尚未开通」图标，外加**悬停时**从它内部弹出来的扫码买会员卡片
    // （卡片就是 .member-area 里的 article.buy-member-app-popup，删入口即可，无需单独处理）
    ".member-area",
    // 用户菜单里的「我的课程」（跳 /spa/pwa/tourist/gwy）。菜单项 class 全一样，
    // 只有它一个是 <a>，所以用标签+class 定位；同菜单的账号行与「退出登录」必须保留。
    "#userlogout a.popover-content",
    // 帮助问号。实测它挂在 app-award-exam-banner 内部（已被上面摘掉），
    // 这里再单独列一条，覆盖它将来出现在顶栏里的情况。
    "i.paper-tag-help",
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

  /* C 类：保留可见，只去掉点击。
   *
   * 用于「东西要留在原位，但它是个离开刷题的入口」。目前只有粉笔 logo：
   * 它跳到 fenbi.com 首页。整块拿掉会让顶栏左端空一截，所以保留外观。
   *
   * pointer-events:none 同时挡掉鼠标点击与键盘 Enter 激活；href 仍在 DOM 里
   * （本层只注入 CSS，不动站点节点）。cursor:default 去掉小手，
   * 免得看起来还能点。 */
  var NON_INTERACTIVE_SELECTORS = [
    "a.fenbi-icon-url", // 粉笔 logo -> 原本跳 fenbi.com 首页
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
    if (NON_INTERACTIVE_SELECTORS.length) {
      css +=
        NON_INTERACTIVE_SELECTORS.join(",\n") +
        " {\n" +
        "  visibility: visible !important;\n" +
        "  pointer-events: none !important;\n" +
        "  cursor: default !important;\n" +
        "}\n";
    }
    // 压高度 + 去底色（页脚自身是深色底，不去掉的话留白是黑的）
    css += SHRINK_HEIGHT_CSS + "\n";
    return css;
  }

  var CLEAN_CSS = UI_TWEAKS ? buildCleanCss() : "";

  var keys = window.__fenbiKeys;
  var isMacPlatform = keys.isMac, shortcutAction = keys.action;

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
   * WebView 没有浏览器 chrome，所以自己实现。五个动作与顶部横栏一一对应：
   *   macOS            Windows / Linux
   *   Cmd+[            返回上一页
   *   Cmd+]            前进
   *   Cmd+⇧+[          回题库目录页
   *   Cmd+R            刷新
   *   Cmd+⇧+B          展开 / 收起工具横栏
   * 键位本身写在 toolbar/shortcuts.js 的 KEY_BINDINGS 里（按钮上的提示由同一张表生成，不会走偏）。
   * 用捕获阶段监听，在站点自己的按键处理之前拿到事件，并 preventDefault，
   * 不让按键漏给站点（站点自己没有任何全局 keydown 处理，实测）。
   * ------------------------------------------------------------------ */

  function runShortcut(action) {
    if (action === "back") {
      history.back();
    } else if (action === "forward") {
      history.forward();
    } else if (action === "reload") {
      location.reload();
    } else if (action === "catalog") {
      if (location.href !== TARGET_URL) location.assign(TARGET_URL);
    } else if (action === "toggle") {
      var pending = invoke("toggle_toolbar");
      if (pending) pending.catch(function (err) { log("toolbar toggle failed", String(err)); });
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

  /* ------------------------------------------------------------------ *
   * 登录提示
   *
   * Rust 侧收敛「当前登录决策」，页面只做两件事：文档就绪后重读一次
   * current_login_decision()，以及收到 Rust 的 wake 时再重读。wake 不携带
   * 结论，所以旧文档留下的 wake 落到新文档时，读到的只是新快照的 pending。
   *
   * 读回来的 (seq, kind) 按 seq 去重：较旧/重复的结果一律丢弃，并发的重读
   * 乱序返回也不会覆盖更新的结论。kind 的三种取值：
   *
   *   pending     未知：取消还没执行的「等按钮」重试，但不重置已 requested 的
   *               闩锁——只有页面真正换文档才是全新的状态
   *   logged-in   观测到凭证：取消所有待执行提示；之后 Absent 开启新一轮
   *   logged-out  观测不到会话：交给下面的提示状态机
   *
   * 提示状态机：
   *   idle       没有待办。只有这个状态才会真的去点登录按钮
   *   waiting    想提示，但登录按钮还没渲染出来，重试定时器在跑
   *   requested  这一轮已经请求过（按过按钮、登录框已在屏幕上，或重试已用尽）
   *   logged-in  观测到凭证；收到 Absent 通知之前不再提示
   *
   * 一个"轮"由凭证变化划定：从 idle 发出一次登录请求进入 requested，此后同一轮
   * 里的 Absent 一律合并，不再点第二次，重试预算也不会被重复通知重置。只有真正
   * 观测到凭证（logged-in）之后的 Absent 才开启新一轮。
   *
   * markRequested 必须在 click 之前：站点可能在 click 的同步回调里再推一条
   * Absent，状态后置会让那次通知重入并点第二次。
   * ------------------------------------------------------------------ */

  var PROMPT_IDLE = "idle";
  var PROMPT_WAITING = "waiting";
  var PROMPT_REQUESTED = "requested";
  var PROMPT_LOGGED_IN = "logged-in";

  var promptState = PROMPT_IDLE;

  /* 已应用的最大决策序号；严格更大才接受，用来丢弃较旧/重复的乱序结果。 */
  var loginDecisionSeq = -1;

  /* 文档是否就绪：未就绪时不读、更不点；start() 就绪后统一重读。 */
  var loginDecisionReady = false;

  /* 只有 waiting 状态下存在的重试定时器。 */
  var promptTimer = null;

  function cancelLoginPrompt(reason) {
    if (promptTimer === null) return;
    clearInterval(promptTimer);
    promptTimer = null;
    log("login prompt cancelled", reason);
  }

  function markRequested() {
    promptState = PROMPT_REQUESTED;
  }

  /* 请求弹登录框：所有 logged-out 决策都走这一处。
   *
   * 会话失效常常连报几次。收到 Present 之前都属于同一轮登录尝试，重复请求
   * 必须合并成一次——旧实现每次通知都从头走一遍，于是对同一个登录表单连点。 */
  function requestLoginPrompt(reason) {
    if (promptState === PROMPT_LOGGED_IN) {
      log("verified logged in, drop prompt request", reason);
      return;
    }
    if (promptState === PROMPT_REQUESTED) {
      log("login attempt in flight, drop duplicate request", reason);
      return;
    }
    if (promptState === PROMPT_WAITING) {
      // 还在等按钮：按钮/登录框这时出现了就接手，否则保留原重试预算，不重置
      if (loginModalOpen()) {
        cancelLoginPrompt("modal appeared while waiting");
        markRequested();
        return;
      }
      if (loginButton()) {
        cancelLoginPrompt("button appeared while waiting");
        doOpenLogin(reason);
        return;
      }
      log("prompt already waiting for button, drop duplicate request", reason);
      return;
    }
    if (loginModalOpen()) {
      // 登录框就在屏幕上：不用点，记成"登录进行中"就够了
      log("login modal already open", reason);
      markRequested();
      return;
    }
    if (loginButton()) {
      doOpenLogin(reason);
      return;
    }
    waitForLoginButton(reason);
  }

  /* 收到有效的「缺凭证」结论后，按钮可能还没渲染出来：在这里排队等待。
   * 每一步都重新确认结论还有效——期间若读到 Present（已登录）或 pending（未知），
   * 就取消这次等待，不再点按钮。 */
  function waitForLoginButton(reason) {
    cancelLoginPrompt("superseded by new request");
    promptState = PROMPT_WAITING;

    var tries = 0;
    promptTimer = setInterval(function () {
      tries++;
      if (promptState !== PROMPT_WAITING) {
        cancelLoginPrompt("state changed meanwhile");
        return;
      }
      if (loginModalOpen()) {
        cancelLoginPrompt("modal appeared while waiting");
        markRequested();
        return;
      }
      if (loginButton()) {
        cancelLoginPrompt("button appeared");
        doOpenLogin(reason);
        return;
      }
      if (tries >= LOGIN_BTN_RETRIES) {
        // 预算用尽也留在同一轮：重复通知不该把重试重置、从头再来一遍
        markRequested();
        cancelLoginPrompt("login button never appeared");
      }
    }, LOGIN_BTN_RETRY_MS);
  }

  /* 点站点自己的登录入口按钮 —— 包装层唯一允许的一次点击。
   *
   * 点之前先进入 requested：站点渲染登录框是异步的，在它显示出来之前，
   * 重复的登出通知必须并进这一轮，否则会对同一个登录表单点两次。 */
  function doOpenLogin(reason) {
    var btn = loginButton();
    if (!btn) return;
    // 先记 requested 再点：站点可能在 click 的同步回调里再报一次登出，
    // 状态后置会让那次通知重入并点第二次。
    markRequested();
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

  /* 应用一条决策：seq 必须严格前进，较旧/重复的结果丢弃。 */
  function applyLoginDecision(raw) {
    if (!raw || raw.length < 2) return;
    var seq = Number(raw[0]);
    var kind = raw[1];
    if (!isFinite(seq) || seq <= loginDecisionSeq) {
      log("drop stale login decision", seq + " " + kind);
      return;
    }
    loginDecisionSeq = seq;
    log("login decision", seq + " " + kind);

    if (kind === "logged-in") {
      // 凭证已经在了：整体推到 logged-in，取消所有还没执行的弹框
      promptState = PROMPT_LOGGED_IN;
      cancelLoginPrompt("credentials observed");
    } else if (kind === "logged-out") {
      // 「观测不到会话」是真正变化的那一半：把 logged-in 清掉，新一轮才能重新提示
      if (promptState === PROMPT_LOGGED_IN) promptState = PROMPT_IDLE;
      requestLoginPrompt("logged-out");
    } else if (promptState === PROMPT_WAITING) {
      // pending：未知。停掉还没执行的等待，但不碰已 requested 的闩锁。
      cancelLoginPrompt("decision pending");
      promptState = PROMPT_IDLE;
    }
  }

  /* 重读当前快照。读不出来就保持未知：绝不据错误下结论、弹框。 */
  function readLoginDecision() {
    var p = invoke("current_login_decision");
    if (!p) {
      log("invoke unavailable");
      return;
    }
    p.then(applyLoginDecision, function (err) {
      log("current_login_decision failed", String(err));
    });
  }

  /* Rust 的 wake：只表示「快照可能变了」，不带任何结论。
   * 未就绪时先不读也不点——start() 就绪后的那次重读拿到的至少和它一样新。 */
  window.__fenbiRefreshLoginDecision = function () {
    if (!loginDecisionReady) {
      log("login decision refresh before DOM ready, deferred");
      return;
    }
    readLoginDecision();
  };

  installShortcuts();

  /* 启动：文档就绪后重读一次当前决策，不读缓存、不等固定时长。
   * 生效与否完全由 Rust 的 (seq, kind) 决定——未知（pending）就什么都不做。
   * 就绪前到达的 wake 不单独排队：这次重读的快照至少和它一样新。 */
  function start() {
    // 只记路径：完整 URL 的 query 可能带用户信息，不进日志/beacon
    log("wrapper active", location.pathname + " | entry=" + TARGET_URL);
    applyUiTweaks();

    loginDecisionReady = true;
    readLoginDecision();
  }

  /* 仅 debug 构建暴露的内部观察口：排查时确认脚本的调度状态。
   * release 构建下 DEBUG 为 false，不会挂这个对象。 */
  if (DEBUG) {
    window.__fenbiWrapperInternals = {
      /* 时间参数一并暴露，测试就不必把生产代码里的数值抄一遍 */
      timings: {
        loginBtnRetryMs: LOGIN_BTN_RETRY_MS,
        loginBtnRetries: LOGIN_BTN_RETRIES,
      },
      promptState: function () {
        return promptState;
      },
      /* 还有没有"等按钮出现"的排队提示没执行 */
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
