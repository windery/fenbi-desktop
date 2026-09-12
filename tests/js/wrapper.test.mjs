/* init.js 的行为测试。
 *
 * 断言只观察**外部可见结果**：登录框被点了几次、导航发生了几次、
 * 排队的提示有没有补上、定时任务有没有停。不复制生产算法做"互相验证"。
 *
 * 场景清单对应 docs/improvement-proposal.md 第 6 节的验收矩阵。
 *
 * 用 FENBI_INIT_JS=<旧版 init.js> 跑本文件，可以确认这些用例确实拦得住旧缺陷：
 *   git show HEAD:src-tauri/init.js > /tmp/old-init.js
 *   FENBI_INIT_JS=/tmp/old-init.js node --test 'tests/js/*.test.mjs'
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_PATH, PRACTICE_URL, TARGET_URL, createEnv } from "./harness.mjs";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const fixture = (name) => readFileSync(path.join(FIXTURES, name), "utf8");

const CATALOG_URL = `https://www.fenbi.com${CATALOG_PATH}`;
/** 宽到足以跑完任何重试预算的时间。 */
const LONG_ENOUGH_MS = 60_000;

async function boot(overrides = {}) {
  const env = createEnv({
    url: CATALOG_URL,
    html: fixture("catalog-page.html"),
    record: false,
    ...overrides,
  });
  await env.tick();
  return env;
}

/* 时间参数优先问生产代码要（debug 构建下 init.js 会暴露 internals）；
 * 拿旧版本跑验证时用一个偏大的值兜底。测试里不抄精确数值。 */
const promptDelayMs = (env) =>
  env.internals ? env.internals.timings.initialPromptDelayMs : 1_000;
const retryTickMs = (env) => (env.internals ? env.internals.timings.loginBtnRetryMs : 300);
/** 只有 debug 构建会挂 internals；旧版本没有，用于验证测试有效性时会缺。 */
const detail = (env) => env.internals;

/* ── 登录按钮延迟渲染 ─────────────────────────────────────────── */

test("首次启动：按钮稍后渲染出来，弹一次登录框", async () => {
  const env = await boot({ html: fixture("catalog-not-yet-rendered.html") });
  assert.equal(env.loginButtons().length, 0, "前置条件：此刻按钮还不存在，弹框必须排队");

  env.advance(promptDelayMs(env));
  const button = env.showLoginButton();
  env.advance(retryTickMs(env));

  assert.equal(button.clicks, 1, "按钮一出现就该弹，且只弹一次");
  if (detail(env)) {
    assert.equal(detail(env).promptTimerActive(), false, "弹完必须停掉重试");
  }
});

test("按钮一直不出现：有限重试后停手，页面仍可手动操作", async () => {
  const env = await boot({ html: fixture("catalog-not-yet-rendered.html") });
  env.advance(LONG_ENOUGH_MS);

  const button = env.showLoginButton();
  env.advance(LONG_ENOUGH_MS);
  assert.equal(button.clicks, 0, "重试预算用完就该停手");
});

/* ── 取消与合并：旧版最容易漏的两处 ──────────────────────────── */

test("记录为 false、凭证稍后恢复：取消所有还没执行的弹框", async () => {
  const env = await boot({ html: fixture("catalog-not-yet-rendered.html") });

  env.advance(promptDelayMs(env) + retryTickMs(env));
  env.window.__fenbiLoginSucceeded();

  const button = env.showLoginButton();
  env.advance(LONG_ENOUGH_MS);

  assert.equal(button.clicks, 0, "已经观测到凭证，不该再弹");
  if (detail(env)) {
    assert.equal(detail(env).promptTimerActive(), false, "观测到凭证后必须停掉重试");
  }
});

test("重复的登出通知：合并成一次弹框，不点两次", async () => {
  const env = await boot({ html: fixture("catalog-not-yet-rendered.html"), record: true });

  env.window.__fenbiLoggedOut("session-lost", false);
  env.window.__fenbiLoggedOut("session-lost", false);

  const button = env.showLoginButton();
  env.advance(promptDelayMs(env) + LONG_ENOUGH_MS);

  assert.equal(button.clicks, 1, "重复事件只该产生一个弹框");
});

test("登录记录读不出来：不据此弹登录框", async () => {
  const env = await boot({ record: new Error("ipc 调用失败") });
  env.advance(LONG_ENOUGH_MS);
  assert.equal(env.loginButtons()[0].clicks, 0);
});

/* ── 登录框本身的状态判断 ────────────────────────────────────── */

test("登录框已经可见：不重复点", async () => {
  const env = await boot({ html: fixture("login-modal-open.html") });
  env.advance(LONG_ENOUGH_MS);
  assert.equal(env.loginButtons()[0].clicks, 0);
});

test("登录框常驻 DOM 但不可见：仍然要点出来", async () => {
  const env = await boot({ html: fixture("login-modal-hidden.html") });
  env.advance(promptDelayMs(env));
  assert.equal(env.loginButtons()[0].clicks, 1);
});

/* ── 导航：防重载循环 ───────────────────────────────────────── */

test("记录说已登录且已在目录页：不再 replace，避免重载死循环", async () => {
  const env = await boot({ record: true });
  assert.deepEqual(env.navigations, []);
  assert.deepEqual(env.reloads, []);
});

test("记录说已登录、站点跳到搜索结果页：不拉回目录页", async () => {
  // 真实搜题的落点（浏览器里实测：window.open("/spa/tiku/guide/question/search?...", "_blank")）。
  // 旧实现会立刻 replace 回目录页，表现成"搜索点了没反应"。
  const env = await boot({
    url: "https://www.fenbi.com/spa/tiku/guide/question/search?q=x&courseSet=syzc&qType=1",
    record: true,
  });
  assert.deepEqual(env.navigations, [], "站内页面一律不干预");

  env.advance(LONG_ENOUGH_MS);
  assert.deepEqual(env.navigations, [], "也不该过一会儿再跳");
});

test("记录说已登录、站点把我带到别的站内页：同样不拉回目录页", async () => {
  const env = await boot({
    url: "https://www.fenbi.com/spa/tiku/guide/home/xingce/xingce",
    record: true,
  });
  assert.deepEqual(env.navigations, []);

  env.advance(LONG_ENOUGH_MS);
  assert.deepEqual(env.navigations, []);
});

/* ── 练习区保护 ─────────────────────────────────────────────── */

/* ── 练习区：不再特殊对待，登录提示一视同仁 ───────────────────── */

test("直接落在 /ti/ 页面、没有登录记录：照常弹登录框", async () => {
  const env = await boot({ url: PRACTICE_URL, html: fixture("practice-page.html") });

  env.advance(promptDelayMs(env));
  assert.equal(env.loginButtons()[0].clicks, 1, "练习页不再推迟登录提示");
  assert.deepEqual(env.navigations, []);
});

test("在 /ti/ 页面观测不到会话：立刻弹框，不排队", async () => {
  const env = await boot({ url: PRACTICE_URL, html: fixture("practice-page.html"), record: true });
  const button = env.loginButtons()[0];

  // Rust 即便标注 deferred，页面也不再排队——练习区特例已删除
  env.window.__fenbiLoggedOut("session-lost", true);
  assert.equal(button.clicks, 1, "必须立刻弹，而不是等离开练习区");

  env.advance(LONG_ENOUGH_MS);
  assert.equal(button.clicks, 1, "只弹一次");
});

test("在 /ti/ 页面也不跳转、不刷新", async () => {
  const env = await boot({ url: PRACTICE_URL, html: fixture("practice-page.html"), record: true });

  env.advance(LONG_ENOUGH_MS);
  assert.deepEqual(env.navigations, []);
  assert.deepEqual(env.reloads, []);
});

/* ── 工具横栏：注入、收起/展开、状态记忆 ────────────────────── */

test("横栏注入为 body 的首个子节点，默认收起", async () => {
  const env = await boot({});

  const host = env.toolbar();
  assert.ok(host, "必须注入横栏");
  assert.equal(env.document.body.children[0], host, "横栏要是 body 的第一个子节点（占位，不覆盖站点 header）");
  assert.equal(env.toolbarState(), "collapsed", "默认收起");
  assert.ok(host.shadowRoot, "内容放在 Shadow DOM 里，站点 CSS 改不到按钮");
  assert.equal(env.toolbarButton("back"), null, "收起态不渲染动作按钮");
});

test("点小箭头展开、再点收起，状态写进 localStorage", async () => {
  const env = await boot({});

  const handle = env.toolbarHandle();
  assert.ok(handle, "收起态要留一个小箭头");

  handle.click();
  assert.equal(env.toolbarState(), "expanded");
  assert.equal(env.localStorage.get("fenbi-wrapper-toolbar"), "expanded");
  assert.ok(env.toolbarButton("back"), "展开后出现动作按钮");

  handle.click();
  assert.equal(env.toolbarState(), "collapsed");
  assert.equal(env.localStorage.get("fenbi-wrapper-toolbar"), "collapsed");
});

test("上次展开过：这次页面加载就是展开的", async () => {
  const env = await boot({ storage: { "fenbi-wrapper-toolbar": "expanded" } });
  assert.equal(env.toolbarState(), "expanded");
  assert.ok(env.toolbarButton("back"));
});

/* ── 横栏的四个按钮 ─────────────────────────────────────────── */

test("横栏按钮：返回 / 前进 / 刷新 / 回题库 各做各的事", async () => {
  const env = await boot({ storage: { "fenbi-wrapper-toolbar": "expanded" } });
  env.history.pushState({}, "", "/spa/tiku/guide/question/search?q=x");
  const searchPath = env.location.pathname;

  env.toolbarButton("back").click();
  assert.equal(env.location.pathname, CATALOG_PATH, "返回上一页");

  env.toolbarButton("forward").click();
  assert.equal(env.location.pathname, searchPath, "前进回到刚才那页");

  env.toolbarButton("reload").click();
  assert.deepEqual(env.reloads, [searchPath], "刷新当前页");

  env.toolbarButton("catalog").click();
  assert.deepEqual(env.navigations, [TARGET_URL], "回题库跳目录页");
  assert.equal(env.location.pathname, CATALOG_PATH);
});

test("按钮上内联显示当前平台的快捷键", async () => {
  const mac = await boot({ storage: { "fenbi-wrapper-toolbar": "expanded" }, platform: "MacIntel" });
  assert.match(mac.toolbarButton("back").textContent, /⌘\[/);
  assert.match(mac.toolbarButton("forward").textContent, /⌘\]/);
  assert.match(mac.toolbarButton("reload").textContent, /⌘R/);
  assert.match(mac.toolbarButton("catalog").textContent, /⌘⇧\[/);

  const win = await boot({ storage: { "fenbi-wrapper-toolbar": "expanded" }, platform: "Win32" });
  assert.match(win.toolbarButton("back").textContent, /Alt\+←/);
  assert.match(win.toolbarButton("forward").textContent, /Alt\+→/);
  assert.match(win.toolbarButton("reload").textContent, /Ctrl\+R/);
  assert.match(win.toolbarButton("catalog").textContent, /Ctrl\+⇧\[/);
});

/* ── 快捷键：跟按钮一一对应 ─────────────────────────────────── */

function press(env, partial) {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    propagationStopped: false,
    stopPropagation() {
      event.propagationStopped = true;
    },
    ...partial,
  };
  env.window.dispatch("keydown", event);
  return event;
}

test("macOS 快捷键：⌘[ 返回、⌘] 前进、⌘R 刷新、⌘⇧[ 回题库", async () => {
  const env = await boot({ platform: "MacIntel" });
  env.history.pushState({}, "", "/spa/tiku/guide/question/search?q=x");
  const searchPath = env.location.pathname;

  const back = press(env, { code: "BracketLeft", key: "[", metaKey: true });
  assert.equal(back.defaultPrevented, true, "要 preventDefault，不让按键漏给站点");
  assert.equal(back.propagationStopped, true, "要 stopPropagation");
  assert.equal(env.location.pathname, CATALOG_PATH, "⌘[ 返回");

  press(env, { code: "BracketRight", key: "]", metaKey: true });
  assert.equal(env.location.pathname, searchPath, "⌘] 前进");

  press(env, { code: "KeyR", key: "r", metaKey: true });
  assert.deepEqual(env.reloads, [searchPath], "⌘R 刷新");

  press(env, { code: "BracketLeft", key: "{", metaKey: true, shiftKey: true });
  assert.deepEqual(env.navigations, [TARGET_URL], "⌘⇧[ 回题库");
});

test("Windows 快捷键：Alt+← / Alt+→ / Ctrl+R / Ctrl+⇧+[", async () => {
  const env = await boot({ platform: "Win32" });
  env.history.pushState({}, "", "/spa/tiku/guide/question/search?q=x");
  const searchPath = env.location.pathname;

  press(env, { code: "ArrowLeft", key: "ArrowLeft", altKey: true });
  assert.equal(env.location.pathname, CATALOG_PATH, "Alt+← 返回");

  press(env, { code: "ArrowRight", key: "ArrowRight", altKey: true });
  assert.equal(env.location.pathname, searchPath, "Alt+→ 前进");

  press(env, { code: "KeyR", key: "r", ctrlKey: true });
  assert.deepEqual(env.reloads, [searchPath], "Ctrl+R 刷新");

  press(env, { code: "BracketLeft", key: "{", ctrlKey: true, shiftKey: true });
  assert.deepEqual(env.navigations, [TARGET_URL], "Ctrl+⇧+[ 回题库");
});

test("不带修饰键的裸键不触发任何动作", async () => {
  const env = await boot({ platform: "MacIntel" });
  env.history.pushState({}, "", "/spa/tiku/guide/question/search?q=x");

  press(env, { code: "BracketLeft", key: "[" });
  press(env, { code: "ArrowLeft", key: "ArrowLeft" });
  press(env, { code: "KeyR", key: "r" });

  assert.deepEqual(env.navigations, []);
  assert.deepEqual(env.reloads, []);
  assert.equal(env.location.pathname, "/spa/tiku/guide/question/search");
});

/* ── 诊断信息脱敏 ───────────────────────────────────────────── */

test("诊断日志不带完整 URL 的 query", async () => {
  const env = await boot({ url: `${CATALOG_URL}?labelId=4147&token=secret`, record: true });
  const emitted = [...env.logs, ...env.beacons].join("\n");
  assert.ok(!emitted.includes("token=secret"), `诊断输出里出现了 query：\n${emitted}`);
  assert.ok(!emitted.includes("labelId=4147"), `诊断输出里出现了 query：\n${emitted}`);
});
