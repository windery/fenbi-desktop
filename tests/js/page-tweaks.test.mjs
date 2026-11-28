/* 页面裁剪、诊断信息和网站 DOM 边界：检查真实 init.js 注入内容。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, CATALOG_URL } from "../support/boot.mjs";

/* ── UI 裁剪：与刷题无关的入口 ──────────────────────────────── */

/* 注入脚本裁剪页面靠的是**一份 CSS 文本**（不改 DOM），而 harness 里没有 CSS 引擎，
   所以这里断言的是「这份 CSS 说了什么」，不是浏览器算出来的效果。
   真实页面上的效果靠人工核对（见 CONTRIBUTING.md「UI 裁剪」）。 */
function tweakCss(env) {
  const style = [...env.document.head.children, ...env.document.body.children].find(
    (el) => el.getAttribute("data-fenbi-wrapper") === "tweaks"
  );
  assert.ok(style, "必须注入裁剪样式");
  return style.textContent;
}

/** 某个选择器是否落在指定规则的声明块里（`{ ... }` 之间的第一段）。 */
function ruleFor(css, selector) {
  const at = css.indexOf(selector);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return open < 0 || close < 0 ? null : css.slice(open + 1, close);
}

test("会员入口 / 我的课程 / 帮助问号：整块隐藏", async () => {
  const css = tweakCss(await boot({}));
  for (const selector of [
    ".member-area",
    "#userlogout a.popover-content",
    "i.paper-tag-help",
  ]) {
    const body = ruleFor(css, selector);
    assert.ok(body, `裁剪 CSS 里必须有 ${selector}`);
    assert.match(body, /display:\s*none/, `${selector} 必须整块隐藏`);
  }
});

/* 解析页：站点正在显示开通入口的那一块，整块隐藏。
   会员账号下站点不渲染开通入口（旧组件是给它加 hidden 属性），选择器就不命中。 */
const UPSELL_SELECTORS = [
  "section.result-common-section:has(app-solution-video .member-container)",
  "li.video-item:has(.question-video-member:not([hidden]))",
  ".member-solution-accessory:has(.nav-btn:not([hidden]))",
];

test("解析页：显示着开通入口的视频块 / 申论会员内容块整块隐藏", async () => {
  const css = tweakCss(await boot({}));
  for (const selector of UPSELL_SELECTORS) {
    const body = ruleFor(css, selector);
    assert.ok(body, `裁剪 CSS 里必须有 ${selector}`);
    assert.match(body, /display:\s*none/, `${selector} 必须整块隐藏`);
  }
});

/** 拆出每条样式规则的选择器列表；@media 包着的规则也拆出来，记下它在哪个 @media 里。 */
function styleRules(css) {
  const rules = [];
  let media = null;
  let depth = 0;
  let head = "";
  for (const ch of css) {
    if (ch === "{") {
      const prelude = head.trim();
      head = "";
      if (prelude.startsWith("@media")) media = prelude;
      else rules.push({ selectors: prelude, media: depth > 0 ? media : null });
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) media = null;
      head = "";
    } else {
      head += ch;
    }
  }
  return rules;
}

test("带 :has() 的规则里，每个选择器都带 :has()，不拖累其他裁剪", async () => {
  const css = tweakCss(await boot({}));

  /* 不认 :has() 的旧 WebView 会把含它的**整条规则**作废。所以 :has() 不能和别的
     选择器写进同一条规则：一条规则里要么每个选择器都带 :has()，要么都不带。
     加新的 :has() 规则就单独写一条（见 CONTRIBUTING.md「UI 裁剪」末尾的警告）。 */
  const withHas = styleRules(css).filter((rule) => rule.selectors.includes(":has("));
  assert.ok(withHas.length >= 1);
  for (const rule of withHas) {
    for (const selector of rule.selectors.split(/,(?![^(]*\))/)) {
      assert.match(selector, /:has\(/, `「${selector.trim()}」和 :has() 选择器写在了同一条规则里，拆成单独一条`);
    }
  }
  for (const selector of [".member-area", "nav.fb-web-nav", "a.fenbi-icon-url"]) {
    assert.ok(
      withHas.every((rule) => !rule.selectors.includes(selector)),
      `${selector} 不能和 :has() 写在同一条规则里`
    );
  }
});

/* 解析页左右分栏：窗口够宽、题目容器里三块都在才分栏；任何一块对不上，规则不命中，退回上下排。 */
const SPLIT_CONTAINER =
  ".solution-choice-container:has(> app-question-choice):has(> app-solution-overall):has(> app-result-common)";

test("解析页左右分栏：只在 1400px 以上生效，三块都在才分栏", async () => {
  const css = tweakCss(await boot({}));
  const split = styleRules(css).filter((rule) => rule.selectors.includes(SPLIT_CONTAINER));

  assert.ok(split.length, `裁剪 CSS 里必须有 ${SPLIT_CONTAINER}`);
  for (const rule of split) {
    assert.match(rule.media ?? "", /^@media \(min-width: 1400px\)$/, `${rule.selectors} 必须包在 1400px 断点里`);
  }
  const container = ruleFor(css, `${SPLIT_CONTAINER} {`);
  assert.match(container, /display:\s*grid/);
  assert.match(container, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/, "两栏等宽，且都能缩到 0 宽，不把卡片撑出去");

  const place = (child) => ruleFor(css, `${SPLIT_CONTAINER} > ${child} {`);
  assert.match(place("app-question-choice"), /grid-column:\s*1/, "题目选项在左栏");
  assert.match(place("app-solution-overall"), /grid-column:\s*1/, "答案统计条在左栏");
  assert.match(place("app-result-common"), /grid-column:\s*2/, "解析视频、文字解析、考点、来源、笔记在右栏");
  assert.match(place("app-result-common"), /grid-row:\s*1 \/ span 2/, "右栏从题目顶部一直排到统计条下面");
});

test("解析页左右分栏不用 Angular 作用域哈希做选择器", async () => {
  const css = tweakCss(await boot({}));
  for (const rule of styleRules(css)) {
    assert.doesNotMatch(rule.selectors, /ng-tns-|_ngcontent-|ng-star-inserted/, `${rule.selectors} 带了站点构建时会变的哈希`);
  }
});

test("粉笔 logo：保留可见，只去掉点击", async () => {
  const css = tweakCss(await boot({}));
  const body = ruleFor(css, "a.fenbi-icon-url");

  assert.ok(body, "裁剪 CSS 里必须有 a.fenbi-icon-url");
  assert.match(body, /pointer-events:\s*none/, "logo 不该再能点");
  assert.doesNotMatch(body, /display:\s*none/, "整块拿掉会让顶栏左端空一截");
  assert.doesNotMatch(body, /visibility:\s*hidden/, "logo 要留着看得见");
});

test("别误伤：登录按钮 / 用户头像 / 当前考试 / 搜题框 / 粉笔魔方都要留着", async () => {
  const css = tweakCss(await boot({}));

  /* 这几条是「不能出现在任何一条隐藏规则里」的白名单，逐条按字面查。
     用户菜单只藏了 `#userlogout a.popover-content` 这一条，账号行与
     「退出登录」都是 div.popover-content，不在这条选择器的作用范围内。
     粉笔魔方是实用功能，明确不裁剪。 */
  for (const selector of [
    ".header-content-logon",
    ".header-user-info",
    ".current-exam",
    ".question-search-area",
    "a.cube-module-button",
  ]) {
    assert.ok(
      !css.includes(selector),
      `裁剪 CSS 不该碰 ${selector}：登录 / 切考试 / 搜题 / 粉笔魔方都是做题要用的`
    );
  }
});

/* ── 诊断信息脱敏 ───────────────────────────────────────────── */

test("诊断日志不带完整 URL 的 query", async () => {
  const env = await boot({ url: `${CATALOG_URL}?labelId=4147&token=secret` });
  const emitted = [...env.logs, ...env.beacons].join("\n");
  assert.ok(!emitted.includes("token=secret"), `诊断输出里出现了 query：\n${emitted}`);
  assert.ok(!emitted.includes("labelId=4147"), `诊断输出里出现了 query：\n${emitted}`);
});


test("网站页面不再注入工具栏 DOM", async () => {
  const env = await boot({});
  assert.equal(env.toolbar(), null);
});
