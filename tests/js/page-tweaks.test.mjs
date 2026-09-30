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
