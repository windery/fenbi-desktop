/* 粉笔刷题 wrapper —— 粉笔页面拿到的功能设置（划词标记、解析页分栏）
 *
 * 由 src-tauri/src/lib.rs 拼在 initialization_script 最前面；下面 current 的占位符由 Rust 换成
 * 启动时的设置（settings.rs，过了校验的 JSON）。之后设置页面保存、或页面加载完成时，
 * Rust 用 eval 调 window.__fenbiApplySettings(新设置) 推新值。
 *
 * initialization_script 建 WebView 时就定死了：设置改过之后整页重载，新文档一开始拿到的还是启动时那份。
 * 所以 ready() 在收到第一次推送（每个文档加载完成时 Rust 都会推一次）之前是 false，
 * 划词脚本在那之前不处理输入、不读写标记；分栏样式先按启动时那份画，收到推送再改。
 *
 * 粉笔页面没有任何读写设置的 IPC 权限：设置只从 Rust 这边单向推过来。
 * init.js（分栏）和 highlight.js（划词）在自己开头拿走 __fenbiSettings，订阅变化。
 */
(function () {
  "use strict";
  var current = __FENBI_SETTINGS__;
  var fresh = false;
  var listeners = [];
  window.__fenbiSettings = {
    get: function () {
      return current;
    },
    ready: function () {
      return fresh;
    },
    subscribe: function (fn) {
      listeners.push(fn);
    },
  };
  window.__fenbiApplySettings = function (next) {
    current = next;
    fresh = true;
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](next);
      } catch (e) {}
    }
  };
})();
