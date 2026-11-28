/* 独立本地工具栏：运行真实 toolbar.js，断言渲染和 IPC 边界。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot, bootToolbar, press } from "../support/boot.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("本地工具栏默认展开，启动仅读取状态、不导航", async () => {
  const env = await bootToolbar();
  assert.equal(env.toolbarState(), "expanded");
  assert.ok(env.toolbarButton("back"));
  assert.deepEqual(env.invocations, ["toolbar_state"]);
});

test("独立工具栏恢复收起状态，同一控件可以展开", async () => {
  let snapshot = [4, true];
  const env = await bootToolbar({ invoke: () => Promise.resolve(snapshot) });
  assert.equal(env.toolbarState(), "collapsed");
  assert.deepEqual(env.toolbarBar().children, [env.toolbarToggle()]);
  env.toolbarToggle().dispatch("focus");
  env.toolbarToggle().click();
  assert.equal(env.invocations.at(-1), "toggle_toolbar");
  snapshot = [5, false];
  await env.refreshToolbar();
  assert.equal(env.toolbarState(), "expanded");
  assert.equal(env.toolbarBar().children.at(-1), env.toolbarToggle());
  assert.match(env.toolbarToggle().getAttribute("aria-label"), /收起/);
  assert.equal(env.document.querySelector(".fenbi-toolbar-status").textContent, "", "切换布局时清除旧提示");
  assert.equal(env.localStorage.size, 0, "状态由应用保存，不写网站存储");
});

test("四个图标按钮有 SVG、无可见文字，并保留动作和当前平台快捷键名称", async () => {
  for (const [platform, backHint] of [["MacIntel", "⌘["], ["Win32", "Alt+←"]]) {
    const env = await bootToolbar({ platform });
    for (const [action, name] of [["back", "返回上一页"], ["forward", "前进"],
      ["reload", "刷新"], ["catalog", "回题库"]]) {
      const button = env.toolbarButton(action);
      assert.ok(button, `${action} 按钮必须存在`);
      assert.ok(button.children.some((child) => child.tagName === "SVG"), `${action} 使用 SVG 图标`);
      assert.equal(button.textContent.trim(), "", `${action} 按钮里不显示常驻文案`);
      assert.match(button.getAttribute("aria-label"), new RegExp(name));
      assert.ok(env.hintText(button), `${action} 的无障碍名称包含快捷键`);
    }
    assert.equal(env.hintText(env.toolbarButton("back")), backHint);
  }
});

test("鼠标悬停和键盘聚焦时，工具栏空白处显示操作名称及快捷键", async () => {
  const env = await bootToolbar({ platform: "MacIntel" });
  const button = env.toolbarButton("back");
  const status = env.document.querySelector(".fenbi-toolbar-status");
  assert.ok(status, "工具栏应有统一的状态提示区");

  button.dispatch("mouseenter");
  assert.match(status.textContent, /返回上一页/);
  assert.match(status.textContent, /⌘\[/);

  button.dispatch("mouseleave");
  button.dispatch("focus");
  assert.match(status.textContent, /返回上一页/);
  assert.match(status.textContent, /⌘\[/);
});

test("收起后整条细栏可以点击展开，右侧有明确展开把手", async () => {
  const env = await bootToolbar({ invoke: () => Promise.resolve([4, true]) });
  const bar = env.toolbarBar();
  assert.equal(env.toolbarState(), "collapsed");
  assert.match(env.toolbarToggle().textContent, /展开/, "右侧要有可见展开提示");
  bar.click();
  assert.equal(env.calls.at(-1).command, "toggle_toolbar", "点击细栏空白处也能展开");
});

test("工具栏状态读取失败时提供可点击重试，成功后恢复操作按钮", async () => {
  let unavailable = true;
  const env = await bootToolbar({ invoke: (command) => {
    if (command !== "toolbar_state") return Promise.resolve(null);
    return unavailable ? Promise.reject(new Error("state IPC failed")) : Promise.resolve([1, false]);
  } });
  const retry = env.document.querySelector(".fenbi-toolbar-retry");
  assert.ok(retry, "状态读取失败不能留下空白栏");
  assert.match(retry.textContent, /重试工具栏/);
  unavailable = false;
  retry.click();
  await env.tick();
  assert.equal(env.toolbarState(), "expanded");
  assert.ok(env.toolbarButton("back"));
});

test("工具栏命令被拒绝后显示可见错误，技术详情记入控制台", async () => {
  const env = await bootToolbar({ invoke: (command) => command === "toolbar_state"
    ? Promise.resolve([0, false]) : Promise.reject(new Error("permission denied")) });
  env.toolbarButton("reload").click();
  await env.tick();
  assert.match(env.document.querySelector(".fenbi-toolbar-status")?.textContent ?? "", /操作未完成，请重试/);
  assert.match(env.logs.join("\n"), /permission denied/);
});

test("工具栏状态读取乱序返回不能恢复旧布局", async () => {
  let resolveOld;
  let count = 0;
  const env = await bootToolbar({ invoke: () => ++count === 1
    ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve([3, true]) });
  await env.refreshToolbar();
  resolveOld([2, false]);
  await env.tick();
  assert.equal(env.toolbarState(), "collapsed");
});

test("工具栏按钮只发送指定动作给 Rust", async () => {
  const env = await bootToolbar();
  for (const action of ["back", "forward", "reload", "catalog"]) {
    env.toolbarButton(action).click();
    assert.deepEqual(env.calls.at(-1), { command: "toolbar_action", args: { action } });
  }
  assert.deepEqual(env.navigations, [], "不能在工具栏 WebView 自身导航");
  assert.deepEqual(env.reloads, []);
});

test("展开时提示区和收起按钮之间有齿轮，悬停提示「设置」", async () => {
  const env = await bootToolbar();
  const gear = env.toolbarSettings();
  assert.ok(gear, "展开时必须有齿轮");
  const children = env.toolbarBar().children;
  const status = env.document.querySelector(".fenbi-toolbar-status");
  assert.deepEqual(children.slice(-3), [status, gear, env.toolbarToggle()]);
  assert.ok(gear.children.some((child) => child.tagName === "SVG"), "齿轮使用 SVG 图标");
  assert.equal(gear.textContent.trim(), "", "齿轮里不显示常驻文案");
  assert.equal(gear.getAttribute("aria-label"), "设置");
  gear.dispatch("mouseenter");
  assert.equal(status.textContent, "设置");
});

test("收起时没有齿轮", async () => {
  const env = await bootToolbar({ invoke: () => Promise.resolve([4, true]) });
  assert.equal(env.toolbarState(), "collapsed");
  assert.equal(env.toolbarSettings(), null);
});

const hasDot = (element) => element.children.some((child) => child.className === "fenbi-toolbar-dot");

test("有没看过的新版时齿轮带红点，收起时展开把手不带红点", async () => {
  let snapshot = [0, false, true];
  const env = await bootToolbar({ invoke: () => Promise.resolve(snapshot) });
  assert.ok(hasDot(env.toolbarSettings()), "展开时红点在齿轮上");
  assert.ok(!hasDot(env.toolbarToggle()), "展开时收起按钮不带红点");
  assert.equal(env.toolbarSettings().getAttribute("aria-label"), "设置", "红点不改提示文字");
  snapshot = [1, true, true];
  await env.refreshToolbar();
  assert.ok(!hasDot(env.toolbarToggle()), "收起时展开把手不带红点");
});

test("没有新版时齿轮和展开把手都不带红点", async () => {
  let snapshot = [0, false, false];
  const env = await bootToolbar({ invoke: () => Promise.resolve(snapshot) });
  assert.ok(!hasDot(env.toolbarSettings()));
  snapshot = [1, true, false];
  await env.refreshToolbar();
  assert.ok(!hasDot(env.toolbarToggle()));
});

test("启动后才查到新版时，重读状态就补上红点", async () => {
  let snapshot = [0, false, false];
  const env = await bootToolbar({ invoke: () => Promise.resolve(snapshot) });
  snapshot = [0, false, true];
  await env.refreshToolbar();
  assert.ok(hasDot(env.toolbarSettings()));
});

test("打开设置页面看过新版后，重读状态红点就消失", async () => {
  let snapshot = [0, false, true];
  const env = await bootToolbar({ invoke: () => Promise.resolve(snapshot) });
  assert.ok(hasDot(env.toolbarSettings()));
  snapshot = [1, false, false, true];
  await env.refreshToolbar();
  assert.ok(!hasDot(env.toolbarSettings()), "设置页面开着时齿轮不带红点");
  snapshot = [2, false, false, false];
  await env.refreshToolbar();
  assert.ok(!hasDot(env.toolbarSettings()), "关掉设置页面后红点不回来");
});

/* 设置页面开着的快照：[序号, 收起, 有没看过的新版, 设置页面开着]。 */
const SETTINGS_OPEN = [1, false, false, true];
const NAV_ACTIONS = ["back", "forward", "reload", "catalog"];

test("点齿轮只向 Rust 发开关设置页面这一个命令", async () => {
  const env = await bootToolbar();
  const before = env.calls.length;
  env.toolbarSettings().click();
  assert.deepEqual(env.calls.slice(before), [{ command: "toggle_settings", args: undefined }]);
  assert.deepEqual(env.navigations, [], "不能在工具栏 WebView 自身导航");
  assert.deepEqual(env.reloads, []);
});

test("设置页面关着时没有设置页面的内容，齿轮不是按下状态，Esc 不发任何命令", async () => {
  const env = await bootToolbar();
  assert.equal(env.settingsPage(), null);
  assert.equal(env.toolbarSettings().getAttribute("aria-pressed"), "false");
  const before = env.calls.length;
  const event = press(env, { code: "Escape", key: "Escape" });
  assert.equal(event.defaultPrevented, false, "Esc 留给别人用");
  assert.equal(env.calls.length, before);
});

test("设置页面开着时有返回箭头和「设置」标题，齿轮是按下状态", async () => {
  const env = await bootToolbar({ invoke: () => Promise.resolve(SETTINGS_OPEN) });
  assert.ok(env.settingsPage(), "工具栏下面画出设置页面");
  const back = env.settingsBack();
  assert.ok(back.children.some((child) => child.tagName === "SVG"), "返回只用箭头");
  assert.equal(back.textContent.trim(), "");
  assert.equal(back.getAttribute("title"), "返回");
  assert.equal(back.getAttribute("aria-label"), "返回");
  const title = env.document.querySelector(".fenbi-settings-title");
  assert.equal(title.tagName, "H1");
  assert.equal(title.textContent, "设置");
  assert.equal(env.toolbarSettings().getAttribute("aria-pressed"), "true");
});

test("设置页面开着时，返回、前进、刷新、回题库、收起都禁用，点了不发任何命令", async () => {
  const env = await bootToolbar({ invoke: () => Promise.resolve(SETTINGS_OPEN) });
  const buttons = [...NAV_ACTIONS.map((action) => env.toolbarButton(action)), env.toolbarToggle()];
  const before = env.calls.length;
  for (const button of buttons) {
    assert.notEqual(button.getAttribute("disabled"), null, button.getAttribute("aria-label"));
    button.click();
  }
  assert.equal(env.calls.length, before);
  assert.equal(env.toolbarSettings().getAttribute("disabled"), null, "齿轮还能点");
});

test("设置页面开着时，五个快捷键被吞掉、不发任何命令", async () => {
  for (const platform of ["MacIntel", "Win32"]) {
    const closed = await bootToolbar({ platform });
    const labels = [...NAV_ACTIONS.map((action) => closed.toolbarButton(action)), closed.toolbarToggle()]
      .map((button) => closed.hintText(button));
    const env = await bootToolbar({ platform, invoke: () => Promise.resolve(SETTINGS_OPEN) });
    const before = env.calls.length;
    for (const label of labels) {
      const event = pressLabel(env, label);
      assert.equal(event.defaultPrevented, true, `${label} 不能漏给系统默认行为`);
    }
    assert.equal(env.calls.length, before);
  }
});

test("设置页面开着时，按 Esc、点返回箭头、再点齿轮，各发一次开关设置页面", async () => {
  const env = await bootToolbar({ invoke: () => Promise.resolve(SETTINGS_OPEN) });
  const before = env.calls.length;
  const event = press(env, { code: "Escape", key: "Escape" });
  assert.equal(event.defaultPrevented, true);
  env.settingsBack().click();
  env.toolbarSettings().click();
  assert.deepEqual(env.calls.slice(before), Array(3).fill({ command: "toggle_settings", args: undefined }));
});

test("设置页面关掉后，设置页面的内容消失，按钮恢复可用", async () => {
  let snapshot = SETTINGS_OPEN;
  const env = await bootToolbar({ invoke: () => Promise.resolve(snapshot) });
  snapshot = [2, false, false, false];
  await env.refreshToolbar();
  assert.equal(env.settingsPage(), null);
  assert.equal(env.toolbarButton("back").getAttribute("disabled"), null);
  env.toolbarButton("back").click();
  assert.deepEqual(env.calls.at(-1), { command: "toolbar_action", args: { action: "back" } });
});

/* 设置页面开着的工具栏。`newer` 是启动时已经查到的新版；`check` 决定点「检查更新」后 Rust 怎么答。 */
async function bootSettings({ current = "0.1.3", newer = null, check } = {}) {
  const view = { open: true, revision: 0 };
  const env = await bootToolbar({
    invoke(command) {
      if (command === "toolbar_state") return Promise.resolve([++view.revision, false, newer !== null, view.open]);
      if (command === "settings_info") return Promise.resolve([current, newer]);
      if (command === "check_update") return check();
      return Promise.resolve(null);
    },
  });
  await settle();
  return Object.assign(env, { view });
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const sent = (env, command) => env.calls.filter((call) => call.command === command);

test("设置页面有「版本与更新」一组：应用名、当前版本号、「检查更新」按钮，没有结果行", async () => {
  const env = await bootSettings({ current: "0.1.3" });
  const group = env.document.querySelector(".fenbi-settings-group");
  assert.equal(group.tagName, "H2");
  assert.equal(group.textContent, "版本与更新");
  const card = env.settingsCard();
  assert.match(card.textContent, /粉笔刷题/);
  assert.match(card.textContent, /当前版本 v0\.1\.3/);
  assert.equal(env.settingsCheck().textContent, "检查更新");
  assert.equal(env.settingsResult(), null);
  assert.equal(env.settingsDownload(), null);
  assert.deepEqual(sent(env, "check_update"), [], "打开设置页面不自己联网");
});

test("启动时已经查到新版：打开设置页面就有「发现新版本」和「下载新版」", async () => {
  const env = await bootSettings({ newer: "0.1.4" });
  assert.equal(env.settingsResult().getAttribute("data-kind"), "update");
  assert.match(env.settingsResult().textContent, /发现新版本 v0\.1\.4/);
  assert.equal(env.settingsDownload().textContent, "下载新版 v0.1.4");
  assert.deepEqual(sent(env, "check_update"), []);
});

test("点「检查更新」只发一次检查命令；等待中按钮禁用、写着「正在检查更新…」，再点不再发", async () => {
  let answer;
  const env = await bootSettings({ check: () => new Promise((resolve) => { answer = resolve; }) });
  env.settingsCheck().click();
  assert.deepEqual(sent(env, "check_update"), [{ command: "check_update", args: undefined }]);
  assert.equal(env.settingsCheck().getAttribute("aria-disabled"), "true");
  assert.equal(env.settingsCheck().textContent, "正在检查更新…");
  env.settingsCheck().click();
  assert.equal(sent(env, "check_update").length, 1);
  answer(null);
  await settle();
  assert.equal(env.settingsCheck().getAttribute("aria-disabled"), "false");
  assert.equal(env.settingsCheck().textContent, "检查更新");
});

test("检查更新的三种结果各有一行；只有发现新版本带下载按钮", async () => {
  for (const [check, kind, text, download] of [
    [() => Promise.resolve(null), "ok", "已是最新版本", null],
    [() => Promise.resolve("0.2.0"), "update", "发现新版本 v0.2.0", "下载新版 v0.2.0"],
    [() => Promise.reject(new Error("超时")), "error", "检查更新失败，请稍后再试", null],
  ]) {
    const env = await bootSettings({ check });
    env.settingsCheck().click();
    await settle();
    assert.equal(env.settingsResult().getAttribute("data-kind"), kind, text);
    assert.equal(env.settingsResult().textContent.replace(download ?? "", ""), text);
    assert.equal(env.settingsDownload()?.textContent ?? null, download, text);
    assert.equal(env.document.querySelector(".fenbi-toolbar-status").textContent, "", "工具栏不出字");
  }
});

test("点「下载新版」只发一次打开发布页的命令，不带任何网址", async () => {
  const env = await bootSettings({ newer: "0.1.4" });
  const before = env.calls.length;
  env.settingsDownload().click();
  assert.deepEqual(env.calls.slice(before), [{ command: "open_release_page", args: undefined }]);
  assert.deepEqual(env.navigations, [], "不能在工具栏 WebView 自身导航");
});

test("关掉设置页面再打开，「已是最新版本」和「检查更新失败」不再显示", async () => {
  for (const check of [() => Promise.resolve(null), () => Promise.reject(new Error("超时"))]) {
    const env = await bootSettings({ check });
    env.settingsCheck().click();
    await settle();
    assert.ok(env.settingsResult());
    env.view.open = false;
    await env.refreshToolbar();
    env.view.open = true;
    await env.refreshToolbar();
    await settle();
    assert.ok(env.settingsCard());
    assert.equal(env.settingsResult(), null);
  }
});

/* 把按钮上显示出来的键位文字，按"用户读标签、照着自己按"的方式翻成事件。
 * 只做字形 → 事件字段的映射，不复制生产代码的匹配逻辑。 */
const MOD_GLYPHS = ["⌘", "⌃", "⌥", "⇧", "Ctrl", "Alt", "Shift"];
const MOD_FIELDS = {
  "⌘": "metaKey",
  "⌃": "ctrlKey",
  "⌥": "altKey",
  "⇧": "shiftKey",
  Ctrl: "ctrlKey",
  Alt: "altKey",
  Shift: "shiftKey",
};
const KEY_EVENTS = {
  "[": { code: "BracketLeft", key: "[" },
  "]": { code: "BracketRight", key: "]" },
  R: { code: "KeyR", key: "r" },
  B: { code: "KeyB", key: "b" },
  "←": { code: "ArrowLeft", key: "ArrowLeft" },
  "→": { code: "ArrowRight", key: "ArrowRight" },
};

function pressLabel(env, label) {
  const event = {};
  let rest = label ?? "";
  for (;;) {
    const glyph = MOD_GLYPHS.find((candidate) => rest.startsWith(candidate));
    if (!glyph) break;
    event[MOD_FIELDS[glyph]] = true;
    rest = rest.slice(glyph.length).replace(/^\+/, "");
  }
  const keyEvent = KEY_EVENTS[rest];
  assert.ok(keyEvent, `认不出这个键位提示：${label}`);
  return press(env, { ...keyEvent, ...event });
}

test("本地工具栏显示的键位与实际动作一致，站点共用同一份绑定", async () => {
  for (const platform of ["MacIntel", "Win32"]) {
    const env = await bootToolbar({ platform });
    for (const action of ["back", "forward", "reload", "catalog"]) {
      const event = pressLabel(env, env.hintText(env.toolbarButton(action)));
      assert.equal(event.defaultPrevented, true);
      assert.deepEqual(env.calls.at(-1), { command:"toolbar_action", args:{action} });
    }
    pressLabel(env, env.hintText(env.toolbarToggle()));
    assert.equal(env.calls.at(-1).command, "toggle_toolbar");
  }
});

test("Rust 让工具栏提示一句（标记没保存上）：展开时在状态位、收起时在细条上都看得见，过一会儿自己撤掉", async () => {
  const text = "标记没保存上：这份练习的标记太多了（最多 500 处）";
  const env = await bootToolbar();
  env.window.__fenbiShowError(text);
  assert.equal(env.document.querySelector(".fenbi-toolbar-status").textContent, text);
  assert.equal(env.document.querySelector(".fenbi-toolbar-status").getAttribute("data-kind"), "error");
  env.advance(8000);
  assert.equal(env.document.querySelector(".fenbi-toolbar-status").textContent, "");

  const collapsed = await bootToolbar({ invoke: () => Promise.resolve([1, true]) });
  collapsed.window.__fenbiShowError(text);
  assert.match(collapsed.toolbarToggle().textContent, /标记没保存上/);

  // Rust 那边写盘失败时就是调这个入口（marks.rs 的 notify_toolbar）
  const rust = readFileSync(path.join(REPO_ROOT, "src-tauri/src/marks.rs"), "utf8");
  assert.match(rust, /window\.__fenbiShowError && window\.__fenbiShowError\(/);
});
