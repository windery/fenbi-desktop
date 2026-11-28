/* 设置页面里「划词标记」「解析页左右分栏」两组：运行真实 toolbar.js + feature-settings.js，断言控件和发给 Rust 的命令。
   样子（间距、颜色、开关的拨钮）按 DESIGN.md 在真实应用里核对。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootToolbar, DEFAULT_SETTINGS, press } from "../support/boot.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => structuredClone(value);

/** 设置页面开着的工具栏。`save` 决定 Rust 怎么答保存（默认原样存下）。 */
async function bootFeatures({ current = DEFAULT_SETTINGS, save, clear, platform = "MacIntel" } = {}) {
  const saved = [];
  const env = await bootToolbar({
    platform,
    invoke(command, args) {
      if (command === "toolbar_state") return Promise.resolve([1, false, false, true]);
      if (command === "settings_info") return Promise.resolve(["0.1.4", null]);
      if (command === "feature_settings") return Promise.resolve([clone(current), clone(DEFAULT_SETTINGS)]);
      if (command === "save_feature_settings") {
        saved.push(clone(args.settings));
        return save ? save(args.settings) : Promise.resolve(clone(args.settings));
      }
      if (command === "clear_practice_marks") return clear ? clear() : Promise.resolve(null);
      return Promise.resolve(null);
    },
  });
  await settle();
  const all = (selector) => env.document.querySelectorAll(selector);
  const [markOn, remember, splitOn] = all(".fenbi-switch");
  const [mode, retention] = all(".fenbi-select");
  const key = (field) => all(".fenbi-key").find((el) => el.getAttribute("data-fenbi-key") === field);
  return Object.assign(env, {
    saved,
    all,
    markOn,
    remember,
    splitOn,
    mode,
    retention,
    key,
    colors: all(".fenbi-color"),
    ratio: all(".fenbi-range")[0],
    ratioValue: all(".fenbi-setting-value")[0],
    width: all(".fenbi-number")[0],
    help: all(".fenbi-setting-help")[0],
    results: () => all(".fenbi-result"),
    lineOf: (control) => control.parentNode,
  });
}

function changeTo(control, value) {
  if (typeof value === "boolean") control.checked = value;
  else control.value = value;
  control.dispatch("change");
}

const disabled = (control) => control.getAttribute("disabled") !== null;
const withHighlight = (changes) => ({ ...DEFAULT_SETTINGS, highlight: { ...DEFAULT_SETTINGS.highlight, ...changes } });

test("打开设置页面读一次功能设置，在「版本与更新」下面画出「划词标记」「解析页左右分栏」两组", async () => {
  const env = await bootFeatures();
  assert.deepEqual(env.all(".fenbi-settings-group").map((h) => [h.tagName, h.textContent]), [
    ["H2", "版本与更新"],
    ["H2", "划词标记"],
    ["H2", "解析页左右分栏"],
  ]);
  assert.equal(env.calls.filter((c) => c.command === "feature_settings").length, 1);
  assert.equal(env.markOn.checked, true);
  assert.equal(env.markOn.getAttribute("role"), "switch");
  assert.equal(env.mode.value, "release");
  assert.equal(env.key("toggleKey").textContent, "V");
  assert.equal(env.key("colorKey").textContent, "C");
  assert.equal(env.key("markKey").textContent, "H");
  assert.deepEqual(env.colors.map((c) => c.value), DEFAULT_SETTINGS.highlight.colors);
  assert.equal(env.remember.checked, true);
  assert.equal(env.retention.value, "30");
  assert.equal(env.splitOn.checked, true);
  assert.equal(env.ratio.value, "50");
  assert.equal(env.ratioValue.textContent, "50%");
  assert.equal(env.width.value, "1400");
  assert.deepEqual(env.saved, [], "只是打开不保存");
});

test("只有每组第一行的总开关按主行排（72px、名称加粗、不带上分隔线），「记住标记」这类开关是附加行", async () => {
  const env = await bootFeatures();
  const main = env.all(".fenbi-setting-main").map((line) => line.children[0].children[0].textContent);
  assert.deepEqual(main, ["划词标记", "解析页左右分栏"]);
  assert.doesNotMatch(env.lineOf(env.remember).className, /fenbi-setting-main/);
});

test("每个控件都有名字（读屏）：开关、下拉框、录入框、滑块、数字框指向自己那一行的名称", async () => {
  const env = await bootFeatures();
  for (const control of [env.markOn, env.mode, env.key("toggleKey"), env.ratio, env.width]) {
    const id = control.getAttribute("aria-labelledby");
    const label = env.all(".fenbi-setting-name").find((el) => el.getAttribute("id") === id);
    assert.ok(label, `${control.className} 没有名字`);
  }
  assert.deepEqual(env.colors.map((c) => c.getAttribute("aria-label")), ["第 1 种颜色", "第 2 种颜色", "第 3 种颜色"]);
});

test("怎么用的一行（单行版）：跟着标记方式和标记键变；macOS 写「Shift+删除键」，V / C 在下面各有一行不重复写", async () => {
  const env = await bootFeatures();
  assert.equal(env.help.textContent, "拖选松手即标；标记上右键删除、Shift+右键换色；停在题上按 Shift+删除键 清本题。");
  changeTo(env.mode, "key");
  await settle();
  assert.equal(env.help.textContent, "选中按 H 标记；标记上右键删除、Shift+右键换色；停在题上按 Shift+删除键 清本题。");

  const win = await bootFeatures({ platform: "Win32", current: withHighlight({ mode: "key", markKey: "Alt+KeyJ" }) });
  assert.equal(win.help.textContent, "选中按 Alt+J 标记；标记上右键删除、Shift+右键换色；停在题上按 Shift+Delete 清本题。");
});

test("拨划词总开关：把整份设置交给 Rust 保存；关着时这一组别的控件都禁用", async () => {
  const env = await bootFeatures();
  changeTo(env.markOn, false);
  await settle();
  assert.deepEqual(env.saved, [withHighlight({ enabled: false })]);
  for (const control of [env.mode, env.key("toggleKey"), env.key("colorKey"), env.remember, env.retention, ...env.colors]) {
    assert.ok(disabled(control), control.className);
  }
  assert.equal(env.lineOf(env.mode).getAttribute("data-disabled"), "");
  assert.ok(!disabled(env.ratio), "分栏那组不受影响");
});

test("标记键只在「选中后按键标记」时能改；保留天数只在记住标记时能改", async () => {
  const env = await bootFeatures();
  assert.ok(disabled(env.key("markKey")));
  changeTo(env.mode, "key");
  await settle();
  assert.equal(env.saved.at(-1).highlight.mode, "key");
  assert.ok(!disabled(env.key("markKey")));

  changeTo(env.retention, "90");
  await settle();
  assert.equal(env.saved.at(-1).highlight.retentionDays, 90);
  changeTo(env.retention, "0");
  await settle();
  assert.equal(env.saved.at(-1).highlight.retentionDays, 0, "永久 = 0");
  changeTo(env.remember, false);
  await settle();
  assert.equal(env.saved.at(-1).highlight.remember, false);
  assert.ok(disabled(env.retention));
});

test("录快捷键：点一下进入录入，按下组合键就保存；录入时按键不交给工具栏，Esc 只取消录入", async () => {
  const env = await bootFeatures();
  const button = env.key("toggleKey");
  button.click();
  assert.equal(button.textContent, "请按快捷键…");
  assert.equal(button.getAttribute("aria-pressed"), "true");

  const esc = press(env, { code: "Escape", key: "Escape" });
  assert.equal(esc.defaultPrevented, true);
  assert.equal(env.calls.filter((c) => c.command === "toggle_settings").length, 0, "录入时 Esc 不关设置页面");
  assert.equal(button.textContent, "V");

  button.click();
  assert.equal(press(env, { code: "ShiftLeft", key: "Shift", shiftKey: true }).defaultPrevented, true, "单按修饰键继续等");
  assert.deepEqual(env.saved, []);
  press(env, { code: "KeyM", key: "M", altKey: true, shiftKey: true });
  await settle();
  assert.equal(env.saved.at(-1).highlight.toggleKey, "Alt+Shift+KeyM");
  assert.equal(button.textContent, "⌥⇧M");
  assert.equal(button.getAttribute("aria-pressed"), "false");
});

test("录快捷键：和工具栏、系统、本组别的键重复，或不是字母数字 F 键，都拒绝并说原因", async () => {
  for (const [platform, keyDown, reason] of [
    ["MacIntel", { code: "BracketLeft", key: "[", metaKey: true }, /^⌘\[ 已用于工具栏「返回上一页」，请换一个（Esc 取消）$/],
    ["Win32", { code: "KeyB", key: "B", ctrlKey: true, shiftKey: true }, /^Ctrl\+⇧\+B 已用于工具栏「收起工具栏」，请换一个（Esc 取消）$/],
    ["MacIntel", { code: "KeyC", key: "c" }, /^C 已用于「切换笔色」，请换一个（Esc 取消）$/],
    ["MacIntel", { code: "KeyH", key: "h" }, /^H 已用于「标记键」，请换一个（Esc 取消）$/],
    ["MacIntel", { code: "KeyC", key: "c", metaKey: true }, /^⌘C 是系统常用快捷键，请换一个（Esc 取消）$/],
    ["Win32", { code: "KeyV", key: "v", ctrlKey: true }, /^Ctrl\+V 是系统常用快捷键，请换一个（Esc 取消）$/],
    ["Win32", { code: "F4", key: "F4", altKey: true }, /^Alt\+F4 是系统常用快捷键，请换一个（Esc 取消）$/],
    ["MacIntel", { code: "ArrowUp", key: "ArrowUp" }, /^请用字母、数字或 F1–F12（可搭配 ⌘ ⌥ ⌃ ⇧），Esc 取消$/],
    ["Win32", { code: "Space", key: " " }, /^请用字母、数字或 F1–F12（可搭配 Ctrl、Alt、Shift），Esc 取消$/],
  ]) {
    const env = await bootFeatures({ platform });
    env.key("toggleKey").click();
    press(env, keyDown);
    await settle();
    assert.deepEqual(env.saved, [], `${platform} ${keyDown.code}`);
    const row = env.results().at(-1);
    assert.equal(row.getAttribute("data-kind"), "error");
    assert.match(row.textContent, reason);
    assert.ok(row.scrolledIntoView, "结果行在长卡片底部，出现时要滚进视口");
    assert.equal(env.key("toggleKey").getAttribute("aria-pressed"), "true", "被拒后还在录入，可以直接再按一个");
  }
});

test("改颜色：存小写 #rrggbb；「恢复默认」换回 Rust 给的默认颜色", async () => {
  const env = await bootFeatures({ current: withHighlight({ colors: ["#000000", "#111111", "#222222"] }) });
  changeTo(env.colors[1], "#ABCDEF");
  await settle();
  assert.deepEqual(env.saved.at(-1).highlight.colors, ["#000000", "#abcdef", "#222222"]);
  env.all(".fenbi-reset-colors")[0].click();
  await settle();
  assert.deepEqual(env.saved.at(-1).highlight.colors, DEFAULT_SETTINGS.highlight.colors);
});

test("左栏占比：拖动时数字跟着变，松手才保存", async () => {
  const env = await bootFeatures();
  env.ratio.value = "35";
  env.ratio.dispatch("input");
  assert.equal(env.ratioValue.textContent, "35%");
  assert.deepEqual(env.saved, []);
  env.ratio.dispatch("change");
  await settle();
  assert.equal(env.saved.at(-1).split.leftPercent, 35);
});

test("分栏宽度：范围外不保存、退回原值并提示；范围内保存；关掉分栏时比例和宽度禁用", async () => {
  const env = await bootFeatures();
  changeTo(env.width, "300");
  await settle();
  assert.deepEqual(env.saved, []);
  assert.equal(env.width.value, "1400");
  assert.match(env.results().at(-1).textContent, /960–2560/);

  changeTo(env.width, "1600");
  await settle();
  assert.equal(env.saved.at(-1).split.minWidth, 1600);
  assert.equal(env.results().length, 0, "保存成功后提示撤掉");

  changeTo(env.splitOn, false);
  await settle();
  assert.equal(env.saved.at(-1).split.enabled, false);
  assert.ok(disabled(env.ratio) && disabled(env.width));
});

/** Rust 的保存先不回：每次保存进队，由测试按顺序放行（原样存下）。 */
function heldSaves() {
  const held = [];
  return {
    held,
    save: (settings) => new Promise((resolve) => held.push(() => resolve(clone(settings)))),
    async releaseNext() {
      held.shift()();
      await settle();
    },
  };
}

test("第一份回执回来前连改比例和宽度：按操作顺序串行保存，最终控件、保存的整份、推给页面的都两项俱在", async () => {
  const rust = heldSaves();
  const env = await bootFeatures({ save: rust.save });
  env.ratio.value = "65";
  env.ratio.dispatch("change");
  changeTo(env.width, "1700");
  await settle();
  assert.equal(env.saved.length, 1, "同一时间只有一个保存在路上");
  assert.deepEqual([env.saved[0].split.leftPercent, env.saved[0].split.minWidth], [65, 1400]);
  assert.equal(env.ratio.value, "65", "界面按最新意图画");
  assert.equal(env.width.value, "1700");

  await rust.releaseNext();
  assert.equal(env.saved.length, 2);
  assert.deepEqual([env.saved[1].split.leftPercent, env.saved[1].split.minWidth], [65, 1700], "第二份从最新意图算，不是从上次确认的快照算");
  await rust.releaseNext();
  assert.equal(env.ratio.value, "65");
  assert.equal(env.width.value, "1700");
  // Rust 每存下一份就原样推给粉笔页面：最后推出去的就是最后存下的那份
  assert.deepEqual([env.saved.at(-1).split.leftPercent, env.saved.at(-1).split.minWidth], [65, 1700]);
});

test("第一份回执回来前关掉「记住标记」再改颜色：两项都保存，后一次不会把记住标记悄悄打开", async () => {
  const rust = heldSaves();
  const env = await bootFeatures({ save: rust.save });
  changeTo(env.remember, false);
  changeTo(env.colors[0], "#123456");
  await settle();
  assert.equal(env.remember.checked, false);
  assert.equal(env.colors[0].value, "#123456");
  await rust.releaseNext();
  await rust.releaseNext();
  const last = env.saved.at(-1).highlight;
  assert.equal(last.remember, false);
  assert.equal(last.colors[0], "#123456");
  assert.equal(env.remember.checked, false);
  assert.equal(env.colors[0].value, "#123456");
});

test("排着队时前一份被 Rust 拒：只退回那一批，后面排着的改动照常保存", async () => {
  const held = [];
  const env = await bootFeatures({ save: (settings) => new Promise((resolve, reject) => held.push({ settings, resolve, reject })) });
  changeTo(env.markOn, false);
  changeTo(env.splitOn, false);
  await settle();
  held.shift().reject("设置保存失败：磁盘满了");
  await settle();
  assert.equal(env.markOn.checked, true, "被拒的那项退回");
  assert.equal(env.splitOn.checked, false);
  assert.deepEqual([env.saved[1].highlight.enabled, env.saved[1].split.enabled], [true, false]);
  const next = held.shift();
  next.resolve(clone(next.settings));
  await settle();
  assert.equal(env.splitOn.checked, false);
});

test("颜色已经是默认时「恢复默认」置灰；改过颜色才能点", async () => {
  const env = await bootFeatures();
  const reset = env.all(".fenbi-reset-colors")[0];
  assert.ok(disabled(reset));
  changeTo(env.colors[2], "#000000");
  await settle();
  assert.ok(!disabled(reset));
  reset.click();
  await settle();
  assert.ok(disabled(reset));
});

test("Rust 拒绝保存：说出原因，控件退回保存前的值", async () => {
  const env = await bootFeatures({ save: () => Promise.reject("设置没有保存：磁盘满了") });
  changeTo(env.markOn, false);
  await settle();
  assert.equal(env.markOn.checked, true);
  const row = env.results().at(-1);
  assert.equal(row.getAttribute("data-kind"), "error");
  assert.match(row.textContent, /磁盘满了/);
});

test("清除全部标记：先确认一次；取消就什么都不发，确认只发一次清除命令", async () => {
  const env = await bootFeatures();
  env.all(".fenbi-clear")[0].click();
  assert.match(env.results().at(-1).textContent, /将清空所有练习的标记，无法恢复/);
  env.all(".fenbi-clear-cancel")[0].click();
  assert.equal(env.results().length, 0);
  assert.equal(env.calls.filter((c) => c.command === "clear_practice_marks").length, 0);

  env.all(".fenbi-clear")[0].click();
  env.all(".fenbi-clear-confirm")[0].click();
  await settle();
  assert.deepEqual(env.calls.filter((c) => c.command === "clear_practice_marks"), [{ command: "clear_practice_marks", args: undefined }]);
  assert.equal(env.results().at(-1).getAttribute("data-kind"), "ok");
  assert.match(env.results().at(-1).textContent, /已清除全部标记/);
});
