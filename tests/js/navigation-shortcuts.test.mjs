/* 网站侧快捷键与导航：保留历史，且不越过工具栏权限边界。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, CATALOG_PATH, LONG_ENOUGH_MS, press, TARGET_URL } from "../support/boot.mjs";

/* ── 导航：防重载循环 ───────────────────────────────────────── */

test("决策是已登录且已在目录页：不再 replace，避免重载死循环", async () => {
  const env = await boot({ decision: [1, "logged-in"] });
  assert.deepEqual(env.navigations, []);
  assert.deepEqual(env.reloads, []);
});

test("决策是已登录、站点跳到搜索结果页：不拉回目录页", async () => {
  // 真实搜题的落点（浏览器里实测：window.open("/spa/tiku/guide/question/search?...", "_blank")）。
  // 旧实现会立刻 replace 回目录页，表现成"搜索点了没反应"。
  const env = await boot({
    url: "https://www.fenbi.com/spa/tiku/guide/question/search?q=x&courseSet=syzc&qType=1",
    decision: [1, "logged-in"],
  });
  assert.deepEqual(env.navigations, [], "站内页面一律不干预");

  env.advance(LONG_ENOUGH_MS);
  assert.deepEqual(env.navigations, [], "也不该过一会儿再跳");
});

test("决策是已登录、站点把我带到别的站内页：同样不拉回目录页", async () => {
  const env = await boot({
    url: "https://www.fenbi.com/spa/tiku/guide/home/xingce/xingce",
    decision: [1, "logged-in"],
  });
  assert.deepEqual(env.navigations, []);

  env.advance(LONG_ENOUGH_MS);
  assert.deepEqual(env.navigations, []);
});
test("站点中的收起快捷键仅请求 Rust 调整工具栏，不注入 DOM", async () => {
  for (const platform of ["MacIntel", "Win32"]) {
    const env = await boot({ platform });
    const event = press(env, { code: "KeyB", key: "B", shiftKey: true,
      ...(platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true }) });
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.equal(env.invocations.at(-1), "toggle_toolbar");
    assert.equal(env.toolbar(), null);
    assert.deepEqual(env.navigations, []);
  }
});

test("裸 Cmd+B 不吞站点按键，也不请求工具栏", async () => {
  const env = await boot({ platform: "MacIntel" });
  const before = env.invocations.length;
  assert.equal(press(env, { code:"KeyB", key:"b", metaKey:true }).defaultPrevented, false);
  assert.equal(env.invocations.length, before);
});
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
  assert.equal(env.location.pathname, CATALOG_PATH);
  env.history.back();
  assert.equal(env.location.href, `https://www.fenbi.com${searchPath}?q=x`, "回题库后返回仍到搜索结果页");
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
  assert.equal(env.location.pathname, CATALOG_PATH);
  env.history.back();
  assert.equal(env.location.href, `https://www.fenbi.com${searchPath}?q=x`, "回题库后返回仍到搜索结果页");
});

test("已在题库目录时，回题库快捷键不重复导航或增加历史条目", async () => {
  for (const platform of ["MacIntel", "Win32"]) {
    const env = await boot({ platform });
    const initialHistoryLength = env.history.length;
    press(env, { code: "BracketLeft", key: "{", shiftKey: true,
      ...(platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true }) });
    assert.deepEqual(env.navigations, [], `${platform} 目录页不应再次加载`);
    assert.equal(env.history.length, initialHistoryLength, `${platform} 不应增加历史条目`);
  }
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
