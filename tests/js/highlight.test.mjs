/* 做题页划词标记：执行真实的 highlight.js，断言高亮登记表、按键拦没拦、有没有联网或写存储。
   harness 没有渲染，看不到底色；颜色真不真、悬停下划线显不显示，按 CONTRIBUTING.md 在真实做题页核对。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootHighlight, press } from "../support/boot.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MARKS = ["fenbi-mark-1", "fenbi-mark-2", "fenbi-mark-3"];

const H = { code: "KeyH", key: "h" };
const DELETE = { code: "Delete", key: "Delete" };
const BACKSPACE = { code: "Backspace", key: "Backspace" };
const SHIFT_DELETE = { code: "Delete", key: "Delete", shiftKey: true };
const SHIFT_BACKSPACE = { code: "Backspace", key: "Backspace", shiftKey: true };

/** 两道题、每道题一段文字；返回各自的题目容器和文字节点。 */
async function practicePage(overrides) {
  const env = await bootHighlight(overrides);
  const q1 = env.element("app-ti", "question-multiple");
  const q2 = env.element("app-ti", "question-multiple");
  return { env, q1, q2, t1: env.textNode(env.element("p", "", q1)), t2: env.textNode(env.element("p", "", q2)) };
}

const at = (left, top) => [{ left, top, right: left + 50, bottom: top + 20 }];

function counts(env) {
  return MARKS.map((name) => env.markCount(name));
}

function markStyle(env) {
  return env.document.head.children.find((el) => el.getAttribute("data-fenbi-wrapper") === "highlight") ?? null;
}

test("选中文字按 H：标成第 1 种颜色，拦下这次按键，取消选区让底色露出来", async () => {
  const { env, t1 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));

  const event = press(env, H);

  assert.deepEqual(counts(env), [1, 0, 0]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(env.selection.rangeCount, 0, "不取消选区，蓝色选中态会盖住底色");
  const style = markStyle(env);
  assert.ok(style, "要往页面加一条 ::highlight() 样式");
  for (const name of [...MARKS, "fenbi-mark-hover"]) assert.match(style.textContent, new RegExp(`::highlight\\(${name}\\)`));
});

test("鼠标停在一处标记上按 H：3 种颜色循环", async () => {
  const { env, t1 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  env.hover(20, 15);

  press(env, H);
  assert.deepEqual(counts(env), [0, 1, 0]);
  press(env, H);
  assert.deepEqual(counts(env), [0, 0, 1]);
  const event = press(env, H);
  assert.deepEqual(counts(env), [1, 0, 0]);
  assert.equal(event.defaultPrevented, true);
});

test("重新选中已标的同一段再按 H：换颜色，不重复登记", async () => {
  const { env, t1 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  assert.deepEqual(counts(env), [0, 1, 0]);
});

test("悬停时这一处单独登记到 hover 高亮，移开就撤掉", async () => {
  const { env, t1 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);

  env.hover(20, 15);
  assert.equal(env.markCount("fenbi-mark-hover"), 1);
  env.hover(500, 500);
  assert.equal(env.markCount("fenbi-mark-hover"), 0);
});

test("焦点在输入框 / 文本框 / 可编辑区域里：按 H 不标、不拦", async () => {
  for (const make of [
    (env) => Object.assign(env.element("input"), { type: "text" }),
    (env) => env.element("textarea", "solution-note-editor"),
    (env) => Object.assign(env.element("div"), { isContentEditable: true }),
  ]) {
    const { env, t1 } = await practicePage();
    const field = make(env);
    env.focus(field);
    env.select(t1, 0, 5, at(10, 10));

    const event = press(env, { ...H, target: field });

    assert.deepEqual(counts(env), [0, 0, 0], `${field.tagName} 里打字不能被吞`);
    assert.equal(event.defaultPrevented, false);
  }
});

test("焦点停在选项的单选框上（选完答案）：照样能标", async () => {
  const { env, t1 } = await practicePage();
  const radio = Object.assign(env.element("input", "option-radio"), { type: "radio" });
  env.focus(radio);
  env.select(t1, 0, 5, at(10, 10));

  const event = press(env, { ...H, target: radio });

  assert.deepEqual(counts(env), [1, 0, 0]);
  assert.equal(event.defaultPrevented, true);
});

test("不是做题页：选中文字按 H 不标、不加样式、不拦", async () => {
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
    env.select(t1, 0, 5, at(10, 10));
    const event = press(env, H);
    assert.deepEqual(counts(env), [0, 0, 0], url);
    assert.equal(markStyle(env), null, url);
    assert.equal(event.defaultPrevented, false, url);
    assert.equal(env.selection.rangeCount, 1, `${url}：选区原样留着`);
  }
});

test("做题页地址允许结尾的 / 和查询串", async () => {
  for (const url of [
    "https://spa.fenbi.com/ti/exam/exercise/1_3e_2k95rs8/",
    "https://spa.fenbi.com/ti/exam/exercise/1_3e_2k95rs8/?routecs=syzc",
    "https://spa.fenbi.com/ti/memorize/1_3e_2k96k2k?x=1",
  ]) {
    const { env, t1 } = await practicePage({ url });
    env.select(t1, 0, 5, at(10, 10));
    press(env, H);
    assert.deepEqual(counts(env), [1, 0, 0], url);
  }
});

test("背题页也是做题页", async () => {
  const { env, t1 } = await practicePage({ url: "https://spa.fenbi.com/ti/memorize/1_3e_2k96k2k" });
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  assert.deepEqual(counts(env), [1, 0, 0]);
});

test("没选区、鼠标也不在标记上：H / Delete 都不拦", async () => {
  const { env } = await practicePage();
  assert.equal(press(env, H).defaultPrevented, false);
  assert.equal(press(env, DELETE).defaultPrevented, false);
  assert.equal(press(env, SHIFT_DELETE).defaultPrevented, false);
});

test("带 Cmd / Ctrl / Alt 的 H 不处理（Cmd+H 是系统的隐藏窗口）", async () => {
  const { env, t1 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));
  for (const mod of ["metaKey", "ctrlKey", "altKey"]) {
    assert.equal(press(env, { ...H, [mod]: true }).defaultPrevented, false, mod);
  }
  assert.deepEqual(counts(env), [0, 0, 0]);
});

test("从一道题拖选到另一道题按 H：不标、不拦、选区原样留着", async () => {
  const { env, t1, t2 } = await practicePage();
  env.selectAcross(t1, 2, t2, 5, [...at(10, 10), ...at(10, 100)]);

  const event = press(env, H);

  assert.deepEqual(counts(env), [0, 0, 0]);
  assert.equal(event.defaultPrevented, false);
  assert.equal(env.selection.rangeCount, 1);
});

test("跨题选区被拒后两题分开标：清哪道题只清那道题自己的", async () => {
  for (const [clear, left] of [
    ["q1", "t2"],
    ["q2", "t1"],
  ]) {
    const page = await practicePage();
    const { env } = page;
    env.selectAcross(page.t1, 2, page.t2, 5, [...at(10, 10), ...at(10, 100)]);
    press(env, H);
    env.select(page.t1, 0, 5, at(10, 10));
    press(env, H);
    env.select(page.t2, 0, 5, at(10, 100));
    press(env, H);

    env.hover(300, 40, page[clear]);
    assert.equal(press(env, SHIFT_DELETE).defaultPrevented, true);

    assert.deepEqual(counts(env), [1, 0, 0], `清 ${clear} 后只剩 ${left} 的那处`);
    const [remaining] = env.highlights.get("fenbi-mark-1");
    assert.equal(remaining.startContainer, page[left]);
    assert.equal(remaining.endContainer, page[left]);
  }
});

test("同一道题里跨几段文字拖选：照样能标", async () => {
  const { env, q1, t1 } = await practicePage();
  const later = env.textNode(env.element("p", "", q1));
  env.selectAcross(t1, 2, later, 4, at(10, 10));
  assert.equal(press(env, H).defaultPrevented, true);
  assert.deepEqual(counts(env), [1, 0, 0]);
});

test("鼠标移出内容区（到工具栏或窗口外）后：删除键不删、不拦，悬停样式撤掉", async () => {
  for (const leave of ["leave", "blur"]) {
    for (const withQuestions of [true, false]) {
      const env = await bootHighlight();
      const block = withQuestions ? env.element("app-ti", "question-multiple") : env.element("div", "renamed-question");
      const text = env.textNode(env.element("p", "", block));
      env.select(text, 0, 5, at(10, 10));
      press(env, H);
      env.hover(20, 15, block);
      assert.equal(env.markCount("fenbi-mark-hover"), 1);

      env[leave]();

      const label = `${leave}${withQuestions ? "" : "（页面上没有题目容器）"}`;
      assert.equal(env.markCount("fenbi-mark-hover"), 0, `${label}：悬停样式要撤掉`);
      for (const key of [DELETE, BACKSPACE, SHIFT_DELETE, SHIFT_BACKSPACE, H]) {
        assert.equal(press(env, key).defaultPrevented, false, `${label} 后 ${key.shiftKey ? "Shift+" : ""}${key.code}`);
      }
      assert.deepEqual(counts(env), [1, 0, 0], label);
    }
  }
});

test("鼠标在内容区里移动时离开某个元素（relatedTarget 不为空）：悬停照旧", async () => {
  const { env, q1, t1 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  env.hover(20, 15, q1);
  env.window.dispatch("mouseout", { relatedTarget: q1 });
  assert.equal(env.markCount("fenbi-mark-hover"), 1);
  assert.equal(press(env, DELETE).defaultPrevented, true);
  assert.deepEqual(counts(env), [0, 0, 0]);
});

test("鼠标停在一处标记上按 Delete 或 Backspace：只删这一处", async () => {
  for (const key of [DELETE, BACKSPACE]) {
    const { env, t1, t2 } = await practicePage();
    env.select(t1, 0, 5, at(10, 10));
    press(env, H);
    env.select(t2, 0, 5, at(10, 100));
    press(env, H);

    env.hover(20, 105);
    const event = press(env, key);

    assert.deepEqual(counts(env), [1, 0, 0], key.code);
    assert.equal(event.defaultPrevented, true);
    assert.equal(env.markCount("fenbi-mark-hover"), 0, "删掉的那处不能还挂着悬停样式");
  }
});

test("鼠标不在标记上按 Delete / Backspace：不删、不拦", async () => {
  const { env, t1 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  env.hover(500, 500);
  assert.equal(press(env, BACKSPACE).defaultPrevented, false);
  assert.deepEqual(counts(env), [1, 0, 0]);
});

test("Shift+Delete / Shift+Backspace：清掉鼠标所在那道题的全部标记，别的题不动", async () => {
  for (const key of [SHIFT_DELETE, SHIFT_BACKSPACE]) {
    const { env, q1, t1, t2 } = await practicePage();
    env.select(t1, 0, 5, at(10, 10));
    press(env, H);
    env.select(t1, 6, 9, at(80, 10));
    press(env, H);
    env.select(t2, 0, 5, at(10, 100));
    press(env, H);

    env.hover(300, 40, q1);
    const event = press(env, key);

    assert.deepEqual(counts(env), [1, 0, 0], key.code);
    assert.equal(event.defaultPrevented, true);
  }
});

test("Shift+Delete：鼠标不在任何一道题上就不动", async () => {
  const { env, t1 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  env.hover(300, 40, env.document.body);
  assert.equal(press(env, SHIFT_DELETE).defaultPrevented, false);
  assert.deepEqual(counts(env), [1, 0, 0]);
});

test("站点改版、页面上找不到题目容器：Shift+Delete 清掉本页全部标记", async () => {
  const env = await bootHighlight();
  const block = env.element("div", "renamed-question");
  const text = env.textNode(block);
  env.select(text, 0, 5, at(10, 10));
  press(env, H);
  env.select(text, 6, 9, at(80, 10));
  press(env, H);
  env.hover(300, 40, block);

  const event = press(env, SHIFT_DELETE);

  assert.deepEqual(counts(env), [0, 0, 0]);
  assert.equal(event.defaultPrevented, true);
});

test("站点换页（SPA 改地址）：旧页面的标记全部清掉", async () => {
  const { env, t1 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);

  env.history.pushState(null, "", "/ti/exam/exercise/another");
  press(env, H);

  assert.deepEqual(counts(env), [0, 0, 0]);
});

test("站点换页后不按任何热键：鼠标一动或页面一滚就清掉，再返回也看不到旧标记", async () => {
  for (const nudge of ["hover", "scroll"]) {
    const { env, t1 } = await practicePage();
    env.select(t1, 0, 5, at(10, 10));
    press(env, H);

    env.history.pushState(null, "", "/ti/exam/solution/1_3e_2k963k2");
    if (nudge === "hover") env.hover(500, 500);
    else env.scroll();
    assert.deepEqual(counts(env), [0, 0, 0], `换页后 ${nudge} 就要清掉`);

    env.history.back();
    assert.deepEqual(counts(env), [0, 0, 0], `${nudge} 后返回`);
  }
});

test("用浏览器后退离开做题页（popstate）：鼠标键盘都不动也清掉", async () => {
  const { env, t1 } = await practicePage();
  env.history.pushState(null, "", "/ti/exam/exercise/1_3e_another");
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);

  env.history.back();

  assert.deepEqual(counts(env), [0, 0, 0]);
});

test("站点把题目节点换掉：失效的范围在下一次按键时清掉，不越攒越多", async () => {
  const { env, q1, t1, t2 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  env.select(t2, 0, 5, at(10, 100));
  press(env, H);

  env.remove(q1);
  press(env, DELETE);

  assert.deepEqual(counts(env), [1, 0, 0]);
});

test("站点只换掉跨段标记的一端：活 Range 边界被挪到父节点也认得出失效，鼠标一动就清", async () => {
  /* Chromium 摘节点时把落在里面的边界移到 (父节点, 原位置)，范围不塌、两端也都还在文档里，
     只看「塌没塌、在不在文档里」认不出来，会留下一块盖错地方的底色。 */
  const { env, q1, t1 } = await practicePage();
  const second = env.element("p", "", q1);
  const later = env.textNode(second);
  env.selectAcross(t1, 2, later, 4, at(10, 10));
  press(env, H);

  const fresh = env.document.createElement("p");
  env.textNode(fresh);
  env.replace(second, fresh);
  const [stale] = env.highlights.get("fenbi-mark-1");
  assert.equal(stale.endContainer, q1, "前提：替身按 Chromium 把边界挪到了父节点");
  assert.equal(stale.collapsed, false);

  env.hover(500, 500);

  assert.deepEqual(counts(env), [0, 0, 0]);
});

test("浏览器不支持 CSS.highlights：功能整个不出现，不拦键、不加样式、不报错", async () => {
  const { env, t1 } = await practicePage({ highlights: false });
  env.select(t1, 0, 5, at(10, 10));
  const event = press(env, H);
  assert.equal(event.defaultPrevented, false);
  assert.equal(markStyle(env), null);
  assert.equal(env.selection.rangeCount, 1, "选区原样留着");
});

test("不联网、不写存储、不读选中的文字", async () => {
  /* 替身的 Range / Selection 被 toString() 时直接抛错，读文字的实现会让这里失败。 */
  const { env, q1, t1, t2 } = await practicePage();
  env.select(t1, 0, 5, at(10, 10));
  press(env, H);
  env.hover(20, 15);
  press(env, H);
  env.select(t2, 0, 5, at(10, 100));
  press(env, H);
  env.hover(20, 105);
  press(env, DELETE);
  env.hover(300, 40, q1);
  press(env, SHIFT_DELETE);

  assert.deepEqual(env.network, []);
  assert.deepEqual(env.beacons, []);
  assert.deepEqual(env.cookieWrites, []);
  assert.equal(env.localStorage.size, 0);
  assert.equal(env.sessionStorage.size, 0);
  assert.deepEqual(env.logs, []);
  assert.deepEqual(env.invocations, [], "划词脚本不许调用 Tauri IPC");
});

test("highlight.js 的每个挂接点都在：注入、热加载拷贝、语法检查", () => {
  const read = (file) => readFileSync(path.join(REPO_ROOT, file), "utf8");
  assert.match(read("src-tauri/src/lib.rs"), /load_script\("highlight\.js", include_str!\("\.\.\/highlight\.js"\)\)/, "lib.rs 要把 highlight.js 拼进 initialization_script");
  assert.match(read("src-tauri/build.rs"), /"highlight\.js"/, "build.rs 的热加载拷贝清单要带上 highlight.js");
  assert.match(read("package.json"), /node --check src-tauri\/highlight\.js/, "package.json 的 check:js 要检查 highlight.js 的语法");
});
