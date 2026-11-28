/* 做题页划词标记：执行真实的 highlight.js，断言高亮登记表、事件拦没拦、存了什么、有没有联网或写站点存储。
   harness 没有渲染，看不到底色；颜色真不真、悬停下划线显不显示，按 CONTRIBUTING.md 在真实做题页核对。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootHighlight, DEFAULT_SETTINGS, marksBackend, practiceOfLocation, press } from "../support/boot.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MARKS = ["fenbi-mark-1", "fenbi-mark-2", "fenbi-mark-3"];
const PRACTICE = "exercise:1_3e_2k95rs8";

const H = { code: "KeyH", key: "h" };
const V = { code: "KeyV", key: "v" };
const C = { code: "KeyC", key: "c" };
const SHIFT_DELETE = { code: "Delete", key: "Delete", shiftKey: true };
const SHIFT_BACKSPACE = { code: "Backspace", key: "Backspace", shiftKey: true };

/** 默认设置上改几项划词设置。 */
function withHighlight(changes) {
  return { ...DEFAULT_SETTINGS, highlight: { ...DEFAULT_SETTINGS.highlight, ...changes } };
}
const KEY_MODE = withHighlight({ mode: "key" });

/** 两道题、每道题一段 20 个字的文字；返回各自的题目容器、段落和文字节点。
 * 测试里第 1 题画在 y < 90、第 2 题画在下面：右键没指定命中元素时，按 y 取那道题的段落（真浏览器里就是点中的元素）。 */
async function practicePage(overrides) {
  const env = await bootHighlight(overrides);
  const q1 = env.element("app-ti", "question-multiple");
  const q2 = env.element("app-ti", "question-multiple");
  const p1 = env.element("p", "", q1);
  const p2 = env.element("p", "", q2);
  const contextMenu = env.contextMenu;
  env.contextMenu = (x, y, partial = {}) => contextMenu(x, y, { target: y < 90 ? p1 : p2, ...partial });
  return { env, q1, q2, p1, p2, t1: env.textNode(p1), t2: env.textNode(p2) };
}

const writes = (env) => env.calls.filter((c) => c.command === "write_practice_marks");

const at = (left, top) => [{ left, top, right: left + 50, bottom: top + 20 }];

function counts(env) {
  return MARKS.map((name) => env.markCount(name));
}

function markStyle(env) {
  return env.document.head.children.find((el) => el.getAttribute("data-fenbi-wrapper") === "highlight") ?? null;
}

/* ── 松手即标记（默认） ─────────────────────────────────── */

test("拖选题目文字松手：标成第 1 种颜色，取消选区，吞掉紧跟着的那次 click（不误选选项）", async () => {
  const { env, t1 } = await practicePage();

  const { click } = env.drag(t1, 0, 5, at(10, 10));

  assert.deepEqual(counts(env), [1, 0, 0]);
  assert.equal(env.selection.rangeCount, 0, "不取消选区，蓝色选中态会盖住底色");
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.immediatePropagationStopped, true, "站点在选项上的点击处理不能收到这次 click");
  const style = markStyle(env);
  assert.ok(style, "要往页面加一条 ::highlight() 样式");
  for (const name of [...MARKS, "fenbi-mark-hover"]) assert.match(style.textContent, new RegExp(`::highlight\\(${name}\\)`));
});

test("单击选项（没有选区）：不标，click 照常交给站点；拖选标完之后的下一次单击也照常", async () => {
  const { env, t1 } = await practicePage();
  env.mouseDown();
  env.mouseUp();
  const plain = env.click();
  assert.equal(plain.defaultPrevented, false);
  assert.equal(plain.propagationStopped, false);
  assert.deepEqual(counts(env), [0, 0, 0]);

  env.drag(t1, 0, 5, at(10, 10));
  env.mouseDown();
  env.mouseUp();
  const next = env.click();
  assert.equal(next.defaultPrevented, false, "上一次拖选的吞 click 不能留到下一次单击");
});

test("右键松开（button 2）不标", async () => {
  const { env, t1 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));
  env.mouseUp(0, 0, { button: 2 });
  assert.deepEqual(counts(env), [0, 0, 0]);
  assert.equal(env.selection.rangeCount, 1);
});

test("重新拖选已标的同一段：不重复登记", async () => {
  const { env, t1 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));
  env.drag(t1, 0, 5, at(10, 10));
  assert.deepEqual(counts(env), [1, 0, 0]);
});

test("焦点在输入框 / 文本框 / 可编辑区域里拖选：不标，click 照常", async () => {
  for (const make of [
    (env) => Object.assign(env.element("input"), { type: "text" }),
    (env) => env.element("textarea", "solution-note-editor"),
    (env) => Object.assign(env.element("div"), { isContentEditable: true }),
  ]) {
    const { env, t1 } = await practicePage();
    const field = make(env);
    env.focus(field);
    const { click } = env.drag(t1, 0, 5, at(10, 10));
    assert.deepEqual(counts(env), [0, 0, 0], `${field.tagName} 里选字不能被标`);
    assert.equal(click.defaultPrevented, false);
  }
});

test("焦点停在选项的单选框上（选完答案）：照样能标", async () => {
  const { env, t1 } = await practicePage();
  env.focus(Object.assign(env.element("input", "option-radio"), { type: "radio" }));
  env.drag(t1, 0, 5, at(10, 10));
  assert.deepEqual(counts(env), [1, 0, 0]);
});

test("从一道题拖选到另一道题、全选或两端在题外：不标、选区留着、click 照常", async () => {
  for (const [from, to] of [
    ["t1", "t2"],
    ["outside", "outside2"],
    ["outside", "t1"],
    ["t1", "outside"],
  ]) {
    const page = await practicePage();
    const { env } = page;
    page.outside = env.textNode(env.element("p", ""));
    page.outside2 = env.textNode(env.element("p", ""));
    const { click } = env.drag(page[from], 2, 3, [...at(10, 10), ...at(10, 100)], page[to]);
    assert.deepEqual(counts(env), [0, 0, 0], `${from} → ${to}`);
    assert.equal(env.selection.rangeCount, 1, `${from} → ${to}`);
    assert.equal(click.defaultPrevented, false, `${from} → ${to}`);
  }
});

test("同一道题里跨几段文字拖选：照样能标", async () => {
  const { env, q1, t1 } = await practicePage();
  const later = env.textNode(env.element("p", "", q1));
  env.drag(t1, 2, 4, at(10, 10), later);
  assert.deepEqual(counts(env), [1, 0, 0]);
});

test("不是做题页：拖选不标、不加样式、click 照常", async () => {
  for (const url of [
    "https://www.fenbi.com/spa/tiku/guide/catalog",
    "https://spa.fenbi.com/ti/exam/solution/1_3e_2k963k2",
    // 只认 spa.fenbi.com：别的粉笔子域上同样的路径不算
    "https://www.fenbi.com/ti/exam/exercise/1_3e_2k95rs8",
    "https://fenbi.com/ti/memorize/1_3e_2k96k2k",
    // 路径必须正好是一个 id
    "https://spa.fenbi.com/ti/exam/exercise/",
    "https://spa.fenbi.com/ti/memorize/",
    "https://spa.fenbi.com/ti/exam/exercise/1_3e_2k95rs8/report",
    "https://spa.fenbi.com/ti/memorize/1_3e_2k96k2k/extra/",
  ]) {
    const { env, t1 } = await practicePage({ url });
    const { click } = env.drag(t1, 0, 5, at(10, 10));
    assert.deepEqual(counts(env), [0, 0, 0], url);
    assert.equal(markStyle(env), null, url);
    assert.equal(click.defaultPrevented, false, url);
    assert.equal(env.selection.rangeCount, 1, `${url}：选区原样留着`);
    assert.equal(press(env, V).defaultPrevented, false, `${url}：快捷键也不拦`);
  }
});

test("做题页地址允许结尾的 / 和查询串；背题页也是做题页", async () => {
  for (const url of [
    "https://spa.fenbi.com/ti/exam/exercise/1_3e_2k95rs8/",
    "https://spa.fenbi.com/ti/exam/exercise/1_3e_2k95rs8/?routecs=syzc",
    "https://spa.fenbi.com/ti/memorize/1_3e_2k96k2k?x=1",
  ]) {
    const { env, t1 } = await practicePage({ url });
    env.drag(t1, 0, 5, at(10, 10));
    assert.deepEqual(counts(env), [1, 0, 0], url);
  }
});

/* ── 右键删除、Shift+右键换色 ─────────────────────────────── */

test("右键点一处标记：只删这一处，不弹菜单；不在标记上的右键照常", async () => {
  const { env, t1, t2 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));
  env.drag(t2, 0, 5, at(10, 100));

  const miss = env.contextMenu(500, 500);
  assert.equal(miss.defaultPrevented, false, "不在标记上：菜单照常");
  assert.deepEqual(counts(env), [2, 0, 0]);

  env.hover(20, 105);
  const hit = env.contextMenu(20, 105);
  assert.equal(hit.defaultPrevented, true, "在标记上：不弹菜单");
  assert.equal(hit.propagationStopped, true);
  assert.deepEqual(counts(env), [1, 0, 0]);
  assert.equal(env.markCount("fenbi-mark-hover"), 0, "删掉的那处不能还挂着悬停样式");
});

test("Shift+右键点一处标记：这一处 3 种颜色循环，不弹菜单", async () => {
  const { env, t1 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));
  for (const expected of [[0, 1, 0], [0, 0, 1], [1, 0, 0]]) {
    const event = env.contextMenu(20, 15, { shiftKey: true });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(counts(env), expected);
  }
});

/* ── 快捷键：换笔色、显示 / 隐藏 ─────────────────────────── */

test("切换笔色键（默认 C）：之后新标的用下一种颜色，已有的不变；带修饰键不算", async () => {
  const { env, t1 } = await practicePage();
  env.drag(t1, 0, 3, at(10, 10));
  assert.equal(press(env, C).defaultPrevented, true);
  env.drag(t1, 4, 8, at(80, 10));
  assert.deepEqual(counts(env), [1, 1, 0]);

  for (const mod of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) {
    assert.equal(press(env, { ...C, [mod]: true }).defaultPrevented, false, `${mod}+C 是别人的键（Cmd+C 复制）`);
  }
  press(env, C);
  env.drag(t1, 9, 12, at(150, 10));
  assert.deepEqual(counts(env), [1, 1, 1]);
  press(env, C);
  env.drag(t1, 13, 15, at(220, 10));
  assert.deepEqual(counts(env), [2, 1, 1], "3 种颜色循环");
});

test("显示 / 隐藏键（默认 V）：一键藏起全部标记、数据留着，再按恢复；藏着时拖选和右键都不生效", async () => {
  const { env, t1, t2 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));
  env.contextMenu(20, 15, { shiftKey: true });
  env.drag(t2, 0, 5, at(10, 100));

  assert.equal(press(env, V).defaultPrevented, true);
  assert.deepEqual(counts(env), [0, 0, 0], "隐藏 = 从登记表里拿掉");
  const { click } = env.drag(t2, 6, 9, at(80, 100));
  assert.equal(click.defaultPrevented, false, "藏着时拖选不标、不吞 click");
  assert.equal(env.contextMenu(20, 15).defaultPrevented, false, "藏着时右键照常弹菜单");
  assert.equal(press(env, C).defaultPrevented, false);

  press(env, V);
  assert.deepEqual(counts(env), [1, 1, 0], "再按恢复，原来的颜色都在");
});

test("快捷键在设置页面改了立即生效：新键管用、旧键不再拦", async () => {
  const { env, t1 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));
  env.applySettings(withHighlight({ toggleKey: "Alt+Shift+KeyM", colorKey: "F2" }));

  assert.equal(press(env, V).defaultPrevented, false);
  assert.equal(press(env, C).defaultPrevented, false);
  assert.equal(press(env, { code: "KeyM", key: "M", altKey: true, shiftKey: true }).defaultPrevented, true);
  assert.deepEqual(counts(env), [0, 0, 0]);
  press(env, { code: "KeyM", key: "M", altKey: true, shiftKey: true });
  assert.equal(press(env, { code: "F2", key: "F2" }).defaultPrevented, true);
  env.drag(t1, 6, 9, at(80, 10));
  assert.deepEqual(counts(env), [1, 1, 0]);
});

test("焦点在输入框里：显示 / 隐藏、换笔色键都不拦（照常打字）", async () => {
  const { env } = await practicePage();
  const field = Object.assign(env.element("input"), { type: "text" });
  env.focus(field);
  for (const key of [V, C]) assert.equal(press(env, { ...key, target: field }).defaultPrevented, false);
});

/* ── 设置：总开关、颜色、标记方式 ─────────────────────────── */

test("总开关关掉：已有标记藏起，拖选、右键、快捷键都不生效；再打开恢复", async () => {
  const { env, t1 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));

  env.applySettings(withHighlight({ enabled: false }));
  assert.deepEqual(counts(env), [0, 0, 0]);
  assert.equal(env.drag(t1, 6, 9, at(80, 10)).click.defaultPrevented, false);
  assert.equal(env.contextMenu(20, 15).defaultPrevented, false);
  assert.equal(press(env, V).defaultPrevented, false);

  env.applySettings(DEFAULT_SETTINGS);
  assert.deepEqual(counts(env), [1, 0, 0]);
});

test("启动时总开关就是关的：什么都不加、不拦、不读存储", async () => {
  const { env, t1 } = await practicePage({ settings: withHighlight({ enabled: false }) });
  env.drag(t1, 0, 5, at(10, 10));
  assert.equal(markStyle(env), null);
  assert.deepEqual(env.invocations, []);
});

test("颜色在设置页面改了：样式立即换成新颜色", async () => {
  const { env, t1 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));
  assert.match(markStyle(env).textContent, /fenbi-mark-1\) \{ background-color: #ffd8a8/);
  env.applySettings(withHighlight({ colors: ["#112233", "#445566", "#778899"] }));
  const css = markStyle(env).textContent;
  assert.match(css, /fenbi-mark-1\) \{ background-color: #112233/);
  assert.match(css, /fenbi-mark-3\) \{ background-color: #778899/);
});

test("「选中后按键标记」：拖选松手不标、click 照常；选中按标记键（默认 H）才标", async () => {
  const { env, t1 } = await practicePage({ settings: KEY_MODE });
  const { click } = env.drag(t1, 0, 5, at(10, 10));
  assert.deepEqual(counts(env), [0, 0, 0]);
  assert.equal(click.defaultPrevented, false);

  const event = press(env, H);
  assert.deepEqual(counts(env), [1, 0, 0]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(env.selection.rangeCount, 0);
});

test("「选中后按键标记」：鼠标停在标记上按 H 换色；重新选中同一段按 H 也换色", async () => {
  const { env, t1 } = await practicePage({ settings: KEY_MODE });
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  env.hover(20, 15);
  press(env, H);
  assert.deepEqual(counts(env), [0, 1, 0]);
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  assert.deepEqual(counts(env), [0, 0, 1]);
});

test("「选中后按键标记」：带 Cmd / Ctrl / Alt 的 H 不处理（Cmd+H 是系统的隐藏窗口）；松手即标记时 H 不拦", async () => {
  const keyMode = await practicePage({ settings: KEY_MODE });
  keyMode.env.select(keyMode.t1, 0, 5, at(10, 10));
  for (const mod of ["metaKey", "ctrlKey", "altKey"]) {
    assert.equal(press(keyMode.env, { ...H, [mod]: true }).defaultPrevented, false, mod);
  }
  assert.deepEqual(counts(keyMode.env), [0, 0, 0]);

  const release = await practicePage();
  release.env.select(release.t1, 0, 5, at(10, 10));
  assert.equal(press(release.env, H).defaultPrevented, false);
});

/* ── 悬停、清本题 ─────────────────────────────────────── */

test("悬停时这一处单独登记到 hover 高亮，移开就撤掉", async () => {
  const { env, t1 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));
  env.hover(20, 15);
  assert.equal(env.markCount("fenbi-mark-hover"), 1);
  env.hover(500, 500);
  assert.equal(env.markCount("fenbi-mark-hover"), 0);
});

test("Shift+Delete / Shift+Backspace：清掉鼠标所在那道题的全部标记，别的题不动", async () => {
  for (const key of [SHIFT_DELETE, SHIFT_BACKSPACE]) {
    const { env, q1, t1, t2 } = await practicePage();
    env.drag(t1, 0, 5, at(10, 10));
    env.drag(t1, 6, 9, at(80, 10));
    env.drag(t2, 0, 5, at(10, 100));

    env.hover(300, 40, q1);
    const event = press(env, key);

    assert.deepEqual(counts(env), [1, 0, 0], key.code);
    assert.equal(event.defaultPrevented, true);
  }
});

test("Shift+Delete：鼠标不在任何一道题上就不动；没有任何标记时不拦", async () => {
  const { env, t1 } = await practicePage();
  assert.equal(press(env, SHIFT_DELETE).defaultPrevented, false);
  env.drag(t1, 0, 5, at(10, 10));
  env.hover(300, 40, env.document.body);
  assert.equal(press(env, SHIFT_DELETE).defaultPrevented, false);
  assert.deepEqual(counts(env), [1, 0, 0]);
});

test("站点改版、页面上找不到题目容器：照样能标，Shift+Delete 清掉本页全部标记", async () => {
  const env = await bootHighlight();
  const block = env.element("div", "renamed-question");
  const text = env.textNode(block);
  env.drag(text, 0, 5, at(10, 10));
  env.drag(text, 6, 9, at(80, 10));
  assert.deepEqual(counts(env), [2, 0, 0]);
  env.hover(300, 40, block);
  assert.equal(press(env, SHIFT_DELETE).defaultPrevented, true);
  assert.deepEqual(counts(env), [0, 0, 0]);
});

test("鼠标移出内容区（到工具栏或窗口外）后：Shift+Delete 不清、不拦，悬停样式撤掉", async () => {
  for (const leave of ["leave", "blur"]) {
    const { env, q1, t1 } = await practicePage();
    env.drag(t1, 0, 5, at(10, 10));
    env.hover(20, 15, q1);
    assert.equal(env.markCount("fenbi-mark-hover"), 1);

    env[leave]();

    assert.equal(env.markCount("fenbi-mark-hover"), 0, `${leave}：悬停样式要撤掉`);
    for (const key of [SHIFT_DELETE, SHIFT_BACKSPACE]) assert.equal(press(env, key).defaultPrevented, false, leave);
    assert.deepEqual(counts(env), [1, 0, 0], leave);
  }
});

test("鼠标在内容区里移动时离开某个元素（relatedTarget 不为空）：悬停照旧", async () => {
  const { env, q1, t1 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));
  env.hover(20, 15, q1);
  env.window.dispatch("mouseout", { relatedTarget: q1 });
  assert.equal(env.markCount("fenbi-mark-hover"), 1);
});

/* ── 换页、站点重绘 ───────────────────────────────────── */

test("站点换页（SPA 改地址）后不按任何键：鼠标一动、页面一滚或前进后退就清掉旧页面的标记", async () => {
  for (const nudge of ["hover", "scroll", "popstate"]) {
    const { env, t1 } = await practicePage();
    env.drag(t1, 0, 5, at(10, 10));
    env.history.pushState(null, "", "/ti/exam/solution/1_3e_2k963k2");
    if (nudge === "hover") env.hover(500, 500);
    else if (nudge === "scroll") env.scroll();
    else env.history.back(), env.history.forward();
    assert.deepEqual(counts(env), [0, 0, 0], `换页后 ${nudge} 就要清掉`);
  }
});

test("站点重绘一道题（换成新节点、文字一样）：标记按题内偏移重新画到新节点上", async () => {
  const { env, q1, t1 } = await practicePage();
  const second = env.element("p", "", q1);
  const later = env.textNode(second);
  env.drag(t1, 2, 4, at(10, 10), later);

  const fresh = env.document.createElement("p");
  const freshText = env.textNode(fresh);
  env.replace(second, fresh);
  const [stale] = env.highlights.get("fenbi-mark-1");
  assert.equal(stale.endContainer, q1, "前提：替身按 Chromium 把边界挪到了父节点，范围没塌");

  env.hover(500, 500);

  const [restored] = env.highlights.get("fenbi-mark-1");
  assert.equal(counts(env)[0], 1);
  assert.equal(restored.startContainer, t1);
  assert.equal(restored.startOffset, 2);
  assert.equal(restored.endContainer, freshText);
  assert.equal(restored.endOffset, 4);
});

test("站点重绘后文字变短、偏移对不上：那一条不画、不报错，存档里留着（不当成删掉）", async () => {
  const { env, q1, t1, t2 } = await practicePage();
  const para = env.element("p", "", q1);
  const tail = env.textNode(para);
  env.drag(tail, 10, 18, at(10, 10));
  env.drag(t2, 0, 5, at(10, 100));

  const shorter = env.document.createElement("p");
  env.textNode(shorter, 5);
  env.replace(para, shorter);
  env.hover(500, 500);

  assert.deepEqual(counts(env), [1, 0, 0]);
  assert.deepEqual(env.store.get(PRACTICE), [[0, 30, 38, 0], [1, 0, 5, 0]], "对不上只是先不画，存档不动");
  env.drag(t2, 6, 9, at(80, 100));
  assert.deepEqual(env.store.get(PRACTICE), [[1, 0, 5, 0], [1, 6, 9, 0], [0, 30, 38, 0]], "之后的写入也把它带上");
  void t1;
});

test("浏览器不支持 CSS.highlights：功能整个不出现，不拦、不加样式、不调命令", async () => {
  const { env, t1 } = await practicePage({ highlights: false });
  const { click } = env.drag(t1, 0, 5, at(10, 10));
  assert.equal(click.defaultPrevented, false);
  assert.equal(markStyle(env), null);
  assert.equal(env.selection.rangeCount, 1, "选区原样留着");
  assert.deepEqual(env.invocations, []);
});

/* ── 按练习落盘 ───────────────────────────────────────── */

test("标记按练习存给 Rust：只存题号、题内偏移、颜色", async () => {
  const { env, q1, t1, t2 } = await practicePage();
  env.drag(t1, 2, 7, at(10, 10));
  press(env, C);
  env.drag(t2, 0, 5, at(10, 100));
  const later = env.textNode(env.element("p", "", q1));
  env.drag(t1, 15, 3, at(80, 10), later);

  assert.deepEqual(env.store.get(PRACTICE), [
    [0, 2, 7, 0],
    [1, 0, 5, 1],
    [0, 15, 23, 1],
  ]);
  assert.ok(writes(env).every((c) => Object.keys(c.args).join() === "generation,marks"), "命令参数只有代次和数字，不带练习 id（Rust 按地址认）");
  assert.ok(env.calls.filter((c) => c.command === "read_practice_marks").every((c) => c.args === undefined), "读也不带参数");
});

test("整段（元素边界）选区：按文字偏移存", async () => {
  const { env, q1 } = await practicePage();
  const para = env.element("p", "", q1);
  env.textNode(para, 6);
  env.textNode(para, 4);
  // 三击整段：起点 (p, 0)，终点 (p, 2)
  env.drag(para, 0, 2, at(10, 10));
  assert.deepEqual(env.store.get(PRACTICE), [[0, 20, 30, 0]], "第 1 题前面已经有 20 个字（practicePage 自带的那段）");
});

test("右键删除、Shift+右键换色都写回；删光了写空列表（Rust 删掉这份练习）", async () => {
  const { env, t1, t2 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));
  env.drag(t2, 0, 5, at(10, 100));
  env.contextMenu(20, 15, { shiftKey: true });
  assert.deepEqual(env.store.get(PRACTICE), [[0, 0, 5, 1], [1, 0, 5, 0]]);
  env.contextMenu(20, 105);
  assert.deepEqual(env.store.get(PRACTICE), [[0, 0, 5, 1]]);
  env.contextMenu(20, 15);
  assert.equal(env.store.has(PRACTICE), false);
  assert.deepEqual(env.calls.at(-1), { command: "write_practice_marks", args: { generation: 1, marks: [] } });
});

test("重启应用回到同一份练习：题目画出来后标记按偏移恢复，颜色不变", async () => {
  const first = await practicePage();
  first.env.drag(first.t1, 2, 7, at(10, 10));
  first.env.contextMenu(20, 15, { shiftKey: true });
  first.env.drag(first.t2, 0, 5, at(10, 100));

  // 重启：同一份存档，新页面一开始还没有题目（站点稍后才画出来）
  const env = await bootHighlight({ store: first.env.store });
  assert.deepEqual(env.calls.map((c) => c.command), ["read_practice_marks"]);
  assert.equal(env.calls[0].args, undefined, "不带练习 id：Rust 从地址认");
  assert.deepEqual(counts(env), [0, 0, 0]);
  const q1 = env.element("app-ti");
  const q2 = env.element("app-ti");
  const t1 = env.textNode(env.element("p", "", q1));
  env.textNode(env.element("p", "", q2));
  env.advance(500);

  assert.deepEqual(counts(env), [1, 1, 0]);
  const [restored] = env.highlights.get("fenbi-mark-2");
  assert.equal(restored.startContainer, t1);
  assert.deepEqual([restored.startOffset, restored.endOffset], [2, 7]);

  // 恢复出来的标记照样能右键删
  env.rectsFor(t1, at(10, 10));
  assert.equal(env.contextMenu(20, 15, { target: t1.parentNode }).defaultPrevented, true);
  assert.deepEqual(env.store.get(PRACTICE), [[1, 0, 5, 0]]);
});

test("不同练习互不影响：换一份练习看不到上一份的标记，回来又有；练习和背题同 id 也分开", async () => {
  const { env, t1 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));

  env.history.pushState(null, "", "/ti/exam/exercise/another");
  env.hover(500, 500);
  await env.tick();
  assert.deepEqual(counts(env), [0, 0, 0]);
  assert.equal(env.calls.at(-1).command, "read_practice_marks", "换了练习就按新地址读");

  env.history.pushState(null, "", "/ti/memorize/1_3e_2k95rs8");
  env.hover(500, 500);
  await env.tick();
  assert.deepEqual(counts(env), [0, 0, 0], "背题和练习同一个 id 也是两份");

  env.history.pushState(null, "", "/ti/exam/exercise/1_3e_2k95rs8");
  env.hover(500, 500);
  await env.tick();
  assert.deepEqual(counts(env), [1, 0, 0], "回到原来的练习，标记还在");
  assert.deepEqual([...env.store.keys()], [PRACTICE]);
});

test("存档读回来之前就标了：和存着的合并后再写，不覆盖存着的", async () => {
  let release;
  const store = new Map([[PRACTICE, [[1, 0, 5, 2]]]]);
  const backend = marksBackend(store);
  const env = await bootHighlight({
    store,
    invoke(command, args, context) {
      if (command === "read_practice_marks") return new Promise((resolve) => (release = () => resolve(backend(command, args, context))));
      return backend(command, args, context);
    },
  });
  const q1 = env.element("app-ti");
  const q2 = env.element("app-ti");
  const t1 = env.textNode(env.element("p", "", q1));
  env.textNode(env.element("p", "", q2));
  env.drag(t1, 0, 3, at(10, 10));
  assert.deepEqual(store.get(PRACTICE), [[1, 0, 5, 2]], "读回来之前不写");

  release();
  await env.tick();

  assert.deepEqual(store.get(PRACTICE), [[0, 0, 3, 0], [1, 0, 5, 2]]);
  assert.deepEqual(counts(env), [1, 0, 1]);
});

test("「记住标记」关着：一条读写命令都不发，换页回来标记就没了", async () => {
  const store = new Map([[PRACTICE, [[0, 0, 5, 0]]]]);
  const { env, t1 } = await practicePage({ store, settings: withHighlight({ remember: false }) });
  env.advance(500);
  assert.deepEqual(counts(env), [0, 0, 0], "不读存着的");
  env.drag(t1, 6, 9, at(80, 10));
  env.contextMenu(90, 15, { shiftKey: true });
  assert.deepEqual(counts(env), [0, 1, 0]);
  env.history.pushState(null, "", "/ti/exam/exercise/another");
  env.hover(500, 500);
  env.history.back();
  env.hover(500, 500);
  assert.deepEqual(counts(env), [0, 0, 0]);
  assert.deepEqual(env.invocations, []);
  assert.deepEqual(store.get(PRACTICE), [[0, 0, 5, 0]], "存档原样");
});

test("「记住标记」中途打开：读回存着的，和页面上已有的合并写入", async () => {
  const store = new Map([[PRACTICE, [[1, 0, 5, 2]]]]);
  const { env, t1 } = await practicePage({ store, settings: withHighlight({ remember: false }) });
  env.drag(t1, 0, 3, at(10, 10));
  env.applySettings(DEFAULT_SETTINGS);
  await env.tick();
  assert.deepEqual(counts(env), [1, 0, 1]);
  assert.deepEqual(store.get(PRACTICE), [[0, 0, 3, 0], [1, 0, 5, 2]]);
});

test("设置页面清除全部标记后：当前页面画着的标记和待恢复的都清掉", async () => {
  const store = new Map([[PRACTICE, [[5, 0, 5, 0]]]]);
  const { env, t1 } = await practicePage({ store });
  env.drag(t1, 0, 5, at(10, 10));
  env.clearAll();
  assert.deepEqual(counts(env), [0, 0, 0]);
  env.advance(1000);
  env.hover(500, 500);
  assert.deepEqual(counts(env), [0, 0, 0]);
  assert.equal(store.size, 0, "清完不再把旧的写回去");
});

test("不联网、不写站点的存储、不读选中的文字，只调按练习读写标记这两条命令", async () => {
  /* 替身的 Range / Selection 被 toString() 时直接抛错，读文字的实现会让这里失败。 */
  const { env, q1, t1, t2 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));
  env.contextMenu(20, 15, { shiftKey: true });
  press(env, C);
  press(env, V);
  press(env, V);
  env.drag(t2, 0, 5, at(10, 100));
  env.contextMenu(20, 105);
  env.hover(300, 40, q1);
  press(env, SHIFT_DELETE);

  assert.deepEqual(env.network, []);
  assert.deepEqual(env.beacons, []);
  assert.deepEqual(env.cookieWrites, []);
  assert.equal(env.localStorage.size, 0);
  assert.equal(env.sessionStorage.size, 0);
  assert.deepEqual(env.logs, []);
  assert.deepEqual([...new Set(env.invocations)].sort(), ["read_practice_marks", "write_practice_marks"]);
});

/* ── 第 1 轮审查退回的守卫（WP-74） ─────────────────────── */

test("题目容器先挂上、文字后填（读盘时题目还在渲染）：期间一次都不写，文字到位后原色原位恢复", async () => {
  const store = new Map([[PRACTICE, [[0, 6, 15, 2]]]]);
  const env = await bootHighlight({ store, finished: false });
  const q1 = env.element("app-ti");
  const p = env.element("p", "", q1);
  env.applySettings(DEFAULT_SETTINGS); // 文档加载完成，开始读盘：这时第一题的容器在、文字还没有
  await env.tick();
  env.advance(3000);
  env.hover(500, 500);
  assert.deepEqual(writes(env), [], "文字没到之前不能判无效、不能写空");
  assert.deepEqual(store.get(PRACTICE), [[0, 6, 15, 2]]);

  const text = env.textNode(p);
  env.advance(500);
  assert.deepEqual(counts(env), [0, 0, 1], "原来的颜色");
  const [restored] = env.highlights.get("fenbi-mark-3");
  assert.equal(restored.startContainer, text);
  assert.deepEqual([restored.startOffset, restored.endOffset], [6, 15], "原来的位置");
  assert.deepEqual(writes(env), []);
  assert.deepEqual(store.get(PRACTICE), [[0, 6, 15, 2]]);
});

test("清除全部时还在路上的读盘结果：迟到了也不画出旧标记；下一次写只含清除之后新标的", async () => {
  const store = new Map([[PRACTICE, [[0, 0, 5, 1]]]]);
  const backend = marksBackend(store);
  let release;
  const env = await bootHighlight({
    store,
    finished: false,
    invoke(command, args, context) {
      // Rust 已经把旧档读出来了，回复还没交到页面
      if (command === "read_practice_marks") {
        const reply = backend(command, args, context);
        return new Promise((resolve) => (release = () => resolve(reply)));
      }
      return backend(command, args, context);
    },
  });
  const t1 = env.textNode(env.element("p", "", env.element("app-ti")));
  env.applySettings(DEFAULT_SETTINGS);
  env.clearAll();
  release();
  await env.tick();
  env.advance(1000);
  assert.deepEqual(counts(env), [0, 0, 0], "迟到的旧读盘结果不能复活旧标记");

  env.drag(t1, 6, 9, at(80, 10));
  assert.deepEqual(store.get(PRACTICE), [[0, 6, 9, 0]], "下一次写只含新标记");
  assert.equal(writes(env).at(-1).args.generation, store.generation, "写入带清除之后的新代次");
});

test("清除全部之前发出、之后才到的写入：按旧代次被拒，界面和磁盘都保持清空；之后的写入照常", async () => {
  const store = new Map();
  const backend = marksBackend(store);
  const held = [];
  const env = await bootHighlight({
    store,
    invoke(command, args, context) {
      if (command === "write_practice_marks") {
        return new Promise((resolve, reject) => held.push(() => backend(command, args, context).then(resolve, reject)));
      }
      return backend(command, args, context);
    },
  });
  const t1 = env.textNode(env.element("p", "", env.element("app-ti")));
  env.drag(t1, 0, 5, at(10, 10));
  env.clearAll();
  held.shift()();
  await env.tick();
  assert.equal(store.size, 0, "旧写入不能把清掉的标记写回磁盘");
  assert.deepEqual(counts(env), [0, 0, 0]);

  env.drag(t1, 6, 9, at(80, 10));
  held.shift()();
  await env.tick();
  assert.deepEqual(store.get(PRACTICE), [[0, 6, 9, 0]]);
});

test("右键点在盖住标记的弹层按钮上（或点中别的题）：不删、不换色背后的标记，菜单照常", async () => {
  const { env, t1, p1, p2 } = await practicePage();
  env.drag(t1, 0, 5, at(10, 10));
  const layer = env.element("div", "buy-member-app buy-member-app-popup");
  const button = env.element("button", "", layer);
  for (const target of [button, layer, p2]) {
    for (const shiftKey of [false, true]) {
      const event = env.contextMenu(20, 15, { target, shiftKey });
      assert.equal(event.defaultPrevented, false, `${target.tagName} shift=${shiftKey}：菜单照常`);
      assert.equal(event.propagationStopped, false);
    }
  }
  assert.deepEqual(counts(env), [1, 0, 0]);
  assert.deepEqual(env.store.get(PRACTICE), [[0, 0, 5, 0]], "落盘的也没动");

  // 弹层就在题目里面（站点在题目里弹的浮层）也一样
  const inner = env.element("div", "", p1);
  inner.setAttribute("role", "dialog");
  assert.equal(env.contextMenu(20, 15, { target: env.element("button", "", inner) }).defaultPrevented, false);
  assert.deepEqual(counts(env), [1, 0, 0]);

  // 真点在这道题的文字上：照常删
  assert.equal(env.contextMenu(20, 15, { target: p1 }).defaultPrevented, true);
  assert.deepEqual(counts(env), [0, 0, 0]);
});

test("焦点在站点弹层里（对话框、弹窗）：V / C / 标记键 / Shift+Delete 都不拦，按键照常交给弹层", async () => {
  const { env, q1, t1 } = await practicePage({ settings: KEY_MODE });
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  env.hover(20, 15, q1);
  const dialog = env.element("div");
  dialog.setAttribute("aria-modal", "true");
  for (const layer of [env.element("div", "login-web-modal"), env.element("fb-qrcode-login-modal"), env.element("dialog"), dialog]) {
    const button = env.element("button", "", layer);
    env.focus(button);
    for (const key of [V, C, H, SHIFT_DELETE]) {
      assert.equal(press(env, { ...key, target: button }).defaultPrevented, false, `${layer.tagName}.${layer.className} ${key.code}`);
    }
  }
  assert.deepEqual(counts(env), [1, 0, 0], "没被隐藏、没被清");
  env.focus(env.document.body);
  assert.equal(press(env, { ...V, target: env.document.body }).defaultPrevented, true, "焦点回到页面后照常");
});

test("站点按钮用 mousedown.preventDefault 保住了旧选区：单击它不把旧选区标上，按钮的 click 照常", async () => {
  const { env, t1 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10)); // 不是这次拖出来的选区（比如键盘选的）
  env.mouseDown();
  env.mouseUp();
  const click = env.click();
  assert.deepEqual(counts(env), [0, 0, 0]);
  assert.equal(click.defaultPrevented, false, "按钮的 click 不能吞");
  assert.equal(env.selection.rangeCount, 1, "旧选区原样留着");

  // 这次拖出来的照常标、照常吞掉这一次 click
  const dragged = env.drag(t1, 6, 9, at(80, 10));
  assert.deepEqual(counts(env), [1, 0, 0]);
  assert.equal(dragged.click.defaultPrevented, true);
});

test("写入被 Rust 拒（超限 / 磁盘写不进去）：页面上的标记留着、不往页面里加提示；下一次改动整份重试，落盘一致", async () => {
  for (const reason of ["标记没保存上：这份练习的标记太多了（最多 500 处）", "标记没保存上：写入本机文件失败"]) {
    const store = new Map([[PRACTICE, [[1, 0, 5, 2]]]]);
    const backend = marksBackend(store);
    let failing = true;
    const env = await bootHighlight({
      store,
      invoke(command, args, context) {
        if (command === "write_practice_marks" && failing) return Promise.reject(reason);
        return backend(command, args, context);
      },
    });
    const q1 = env.element("app-ti");
    const q2 = env.element("app-ti");
    const t1 = env.textNode(env.element("p", "", q1));
    env.textNode(env.element("p", "", q2));
    env.advance(500);
    const before = env.document.body.children.length;
    env.drag(t1, 0, 3, at(10, 10));
    await env.tick();
    assert.deepEqual(counts(env), [1, 0, 1], "没存上也不撤掉页面上的标记");
    assert.deepEqual(store.get(PRACTICE), [[1, 0, 5, 2]], "旧档完好");
    assert.equal(env.document.body.children.length, before, "提示由 Rust 交给工具栏，页面里不加东西");

    failing = false;
    env.drag(t1, 5, 9, at(80, 10));
    await env.tick();
    assert.deepEqual(store.get(PRACTICE), [[1, 0, 5, 2], [0, 0, 3, 0], [0, 5, 9, 0]], "重试时把上次没存上的一起写");
  }
});

test("静置时站点 pushState 换到有存档的练习：不动鼠标、不按键也会读档恢复", async () => {
  const store = new Map([["exercise:another", [[0, 2, 7, 1]]]]);
  const { env, t1 } = await practicePage({ store });
  env.drag(t1, 10, 12, at(10, 10));
  env.history.pushState(null, "", "/ti/exam/exercise/another");
  env.advance(500);
  await env.tick();
  env.advance(500);
  assert.deepEqual(counts(env), [0, 1, 0], "旧练习的清掉，新练习的恢复");
  const [restored] = env.highlights.get("fenbi-mark-2");
  assert.equal(restored.startContainer, t1);
  assert.deepEqual([restored.startOffset, restored.endOffset], [2, 7]);

  env.history.pushState(null, "", "/ti/exam/exercise/1_3e_2k95rs8");
  env.advance(500);
  await env.tick();
  env.advance(500);
  assert.deepEqual(counts(env), [1, 0, 0], "回到原来的练习，也不用动鼠标");
});

test("保存设置后立即整页重载：收到 Rust 推来的最新设置之前不处理输入、不读写标记，之后按新设置", async () => {
  // 新文档的 initialization_script 里还是启动时那份（松手即标），Rust 那边已经存成「选中后按键标记」
  const env = await bootHighlight({ finished: false });
  const t1 = env.textNode(env.element("p", "", env.element("app-ti")));
  const { click } = env.drag(t1, 0, 5, at(10, 10));
  assert.deepEqual(counts(env), [0, 0, 0], "还没拿到最新设置：不按旧设置标");
  assert.equal(click.defaultPrevented, false);
  assert.equal(press(env, V).defaultPrevented, false);
  env.advance(2000);
  assert.deepEqual(env.invocations, [], "也不读写标记");

  env.applySettings(KEY_MODE); // 文档加载完成，Rust 推来当前设置
  await env.tick();
  env.drag(t1, 0, 5, at(10, 10));
  assert.deepEqual(counts(env), [0, 0, 0], "按新设置：松手不标");
  assert.equal(press(env, H).defaultPrevented, true);
  assert.deepEqual(counts(env), [1, 0, 0]);
});

test("做题页地址规则和 Rust（marks.rs 的 practice_of）是同一条：practice-urls.json 里每个地址，页面认不认做题页都一致", async () => {
  const cases = JSON.parse(readFileSync(path.join(REPO_ROOT, "tests/fixtures/practice-urls.json"), "utf8"));
  for (const [url, expected] of cases) {
    const parsed = new URL(url);
    assert.equal(practiceOfLocation(parsed), expected, `IPC 替身 ${url}`);
    // 页面侧只在 spa.fenbi.com 上跑、只看路径；协议和端口由 Rust 再查
    if (parsed.protocol !== "https:" || parsed.port || parsed.hostname !== "spa.fenbi.com") continue;
    const { env, t1 } = await practicePage({ url });
    env.drag(t1, 0, 5, at(10, 10));
    assert.equal(counts(env)[0] === 1, expected !== null, url);
  }
});

test("highlight.js 和 page-settings.js 的每个挂接点都在：注入、热加载拷贝、语法检查", () => {
  const read = (file) => readFileSync(path.join(REPO_ROOT, file), "utf8");
  for (const name of ["highlight.js", "page-settings.js"]) {
    const escaped = name.replace(".", "\\.");
    assert.match(read("src-tauri/src/lib.rs"), new RegExp(`load_script\\("${escaped}", include_str!\\("\\.\\./${escaped}"\\)\\)`), `lib.rs 要把 ${name} 拼进 initialization_script`);
    assert.match(read("src-tauri/build.rs"), new RegExp(`"${escaped}"`), `build.rs 的热加载拷贝清单要带上 ${name}`);
    assert.match(read("package.json"), new RegExp(`node --check src-tauri/${escaped}`), `package.json 的 check:js 要检查 ${name} 的语法`);
  }
  // 划词脚本等「文档加载完成后 Rust 推一次设置」才开始干活：这一推不能丢
  assert.match(read("src-tauri/src/lib.rs"), /PageLoadEvent::Finished \{[\s\S]{0,200}settings::apply_script/, "lib.rs 的 on_page_load 要在 Finished 时推当前设置");
});
