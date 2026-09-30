/* 独立本地工具栏：运行真实 toolbar.js，断言渲染和 IPC 边界。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, bootToolbar, press } from "../support/boot.mjs";

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
