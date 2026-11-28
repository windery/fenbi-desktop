/* 设置页面里的「划词标记」「解析页左右分栏」两组（样子照 DESIGN.md）。
 *
 * 由 toolbar.js 在打开设置页面时调用 window.__fenbiFeatureSettings(deps)：
 *   deps.call(command, args)  调 Rust（只用 feature_settings / save_feature_settings / clear_practice_marks）
 *   deps.keys                 shortcuts.js 的键位表，录快捷键时查和工具栏冲突没有
 * 返回 { element, load, handleKey }：element 是两组的容器；load() 读一次设置后画出来；
 * handleKey(event) 在录快捷键时吃掉按键（返回 true），工具栏自己的快捷键和 Esc 关设置页面就不会响应。
 *
 * 每改一项就把整份设置交给 Rust 保存（Rust 校验、写盘、推给粉笔页面），成功后以 Rust 回的那份为准；
 * 失败就退回原来的值并在这一组底下说原因。
 */
(function () {
  "use strict";

  var MODS = ["Ctrl", "Alt", "Shift", "Meta"];
  var MAC_FACES = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
  var WIN_FACES = { Ctrl: "Ctrl", Alt: "Alt", Shift: "⇧", Meta: "Win" };
  var CODE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2]))$/;
  var MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)/;
  var TOOLBAR_NAMES = { back: "返回上一页", forward: "前进", reload: "刷新", catalog: "回题库", toggle: "收起工具栏" };
  var KEY_NAMES = { markKey: "标记键", toggleKey: "显示 / 隐藏标记", colorKey: "切换笔色" };
  /* 系统和编辑常用键：mac 上 ⌘ + 这些字母，Windows / Linux 上 Ctrl + 这些字母。 */
  var SYSTEM_LETTERS = ["KeyA", "KeyC", "KeyH", "KeyM", "KeyN", "KeyQ", "KeyT", "KeyV", "KeyW", "KeyX", "KeyZ"];
  var RETENTION = [[7, "7 天"], [30, "30 天"], [90, "90 天"], [0, "永久"]];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /* 「Alt+Shift+KeyM」→ mac「⌥⇧M」/ Windows「Alt+⇧+M」。 */
  function keyLabel(shortcut, mac) {
    var parts = String(shortcut).split("+");
    var code = parts.pop();
    var face = code.replace(/^Key|^Digit/, "");
    var faces = mac ? MAC_FACES : WIN_FACES;
    var mods = parts.map(function (part) {
      return faces[part];
    });
    return mac ? mods.join("") + face : mods.concat(face).join("+");
  }

  window.__fenbiFeatureSettings = function (deps) {
    var call = deps.call;
    var keys = deps.keys;
    var mac = keys.isMac();
    var root = el("div", "fenbi-features");
    var settings = null;
    var defaults = null;
    var ui = {};
    var recording = null;
    var saveRun = 0;
    var ids = 0;

    function load() {
      call("feature_settings").then(function (pair) {
        if (!pair || !pair[0] || !pair[0].highlight) return;
        settings = pair[0];
        defaults = pair[1];
        build();
        paint();
      }, function (error) {
        console.error("功能设置读取失败", error);
      });
    }

    function save(next, group) {
      var run = ++saveRun;
      call("save_feature_settings", { settings: next }).then(function (saved) {
        if (run !== saveRun) return;
        settings = saved;
        showStatus(group, null);
        paint();
      }, function (error) {
        if (run !== saveRun) return;
        console.error("功能设置保存失败", error);
        showStatus(group, "error", typeof error === "string" ? error : "设置没有保存，请重试");
        paint();
      });
    }

    function change(group, mutate) {
      var next = copy(settings);
      mutate(next);
      save(next, group);
    }

    /* ── 行和控件 ─────────────────────────────────────── */

    function row(card, name, sub) {
      var line = card.appendChild(el("div", "fenbi-card-row fenbi-setting"));
      var text = line.appendChild(el("div", "fenbi-card-text"));
      var label = text.appendChild(el("div", "fenbi-setting-name", name));
      if (sub) text.appendChild(el("div", "fenbi-card-sub", sub));
      return { line: line, label: label };
    }

    function labelled(control, label) {
      var id = "fenbi-setting-" + ++ids;
      control.setAttribute("id", id);
      label.setAttribute("id", id + "-label");
      control.setAttribute("aria-labelledby", id + "-label");
      return control;
    }

    /* main：这一组的总开关（第一行，按主行排）；别的开关是附加行。 */
    function toggle(card, name, sub, read, write, group, main) {
      var r = row(card, name, sub);
      if (main) r.line.className += " fenbi-setting-main";
      var input = labelled(el("input", "fenbi-switch"), r.label);
      input.setAttribute("type", "checkbox");
      input.setAttribute("role", "switch");
      input.addEventListener("change", function () {
        var on = input.checked;
        change(group, function (next) {
          write(next, on);
        });
      });
      r.line.appendChild(input);
      return { line: r.line, input: input, read: read };
    }

    function select(card, name, options, read, write, group) {
      var r = row(card, name);
      var input = labelled(el("select", "fenbi-select"), r.label);
      options.forEach(function (option) {
        var item = input.appendChild(el("option", "", option[1]));
        item.setAttribute("value", String(option[0]));
      });
      input.addEventListener("change", function () {
        var value = input.value;
        change(group, function (next) {
          write(next, value);
        });
      });
      r.line.appendChild(input);
      return { line: r.line, input: input, read: read };
    }

    /* 快捷键录入框：点一下进入录入，按下组合键就保存；Esc 或点别处取消。 */
    function recorder(card, field, group) {
      var r = row(card, KEY_NAMES[field]);
      var button = labelled(el("button", "fenbi-btn fenbi-key"), r.label);
      button.setAttribute("type", "button");
      button.setAttribute("data-fenbi-key", field);
      button.addEventListener("click", function () {
        if (recording && recording.field === field) stopRecording();
        else startRecording(field, group);
      });
      button.addEventListener("blur", function () {
        if (recording && recording.field === field) stopRecording();
      });
      r.line.appendChild(button);
      return { line: r.line, button: button, field: field };
    }

    function startRecording(field, group) {
      recording = { field: field, group: group };
      showStatus(group, "hint", "按下新的快捷键，Esc 取消");
      paint();
    }

    function stopRecording() {
      var group = recording && recording.group;
      recording = null;
      if (group) showStatus(group, null);
      paint();
    }

    function shortcutOf(event) {
      var parts = [];
      var flags = { Ctrl: event.ctrlKey, Alt: event.altKey, Shift: event.shiftKey, Meta: event.metaKey };
      for (var i = 0; i < MODS.length; i++) if (flags[MODS[i]]) parts.push(MODS[i]);
      parts.push(event.code);
      return parts.join("+");
    }

    /* 这个组合键为什么不能用；能用就返回空串。 */
    function rejectReason(event, shortcut, field) {
      var action = keys.action(event, mac);
      if (action) return keys.hint(action, mac) + " 已经是工具栏的「" + TOOLBAR_NAMES[action] + "」";
      if (!CODE.test(event.code || "")) return "只能用字母、数字或 F1–F12，可以加修饰键";
      var system = mac ? "Meta+" : "Ctrl+";
      if (SYSTEM_LETTERS.indexOf(shortcut.replace(system, "")) >= 0 && shortcut.indexOf(system) === 0 && shortcut.split("+").length === 2) {
        return keyLabel(shortcut, mac) + " 是系统快捷键";
      }
      if (shortcut === "Alt+F4") return "Alt+F4 是系统快捷键";
      var others = Object.keys(KEY_NAMES);
      for (var i = 0; i < others.length; i++) {
        if (others[i] !== field && settings.highlight[others[i]] === shortcut) {
          return keyLabel(shortcut, mac) + " 已经是「" + KEY_NAMES[others[i]] + "」";
        }
      }
      return "";
    }

    function handleKey(event) {
      if (!recording) return false;
      event.preventDefault();
      event.stopPropagation();
      var plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (event.key === "Escape" && plain) {
        stopRecording();
        return true;
      }
      if (MODIFIER_CODES.test(event.code || "") || event.repeat) return true;
      var field = recording.field;
      var group = recording.group;
      var shortcut = shortcutOf(event);
      var reason = rejectReason(event, shortcut, field);
      if (reason) {
        showStatus(group, "error", reason + "，换一个");
        return true;
      }
      recording = null;
      change(group, function (next) {
        next.highlight[field] = shortcut;
      });
      paint();
      return true;
    }

    function status(card) {
      var slot = card.appendChild(el("div", "fenbi-result-slot"));
      slot.setAttribute("role", "status");
      return slot;
    }

    /* 一组底下的结果行：hint 灰点、error 红点、ok 绿点；kind 为空就撤掉。 */
    function showStatus(group, kind, text, actions) {
      var slot = ui[group + "Status"];
      if (!slot) return;
      slot.textContent = "";
      if (!kind) return;
      var line = slot.appendChild(el("div", "fenbi-card-row fenbi-result"));
      line.setAttribute("data-kind", kind);
      line.appendChild(el("span", "fenbi-result-dot")).setAttribute("aria-hidden", "true");
      line.appendChild(el("span", "fenbi-result-text", text));
      (actions || []).forEach(function (button) {
        line.appendChild(button);
      });
    }

    function button(text, className, onClick) {
      var node = el("button", "fenbi-btn" + (className ? " " + className : ""), text);
      node.setAttribute("type", "button");
      node.addEventListener("click", onClick);
      return node;
    }

    function confirmClear() {
      var cancel = button("取消", "fenbi-clear-cancel", function () {
        showStatus("highlight", null);
      });
      var go = button("确认清除", "fenbi-btn-primary fenbi-clear-confirm", function () {
        call("clear_practice_marks").then(function () {
          showStatus("highlight", "ok", "已清除全部标记");
        }, function (error) {
          console.error("清除标记失败", error);
          showStatus("highlight", "error", "没有清除成功，请重试");
        });
      });
      showStatus("highlight", "hint", "所有练习的标记都会删掉，不能恢复", [cancel, go]);
      go.focus && go.focus();
    }

    /* ── 两组 ─────────────────────────────────────────── */

    function group(title) {
      var section = root.appendChild(el("section", "fenbi-settings-section"));
      section.appendChild(el("h2", "fenbi-settings-group", title));
      return section.appendChild(el("div", "fenbi-card"));
    }

    function build() {
      root.textContent = "";
      var mark = group("划词标记");
      ui.markOn = toggle(mark, "划词标记", "做题页给题目文字叠底色", function (s) {
        return s.highlight.enabled;
      }, function (s, on) {
        s.highlight.enabled = on;
      }, "highlight", true);
      ui.help = mark.appendChild(el("div", "fenbi-card-row fenbi-setting fenbi-setting-help"));
      ui.mode = select(mark, "标记方式", [["release", "松手即标记"], ["key", "选中后按键标记"]], function (s) {
        return s.highlight.mode;
      }, function (s, value) {
        s.highlight.mode = value;
      }, "highlight");
      ui.markKey = recorder(mark, "markKey", "highlight");
      ui.toggleKey = recorder(mark, "toggleKey", "highlight");
      ui.colorKey = recorder(mark, "colorKey", "highlight");

      var colors = row(mark, "颜色");
      ui.colorsLine = colors.line;
      var wells = colors.line.appendChild(el("div", "fenbi-colors"));
      ui.colors = [0, 1, 2].map(function (i) {
        var input = wells.appendChild(el("input", "fenbi-color"));
        input.setAttribute("type", "color");
        input.setAttribute("aria-label", "第 " + (i + 1) + " 种颜色");
        input.addEventListener("change", function () {
          var value = input.value.toLowerCase();
          change("highlight", function (next) {
            next.highlight.colors[i] = value;
          });
        });
        return input;
      });
      ui.resetColors = colors.line.appendChild(button("恢复默认", "fenbi-reset-colors", function () {
        change("highlight", function (next) {
          next.highlight.colors = defaults.highlight.colors.slice();
        });
      }));

      ui.remember = toggle(mark, "记住标记", "按练习保存，关掉应用再打开还在", function (s) {
        return s.highlight.remember;
      }, function (s, on) {
        s.highlight.remember = on;
      }, "highlight");
      ui.retention = select(mark, "标记保留", RETENTION, function (s) {
        return String(s.highlight.retentionDays);
      }, function (s, value) {
        s.highlight.retentionDays = Number(value);
      }, "highlight");
      var clear = row(mark, "清除全部标记");
      ui.clearLine = clear.line;
      ui.clear = clear.line.appendChild(button("清除…", "fenbi-clear", confirmClear));
      ui.highlightStatus = status(mark);

      var split = group("解析页左右分栏");
      ui.splitOn = toggle(split, "解析页左右分栏", "题目在左、解析在右", function (s) {
        return s.split.enabled;
      }, function (s, on) {
        s.split.enabled = on;
      }, "split", true);
      var ratio = row(split, "左栏占比");
      ui.ratioLine = ratio.line;
      ui.ratio = labelled(ratio.line.appendChild(el("input", "fenbi-range")), ratio.label);
      ui.ratio.setAttribute("type", "range");
      ui.ratio.setAttribute("min", "30");
      ui.ratio.setAttribute("max", "70");
      ui.ratio.setAttribute("step", "5");
      ui.ratioValue = ratio.line.appendChild(el("span", "fenbi-setting-value"));
      ui.ratio.addEventListener("input", function () {
        ui.ratioValue.textContent = ui.ratio.value + "%";
      });
      ui.ratio.addEventListener("change", function () {
        var value = Number(ui.ratio.value);
        change("split", function (next) {
          next.split.leftPercent = value;
        });
      });
      var width = row(split, "窗口多宽才分栏");
      ui.widthLine = width.line;
      ui.width = labelled(width.line.appendChild(el("input", "fenbi-number")), width.label);
      ui.width.setAttribute("type", "number");
      ui.width.setAttribute("min", "960");
      ui.width.setAttribute("max", "2560");
      ui.width.setAttribute("step", "20");
      width.line.appendChild(el("span", "fenbi-setting-unit", "像素"));
      ui.width.addEventListener("change", function () {
        var value = Number(ui.width.value);
        if (!(value >= 960 && value <= 2560) || value % 1) {
          showStatus("split", "error", "宽度要在 960–2560 像素之间");
          paint();
          return;
        }
        change("split", function (next) {
          next.split.minWidth = value;
        });
      });
      ui.splitStatus = status(split);
    }

    function setDisabled(line, controls, disabled) {
      if (disabled) line.setAttribute("data-disabled", "");
      else line.removeAttribute("data-disabled");
      controls.forEach(function (control) {
        if (disabled) control.setAttribute("disabled", "");
        else control.removeAttribute("disabled");
      });
    }

    function helpText(h) {
      var mark = h.mode === "key"
        ? "选中题目文字后按 " + keyLabel(h.markKey, mac) + " 标记"
        : "拖选题目文字，松手就标上";
      return mark + "；右键点标记删掉，Shift+右键换颜色；按 " + keyLabel(h.toggleKey, mac) +
        " 显示 / 隐藏全部标记，按 " + keyLabel(h.colorKey, mac) + " 换笔色；Shift+Delete 清掉鼠标所在那道题。";
    }

    /* 按当前设置刷新每个控件的值和可用状态，不重建节点（键盘焦点不丢）。 */
    function paint() {
      if (!settings || !ui.markOn) return;
      var h = settings.highlight;
      var s = settings.split;
      [ui.markOn, ui.remember, ui.splitOn].forEach(function (item) {
        item.input.checked = item.read(settings);
      });
      [ui.mode, ui.retention].forEach(function (item) {
        item.input.value = item.read(settings);
      });
      [ui.markKey, ui.toggleKey, ui.colorKey].forEach(function (item) {
        var active = recording && recording.field === item.field;
        item.button.textContent = active ? "请按快捷键…" : keyLabel(h[item.field], mac);
        item.button.setAttribute("aria-pressed", active ? "true" : "false");
      });
      ui.colors.forEach(function (input, i) {
        input.value = h.colors[i];
      });
      ui.help.textContent = helpText(h);

      var off = !h.enabled;
      setDisabled(ui.mode.line, [ui.mode.input], off);
      setDisabled(ui.markKey.line, [ui.markKey.button], off || h.mode !== "key");
      setDisabled(ui.toggleKey.line, [ui.toggleKey.button], off);
      setDisabled(ui.colorKey.line, [ui.colorKey.button], off);
      setDisabled(ui.colorsLine, ui.colors.concat(ui.resetColors), off);
      setDisabled(ui.remember.line, [ui.remember.input], off);
      setDisabled(ui.retention.line, [ui.retention.input], off || !h.remember);
      setDisabled(ui.help, [], off);

      ui.ratio.value = String(s.leftPercent);
      ui.ratioValue.textContent = s.leftPercent + "%";
      ui.width.value = String(s.minWidth);
      setDisabled(ui.ratioLine, [ui.ratio], !s.enabled);
      setDisabled(ui.widthLine, [ui.width], !s.enabled);
    }

    return { element: root, load: load, handleKey: handleKey, keyLabel: keyLabel };
  };
})();
