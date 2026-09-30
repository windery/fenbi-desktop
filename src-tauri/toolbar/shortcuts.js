(function () {
"use strict";
  function isMacPlatform() {
    var probe = "";
    try {
      probe = (navigator && (navigator.platform || navigator.userAgent)) || "";
    } catch (e) {}
    return /Mac|iPhone|iPad|iPod/i.test(probe);
  }

  /* 键位表：**唯一的**键位定义。
   *
   * 同一张表既生成匹配逻辑（shortcutAction），也生成按钮上的提示文字
   * （bindingLabel）——一处定义，提示不可能和真实绑定走偏。
   *
   * 曾经这里是两份实现：shortcutHints() 手写显示文字，shortcutAction() 另写
   * 一套 if 分支。于是「收起 ⌃」写着一个根本没有绑定的键，按下去毫无反应。
   *
   * 修饰键按"全等"匹配：没写的修饰键视为必须为假。
   * toggle 之所以要 shift，是为了不吞掉裸 ⌘B（mac 上那是加粗/站点的常用键）。 */
  var KEY_BINDINGS = {
    back: { mac: { meta: 1, key: "[" }, win: { alt: 1, key: "left" } },
    forward: { mac: { meta: 1, key: "]" }, win: { alt: 1, key: "right" } },
    reload: { mac: { meta: 1, key: "r" }, win: { ctrl: 1, key: "r" } },
    catalog: {
      mac: { meta: 1, shift: 1, key: "[" },
      win: { ctrl: 1, shift: 1, key: "[" },
    },
    toggle: {
      mac: { meta: 1, shift: 1, key: "b" },
      win: { ctrl: 1, shift: 1, key: "b" },
    },
  };

  /* 内部分键名 -> 按钮上给用户看的字形 */
  var KEY_FACES = {
    "[": "[",
    "]": "]",
    r: "R",
    b: "B",
    left: "←",
    right: "→",
  };

  var MAC_MODS = [
    ["meta", "⌘"],
    ["ctrl", "⌃"],
    ["alt", "⌥"],
    ["shift", "⇧"],
  ];
  var WIN_MODS = [
    ["ctrl", "Ctrl"],
    ["alt", "Alt"],
    ["shift", "⇧"],
  ];

  /* 由键位表生成提示文字：mac 的修饰键换成符号、直接串接（⌘[ / ⌘⇧B）；
   * Windows/Linux 用 Ctrl/Alt/⇧ 并以 + 串接（Alt+← / Ctrl+⇧+[ / Ctrl+⇧+B）。
   * 这串字既是按钮上的提示，也是测试用来"照着按"的依据，所以格式必须稳定。
   * 顺带修掉旧版手写字符串的不一致：mac 与 Win 的「回题库」写法对不上。 */
  function bindingLabel(binding, mac) {
    var mods = mac ? MAC_MODS : WIN_MODS;
    var parts = [];
    for (var i = 0; i < mods.length; i++) {
      if (binding[mods[i][0]]) parts.push(mods[i][1]);
    }
    var face = KEY_FACES[binding.key];
    return mac ? parts.join("") + face : parts.concat(face).join("+");
  }

  /* 取某个动作在当前平台上的绑定：匹配与提示都走这里。 */
  function bindingFor(action, mac) {
    return KEY_BINDINGS[action][mac ? "mac" : "win"];
  }

  function shortcutHint(action, mac) {
    return bindingLabel(bindingFor(action, mac), mac);
  }

  function keyName(e) {
    if (e.code === "BracketLeft") return "[";
    if (e.code === "BracketRight") return "]";
    if (e.code === "KeyR") return "r";
    if (e.code === "KeyB") return "b";
    if (e.code === "ArrowLeft") return "left";
    if (e.code === "ArrowRight") return "right";
    var key = typeof e.key === "string" ? e.key.toLowerCase() : "";
    if (key === "[" || key === "{") return "[";
    if (key === "]" || key === "}") return "]";
    if (key === "r") return "r";
    if (key === "b") return "b";
    if (key === "arrowleft") return "left";
    if (key === "arrowright") return "right";
    return "";
  }

  /* 事件是否恰好命中这条绑定：四个修饰键全等，键面相等。 */
  function bindingMatches(e, binding) {
    return (
      !!e.metaKey === !!binding.meta &&
      !!e.ctrlKey === !!binding.ctrl &&
      !!e.altKey === !!binding.alt &&
      !!e.shiftKey === !!binding.shift &&
      keyName(e) === binding.key
    );
  }

  /* 键位 → 动作（空串表示不处理）。 */
  function shortcutAction(e, mac) {
    var actions = Object.keys(KEY_BINDINGS);
    for (var i = 0; i < actions.length; i++) {
      var binding = bindingFor(actions[i], mac);
      if (binding && bindingMatches(e, binding)) return actions[i];
    }
    return "";
  }


window.__fenbiKeys = { isMac: isMacPlatform, action: shortcutAction, hint: shortcutHint };
})();
