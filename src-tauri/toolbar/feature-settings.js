/* 设置页面里的「划词标记」「解析页左右分栏」两组（样子照 DESIGN.md）。
 *
 * 由 toolbar.js 在打开设置页面时调用 window.__fenbiFeatureSettings(deps)：
 *   deps.call(command, args)  调 Rust（只用 feature_settings / save_feature_settings / clear_practice_marks）
 *   deps.keys                 shortcuts.js 的键位表，录快捷键时查和工具栏冲突没有
 * 返回 { element, load, handleKey }：element 是两组的容器；load() 读一次设置后画出来；
 * handleKey(event) 在录快捷键时吃掉按键（返回 true），工具栏自己的快捷键和 Esc 关设置页面就不会响应。
 *
 * 每改一项就把整份设置交给 Rust 保存（Rust 校验、写盘、推给粉笔页面）。改动按操作顺序排队：
 * 界面按「Rust 确认过的那份 + 还没确认的改动依次套上」画，同一时间只有一个保存在路上，
 * 下一个保存从最新的本地意图算整份，连改两项不会互相盖掉。某次保存被拒，就丢掉那一批改动、
 * 退回去并在这一组底下说原因，后面排着的改动照常保存。
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
  var RETENTION = [[7, "7 天"], [30, "30 天"], [90, "90 天"], [0, "永久保留"]];

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
    /* confirmed：Rust 最后确认存下的那份；queue：还没确认的改动（按操作顺序）；
     * sending：在路上的那次保存带了 queue 的前几条；settings：界面按它画 = confirmed 套上 queue。 */
    var confirmed = null;
    var queue = [];
    var sending = 0;
    var settings = null;
    var defaults = null;
    var ui = {};
    var recording = null;
    var ids = 0;

    function load() {
      call("feature_settings").then(function (pair) {
        if (!pair || !pair[0] || !pair[0].highlight) return;
        confirmed = pair[0];
        settings = copy(confirmed);
        defaults = pair[1];
        build();
        paint();
      }, function (error) {
        console.error("功能设置读取失败", error);
      });
    }

    function intent() {
      var next = copy(confirmed);
      queue.forEach(function (item) {
        item.mutate(next);
      });
      return next;
    }

    function settled(groups) {
      groups.forEach(function (group) {
        if (!recording || recording.group !== group) showStatus(group, null);
      });
    }

    /* 同一时间只发一个保存；回来后若还有排着的改动，再按最新意图发一次整份。 */
    function pump() {
      if (sending || !queue.length) return;
      sending = queue.length;
      var batch = queue.slice(0, sending);
      var groups = batch.map(function (item) {
        return item.group;
      });
      call("save_feature_settings", { settings: intent() }).then(function (saved) {
        queue.splice(0, sending);
        sending = 0;
        confirmed = saved;
        settings = intent();
        settled(groups);
        paint();
        pump();
      }, function (error) {
        console.error("功能设置保存失败", error);
        queue.splice(0, sending);
        sending = 0;
        settings = intent();
        showStatus(groups[groups.length - 1], "error", typeof error === "string" ? error : "设置保存失败，请重试");
        paint();
        pump();
      });
    }

    function change(group, mutate) {
      queue.push({ group: group, mutate: mutate });
      settings = intent();
      paint();
      pump();
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
      showStatus(group, "hint", "请按下新的快捷键，按 Esc 取消");
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

    /* 这个组合键为什么不能用；能用就返回空串。系统键用 shortcuts.js 的同一张表（settings.rs 落盘也查它）。 */
    function rejectReason(event, shortcut, field) {
      var action = keys.action(event, mac);
      if (action) return keys.hint(action, mac) + " 已用于工具栏「" + TOOLBAR_NAMES[action] + "」，请换一个（Esc 取消）";
      if (!CODE.test(event.code || "")) {
        return mac
          ? "请用字母、数字或 F1–F12（可搭配 ⌘ ⌥ ⌃ ⇧），Esc 取消"
          : "请用字母、数字或 F1–F12（可搭配 Ctrl、Alt、Shift），Esc 取消";
      }
      if (keys.isSystem(shortcut, mac)) return keyLabel(shortcut, mac) + " 是系统常用快捷键，请换一个（Esc 取消）";
      var others = Object.keys(KEY_NAMES);
      for (var i = 0; i < others.length; i++) {
        if (others[i] !== field && settings.highlight[others[i]] === shortcut) {
          return keyLabel(shortcut, mac) + " 已用于「" + KEY_NAMES[others[i]] + "」，请换一个（Esc 取消）";
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
        showStatus(group, "error", reason);
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
      /* 「划词标记」一组很长，结果行在卡片最底下，窗口不高时会在视口外：出现时滚到能看见。 */
      if (line.scrollIntoView) line.scrollIntoView({ block: "nearest" });
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
          showStatus("highlight", "error", "清除失败，请重试");
        });
      });
      showStatus("highlight", "hint", "将清空所有练习的标记，无法恢复", [cancel, go]);
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
      ui.markOn = toggle(mark, "划词标记", "练习和背题页给题目、选项文字标底色", function (s) {
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

      ui.remember = toggle(mark, "记住标记", "按练习保存在本机，退出重开仍在", function (s) {
        return s.highlight.remember;
      }, function (s, on) {
        s.highlight.remember = on;
      }, "highlight");
      ui.retention = select(mark, "标记保留时长", RETENTION, function (s) {
        return String(s.highlight.retentionDays);
      }, function (s, value) {
        s.highlight.retentionDays = Number(value);
      }, "highlight");
      var clear = row(mark, "清除全部标记");
      ui.clearLine = clear.line;
      ui.clear = clear.line.appendChild(button("清除…", "fenbi-clear", confirmClear));
      ui.highlightStatus = status(mark);

      var split = group("解析页左右分栏");
      ui.splitOn = toggle(split, "解析页左右分栏", "窗口够宽时，题目在左、解析在右", function (s) {
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
      var width = row(split, "分栏所需窗口宽度");
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
          showStatus("split", "error", "请输入 960–2560 之间的整数");
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

    /* 一行说清鼠标操作和清本题；显示 / 隐藏、切换笔色在下面各有一行，不重复写。 */
    function helpText(h) {
      var mark = h.mode === "key" ? "选中按 " + keyLabel(h.markKey, mac) + " 标记" : "拖选松手即标";
      return mark + "；标记上右键删除、Shift+右键换色；停在题上按 " + (mac ? "Shift+删除键" : "Shift+Delete") + " 清本题。";
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
      setDisabled(ui.colorsLine, ui.colors, off);
      /* 已经是默认颜色时「恢复默认」置灰。 */
      if (off || h.colors.join(",") === defaults.highlight.colors.join(",")) ui.resetColors.setAttribute("disabled", "");
      else ui.resetColors.removeAttribute("disabled");
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
