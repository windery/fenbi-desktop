/* 仅诊断用的注入代码片段。只拼接进 debug 构建的注入脚本，
 * release 构建里根本不存在（见 lib.rs 的 cfg!(debug_assertions)）。
 *
 * 用来驱动站点自己的「退出登录」，验证退出检测链路。
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
  })();
