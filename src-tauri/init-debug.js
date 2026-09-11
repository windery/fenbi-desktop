/* 仅诊断用的注入代码片段。只拼接进 debug 构建的注入脚本，
 * release 构建里根本不存在（见 lib.rs 的 cfg!(debug_assertions)）。
 *
 * 用途：
 *   1. 驱动站点自己的「退出登录」，验证登出检测链路
 *   2. 追踪 SPA 导航，排查「点了去练习但页面没变」这类问题
 */
(function () {
  window.__fenbiDebugRequestLogout = function () {
    var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (inv) {
      try {
        inv("debug_request_logout");
      } catch (e) {}
    }
  };

  /* 导航追踪：patch History API + 监听点击，把「点了什么、路由变成什么」打出来。
   * 不依赖 init.js 里的 log（那个在 IIFE 作用域内），直接发 beacon。 */
  function beacon(tag, detail) {
    try {
      new Image().src =
        "http://127.0.0.1:8799/log?m=" +
        encodeURIComponent("NAV[" + tag + "] " + detail);
    } catch (e) {}
  }

  ["pushState", "replaceState"].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function () {
      beacon(fn, "-> " + String(arguments[2]) + " | from " + location.pathname);
      return orig.apply(this, arguments);
    };
  });

  window.addEventListener(
    "click",
    function (e) {
      var el = e.target;
      var found = null;
      for (var i = 0; i < 5 && el; i++) {
        var t = (el.textContent || "").trim();
        if (t && t.length < 30) {
          found = { tag: el.tagName, cls: String(el.className).slice(0, 50), text: t };
          if (/去练习|开始|继续/.test(t)) break;
        }
        el = el.parentElement;
      }
      if (found && /去练习|开始做题|继续练习/.test(found.text)) {
        beacon(
          "click",
          found.text + " <" + found.tag + "." + found.cls + "> | path=" + location.pathname
        );
        setTimeout(function () {
          beacon(
            "after-click",
            "path=" + location.pathname + " | search=" + location.search
          );
        }, 1500);
      }
    },
    true
  );

  window.addEventListener("beforeunload", function () {
    beacon("beforeunload", location.pathname);
  });

  beacon("nav-trace-ready", location.pathname);
})();
