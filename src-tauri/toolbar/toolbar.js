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
  var status = null;
  var toggleLabel = null;
  var hintText = "";
  var errorText = "";
  var errorTimer = null;
  var settingsPanel = null;

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
      render(snapshot[1] ? "collapsed" : "expanded");
    }).catch(function (error) {
      console.error("工具栏状态读取失败", error);
      if (thisRequest === requestId) render("error");
    });
  }

  function runShortcut(action) {
    clearError();
    var command = action === "toggle" ? "toggle_toolbar" : "toolbar_action";
    call(command, { action: action }).catch(report);
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
    addHintEvents(button, label);
    button.addEventListener("click", function () { runShortcut(item.action); });
    return button;
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
    }
    addHintEvents(button, label);
    button.addEventListener("click", function (event) {
      if (event.stopPropagation) event.stopPropagation();
      runShortcut("toggle");
    });
    return button;
  }

  function textButton(label, click) {
    var button = document.createElement("button");
    button.className = "fenbi-settings-button";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", click);
    return button;
  }

  function shortcutField(panel, id, labelText, selected) {
    var label = document.createElement("label");
    label.textContent = labelText;
    label.setAttribute("for", id);
    var input = document.createElement("input");
    input.id = id;
    input.className = "fenbi-shortcut-key";
    input.type = "text";
    input.readOnly = true;
    input.title = "点击后按字母、数字、Backspace 或 Delete";
    var key = selected;
    function paint() {
      input.value = key === "backspace" ? "Backspace" : key === "delete" ? "Delete" : key.toUpperCase();
    }
    input.addEventListener("keydown", function (event) {
      if (event.key === "Tab" || event.isComposing) return;
      event.preventDefault();
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      var pressed = event.key.toLowerCase();
      if (!/^(?:[a-z0-9]|backspace|delete)$/.test(pressed)) return;
      key = pressed;
      paint();
    });
    paint();
    label.appendChild(input);
    panel.appendChild(label);
    return { input: input, key: function () { return key; } };
  }

  function openSettings() {
    var panel = document.createElement("div");
    panel.className = "fenbi-shortcut-settings";
    settingsPanel = panel;
    status = null;
    bar.textContent = "";
    var back = textButton("返回", function () {
      render("expanded");
      document.querySelector(".fenbi-settings-button")?.focus?.();
    });
    panel.appendChild(back);
    var feedback = document.createElement("span");
    feedback.className = "fenbi-settings-feedback";
    feedback.setAttribute("role", "status");
    feedback.textContent = "正在读取快捷键";
    panel.appendChild(feedback);
    bar.appendChild(panel);

    call("study_shortcuts").then(function (snapshot) {
      if (settingsPanel !== panel) return;
      panel.removeChild(feedback);
      var toggle = shortcutField(panel, "fenbi-mark-key", "标注模式", snapshot[1][0]);
      var remove = shortcutField(panel, "fenbi-remove-key", "移除高亮", snapshot[1][1]);
      var save = textButton("保存", function () {
        if (toggle.key() === remove.key()) {
          feedback.textContent = "两个动作需要不同的快捷键";
          return;
        }
        save.disabled = back.disabled = toggle.input.disabled = remove.input.disabled = true;
        call("save_study_shortcuts", { toggleKey: toggle.key(), removeKey: remove.key() })
          .then(function () {
            if (settingsPanel === panel) {
              render("expanded");
              showHint("标注快捷键已保存");
            }
          })
          .catch(function (error) {
            console.error("保存标注快捷键失败", error);
            if (settingsPanel !== panel) return;
            save.disabled = back.disabled = toggle.input.disabled = remove.input.disabled = false;
            feedback.textContent = "保存失败，请重试";
          });
      });
      panel.appendChild(save);
      panel.appendChild(feedback);
      feedback.textContent = "点击输入框后按键";
      toggle.input.focus?.();
    }).catch(function (error) {
      console.error("读取标注快捷键失败", error);
      if (settingsPanel !== panel) return;
      feedback.textContent = "快捷键暂不可用";
      panel.appendChild(textButton("重试", openSettings));
    });
  }

  function render(state) {
    if (state !== currentState) hintText = "";
    currentState = state;
    status = null;
    toggleLabel = null;
    settingsPanel = null;
    host.setAttribute("data-fenbi-toolbar", state);
    bar.textContent = "";
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
      bar.appendChild(textButton("设置", openSettings));
    }
    bar.appendChild(toggleButton(state, mac));
    paintStatus();
  }

  bar.addEventListener("click", function (event) {
    if (currentState === "collapsed" && event.target === bar) runShortcut("toggle");
  });
  window.__fenbiRefreshToolbar = refresh;
  window.addEventListener("keydown", function (event) {
    if (settingsPanel && event.target?.className === "fenbi-shortcut-key") return;
    var action = keys.action(event, keys.isMac());
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    runShortcut(action);
  }, true);

  render("loading");
  refresh();
})();
