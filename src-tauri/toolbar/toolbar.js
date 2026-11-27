(function () {
  "use strict";

  var keys = window.__fenbiKeys;
  var invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  var svgNS = "http://www.w3.org/2000/svg";
  var host = document.createElement("div");
  var bar = document.createElement("div");
  bar.className = "fenbi-toolbar";
  host.appendChild(bar);
  document.body.appendChild(host);

  var revision = -1;
  var requestId = 0;
  var currentState = "loading";
  var hasUpdate = false;
  var settingsOpen = false;
  var settingsPage = null;
  var status = null;
  var toggleLabel = null;
  var hintText = "";
  var errorText = "";
  var errorTimer = null;

  var ACTIONS = [
    { action: "back", text: "返回上一页" },
    { action: "forward", text: "前进" },
    { action: "reload", text: "刷新" },
    { action: "catalog", text: "回题库" },
  ];
  var ICON_PATHS = {
    back: ["M11.8 4.5 6.4 10l5.4 5.5", "M6.5 10h10.8"],
    forward: ["m8.2 4.5 5.4 5.5-5.4 5.5", "M13.5 10H2.7"],
    reload: ["M15.5 8A6 6 0 1 0 16 11", "M15.5 3.8V8h-4.2"],
    catalog: ["M3.5 4.5c2.4-.6 4.4-.4 6.5.6v10.8c-2.1-1-4.1-1.2-6.5-.6z", "M16.5 4.5c-2.4-.6-4.4-.4-6.5.6v10.8c2.1-1 4.1-1.2 6.5-.6z"],
    up: ["m5.2 12.4 4.8-4.8 4.8 4.8"],
    down: ["m5.2 7.6 4.8 4.8 4.8-4.8"],
    chevron: ["m11.8 5.2-4.8 4.8 4.8 4.8"],
    settings: [
      "M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6",
      "M10 5.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6z",
      "M10 8.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z",
    ],
  };

  function icon(name) {
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (var i = 0; i < ICON_PATHS[name].length; i++) {
      var path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", ICON_PATHS[name][i]);
      svg.appendChild(path);
    }
    return svg;
  }

  function call(command, args) {
    if (!invoke) return Promise.reject(new Error("Tauri invoke unavailable"));
    try {
      return Promise.resolve(invoke(command, args));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function paintStatus() {
    if (status) {
      status.textContent = errorText || hintText;
      status.setAttribute("data-kind", errorText ? "error" : "hint");
    }
    if (currentState === "collapsed" && toggleLabel) {
      toggleLabel.textContent = errorText ? "操作未完成，请重试" : "展开";
    }
  }

  function showHint(text) {
    hintText = text;
    paintStatus();
  }
  function clearHint() {
    hintText = "";
    paintStatus();
  }
  function clearError() {
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = null;
    errorText = "";
    paintStatus();
  }
  function report(error) {
    console.error("工具栏操作失败", error);
    errorText = "操作未完成，请重试";
    paintStatus();
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = setTimeout(clearError, 4000);
  }

  function refresh() {
    var thisRequest = ++requestId;
    return call("toolbar_state").then(function (snapshot) {
      if (snapshot[0] < revision) return;
      revision = snapshot[0];
      hasUpdate = snapshot[2] === true;
      settingsOpen = snapshot[3] === true;
      render(snapshot[1] ? "collapsed" : "expanded");
    }).catch(function (error) {
      console.error("工具栏状态读取失败", error);
      if (thisRequest === requestId) render("error");
    });
  }

  /* 设置页面开着时，工具栏上只有齿轮能用；Rust 那边也同样拒绝，这里先拦一道。 */
  function runShortcut(action) {
    if (settingsOpen) return;
    clearError();
    var command = action === "toggle" ? "toggle_toolbar" : "toolbar_action";
    call(command, { action: action }).catch(report);
  }

  /* 有新版的唯一提示：展开时在齿轮上，收起时在展开把手上。 */
  function addUpdateDot(button) {
    if (!hasUpdate) return;
    var dot = document.createElement("span");
    dot.className = "fenbi-toolbar-dot";
    dot.setAttribute("aria-hidden", "true");
    button.appendChild(dot);
  }

  function toggleSettings() {
    clearError();
    call("toggle_settings").catch(report);
  }

  function disableWhileSettingsOpen(button) {
    if (settingsOpen) button.setAttribute("disabled", "");
  }

  function addHintEvents(button, text) {
    button.addEventListener("mouseenter", function () { showHint(text); });
    button.addEventListener("mouseleave", clearHint);
    button.addEventListener("focus", function () { showHint(text); });
    button.addEventListener("blur", clearHint);
  }

  function actionButton(item, mac) {
    var label = item.text + " (" + keys.hint(item.action, mac) + ")";
    var button = document.createElement("button");
    button.className = "fenbi-toolbar-btn";
    button.setAttribute("type", "button");
    button.setAttribute("data-fenbi-action", item.action);
    button.setAttribute("title", label);
    button.setAttribute("aria-label", label);
    button.appendChild(icon(item.action));
    disableWhileSettingsOpen(button);
    addHintEvents(button, label);
    button.addEventListener("click", function () { runShortcut(item.action); });
    return button;
  }

  /* 齿轮开关设置页面：Rust 把这个 WebView 撑满窗口，设置页面画在工具栏下面。 */
  function settingsButton() {
    var button = document.createElement("button");
    button.className = "fenbi-toolbar-btn fenbi-toolbar-settings";
    button.setAttribute("type", "button");
    button.setAttribute("title", "设置");
    button.setAttribute("aria-label", "设置");
    button.setAttribute("aria-pressed", settingsOpen ? "true" : "false");
    button.appendChild(icon("settings"));
    addUpdateDot(button);
    addHintEvents(button, "设置");
    button.addEventListener("click", toggleSettings);
    return button;
  }

  /* 设置页面的骨架照 DESIGN.md：标题行是返回箭头紧挨「设置」。 */
  function buildSettingsPage() {
    var page = document.createElement("main");
    page.className = "fenbi-settings";
    var column = document.createElement("div");
    column.className = "fenbi-settings-col";
    var head = document.createElement("div");
    head.className = "fenbi-settings-head";
    var back = document.createElement("button");
    back.className = "fenbi-settings-back";
    back.setAttribute("type", "button");
    back.setAttribute("title", "返回");
    back.setAttribute("aria-label", "返回");
    back.appendChild(icon("chevron"));
    back.addEventListener("click", toggleSettings);
    var title = document.createElement("h1");
    title.className = "fenbi-settings-title";
    title.textContent = "设置";
    head.appendChild(back);
    head.appendChild(title);
    column.appendChild(head);
    page.appendChild(column);
    return page;
  }

  function toggleButton(state, mac) {
    var expanded = state === "expanded";
    var text = expanded ? "收起" : "展开";
    var label = text + "工具栏 (" + keys.hint("toggle", mac) + ")";
    var button = document.createElement("button");
    button.className = "fenbi-toolbar-toggle";
    button.setAttribute("type", "button");
    button.setAttribute("title", label);
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    button.appendChild(icon(expanded ? "up" : "down"));
    if (!expanded) {
      toggleLabel = document.createElement("span");
      toggleLabel.className = "fenbi-toolbar-toggle-label";
      button.appendChild(toggleLabel);
      addUpdateDot(button);
    }
    disableWhileSettingsOpen(button);
    addHintEvents(button, label);
    button.addEventListener("click", function (event) {
      if (event.stopPropagation) event.stopPropagation();
      runShortcut("toggle");
    });
    return button;
  }

  function render(state) {
    if (state !== currentState) hintText = "";
    currentState = state;
    status = null;
    toggleLabel = null;
    host.setAttribute("data-fenbi-toolbar", state);
    bar.textContent = "";
    if (settingsPage) host.removeChild(settingsPage);
    settingsPage = state === "expanded" && settingsOpen ? host.appendChild(buildSettingsPage()) : null;
    if (state === "loading") {
      var loading = document.createElement("span");
      loading.className = "fenbi-toolbar-loading";
      loading.textContent = "正在读取工具栏";
      bar.appendChild(loading);
      return;
    }
    if (state === "error") {
      var retry = document.createElement("button");
      retry.className = "fenbi-toolbar-retry";
      retry.setAttribute("type", "button");
      retry.textContent = "工具栏暂不可用 · 重试工具栏";
      retry.addEventListener("click", refresh);
      bar.appendChild(retry);
      return;
    }

    var mac = keys.isMac();
    if (state === "expanded") {
      var actions = document.createElement("div");
      actions.className = "fenbi-toolbar-actions";
      ACTIONS.forEach(function (item) {
        if (item.action === "reload" || item.action === "catalog") {
          var divider = document.createElement("span");
          divider.className = "fenbi-toolbar-divider";
          divider.setAttribute("aria-hidden", "true");
          actions.appendChild(divider);
        }
        actions.appendChild(actionButton(item, mac));
      });
      bar.appendChild(actions);
      status = document.createElement("span");
      status.className = "fenbi-toolbar-status";
      status.setAttribute("role", "status");
      bar.appendChild(status);
      bar.appendChild(settingsButton());
    }
    bar.appendChild(toggleButton(state, mac));
    paintStatus();
  }

  bar.addEventListener("click", function (event) {
    if (currentState === "collapsed" && event.target === bar) runShortcut("toggle");
  });
  window.__fenbiRefreshToolbar = refresh;
  function isPlainEscape(event) {
    return event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  }
  window.addEventListener("keydown", function (event) {
    var closing = settingsOpen && isPlainEscape(event);
    var action = keys.action(event, keys.isMac());
    if (!closing && !action) return;
    event.preventDefault();
    event.stopPropagation();
    if (closing) toggleSettings();
    else runShortcut(action);
  }, true);

  render("loading");
  refresh();
})();
