/* 登录提示时序：运行真实 init.js，断言弹窗、导航、计时器等可观察结果。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnv } from "../support/browser-env.mjs";
import { boot, CATALOG_URL, fixture, LONG_ENOUGH_MS, PRACTICE_URL } from "../support/boot.mjs";

/* 时间参数优先问生产代码要（debug 构建下 init.js 会暴露 internals）；
 * 拿旧版本跑验证时用一个偏大的值兜底。测试里不抄精确数值。 */
const retryTickMs = (env) => (env.internals ? env.internals.timings.loginBtnRetryMs : 300);
const retryBudget = (env) => (env.internals ? env.internals.timings.loginBtnRetries : 24);
/** 只有 debug 构建会挂 internals；旧版本没有，用于验证测试有效性时会缺。 */
const detail = (env) => env.internals;

/* ── 启动时序：判定权在 Rust，页面不按缓存/时间自己弹 ────────── */

test("没有决策就不自己弹：按钮已在页面上，时间流逝也不产生弹框", async () => {
  const env = await boot(); // 快照 pending：Rust 还没有有效观察
  env.advance(800);
  assert.equal(env.loginButtons()[0].clicks, 0, "800ms 不是结论");
  env.advance(700); // 累计 1500ms，正好是旧的观察窗口
  assert.equal(env.loginButtons()[0].clicks, 0, "1500ms 也不是结论");
  env.advance(LONG_ENOUGH_MS);
  assert.equal(env.loginButtons()[0].clicks, 0, "没有决策就一直不弹");
});

test("按钮晚渲染：没有决策就不会点到按钮", async () => {
  const env = await boot({ html: fixture("catalog-not-yet-rendered.html") });
  env.advance(900);
  const button = env.showLoginButton();
  env.advance(LONG_ENOUGH_MS);
  assert.equal(button.clicks, 0, "页面不据缓存/时间下结论");
});

/* ── 执行 Rust 决策：Absent 弹、Present 取消、Pending 不动 ───── */

test("首次 pending → Absent：重读到登出后提示一次", async () => {
  const env = await boot({ decision: [0, "pending"] });
  const button = env.loginButtons()[0];
  assert.equal(button.clicks, 0, "前置条件：pending 不动");

  env.pushDecision(1, "logged-out");
  await env.tick();
  assert.equal(button.clicks, 1, "快照变成 Absent，必须提示一次");
});

test("决策是登出：按钮一出现就弹，且只弹一次", async () => {
  const env = await boot({
    html: fixture("catalog-not-yet-rendered.html"),
    decision: [1, "logged-out"],
  });
  assert.equal(env.loginButtons().length, 0, "前置条件：此刻按钮还不存在，弹框必须排队");

  const button = env.showLoginButton();
  env.advance(retryTickMs(env));

  assert.equal(button.clicks, 1, "有效观察判定登出后，按钮一出现就该弹");
  if (detail(env)) {
    assert.equal(detail(env).promptTimerActive(), false, "弹完必须停掉重试");
  }
});

test("决策是已登录：一次都不弹", async () => {
  const env = await boot({ decision: [1, "logged-in"] });
  env.advance(LONG_ENOUGH_MS);
  assert.equal(env.loginButtons()[0].clicks, 0, "观测到凭证就不该弹");
});

test("决策是 pending：不弹、也不起排队定时器", async () => {
  const env = await boot({ decision: [1, "pending"] });
  env.advance(LONG_ENOUGH_MS);
  assert.equal(env.loginButtons()[0].clicks, 0);
  if (detail(env)) {
    assert.equal(detail(env).promptTimerActive(), false, "未知不该起排队定时器");
  }
});

test("读决策失败：保持未知，不据错误弹框", async () => {
  const env = await boot({ decision: new Error("ipc 调用失败") });
  env.advance(LONG_ENOUGH_MS);
  assert.equal(env.loginButtons()[0].clicks, 0, "读不出来 ≠ 登出");
});

/* ── 登录框本身的状态判断 ────────────────────────────────────── */

test("登录框已经可见：不重复点", async () => {
  const env = await boot({ html: fixture("login-modal-open.html"), decision: [1, "logged-out"] });
  env.advance(LONG_ENOUGH_MS);
  assert.equal(env.loginButtons()[0].clicks, 0);
});

test("登录框常驻 DOM 但不可见：仍然要点出来", async () => {
  const env = await boot({ html: fixture("login-modal-hidden.html"), decision: [1, "logged-out"] });
  env.advance(retryTickMs(env));
  assert.equal(env.loginButtons()[0].clicks, 1);
});

/* ── ready / wake / 序号去重 ─────────────────────────────────── *
 *
 * Rust 的 wake 不带结论，页面只能重读当前快照；重读又是异步的，可能乱序返回。
 * 处理办法只有一条：按 seq 去重，只接受严格更新的结论。
 * wake 落在文档就绪前时先不读也不点，等就绪后那一次重读——它至少和 wake 一样新。
 * 旧文档留下的 wake 落到新文档，读到的只是新快照（通常是 pending）。
 */

test("wake 不携带结论：旧 wake 落到新文档只读到当前 pending", async () => {
  const env = await boot({ decision: [8, "pending"] });
  const button = env.loginButtons()[0];
  assert.equal(button.clicks, 0, "前置条件：新页面 pending");
  assert.equal(
    typeof env.window.__fenbiLoginDecision,
    "undefined",
    "生产不再有携带结论的入口"
  );

  env.wake(); // 旧文档留下的裸 wake
  await env.tick();
  assert.equal(button.clicks, 0, "wake 只能读到 pending，带不回旧结论");
  assert.ok(env.invocations.includes("current_login_decision"), "wake 要重读快照");
});

test("就绪前到达的 wake 先记着，就绪后重读补上", async () => {
  const env = createEnv({
    url: CATALOG_URL,
    html: fixture("catalog-page.html"),
    domReady: false,
    decision: [1, "logged-out"],
  });
  await env.tick();

  env.wake(); // 文档还没就绪
  await env.tick();
  assert.equal(env.loginButtons()[0].clicks, 0, "DOM 没就绪不能点");
  assert.equal(env.invocations.length, 0, "就绪前不读快照");

  env.domReady();
  await env.tick();
  assert.equal(env.loginButtons()[0].clicks, 1, "就绪后重读当前快照并执行");
});

test("决策在脚本就绪前已产生：就绪后重读仍要提示", async () => {
  const env = createEnv({
    url: CATALOG_URL,
    html: fixture("catalog-page.html"),
    domReady: false,
    decision: [7, "logged-out"],
  });
  await env.tick();
  assert.equal(env.loginButtons()[0].clicks, 0, "还没就绪");

  env.domReady();
  await env.tick();
  assert.equal(env.loginButtons()[0].clicks, 1, "重读拿到就绪前就产生的登出结论");
});

test("乱序 invoke 回复不能覆盖新结论", async () => {
  /* 第一次重读（旧结论 logged-in）晚归，第二次重读（新结论 logged-out）先到。
     旧结果按 seq 丢弃，不能让已经提示过的这一轮被"已登录"取消。 */
  const env = createEnv({
    url: CATALOG_URL,
    html: fixture("catalog-page.html"),
    decision: [1, "logged-in"],
    invokeDelay: (callIndex) => (callIndex === 1 ? 100 : 0),
  });

  env.pushDecision(2, "logged-out"); // 新结论先到
  await env.tick();
  const button = env.loginButtons()[0];
  assert.equal(button.clicks, 1, "新结论先到，先提示一次");

  env.advance(100); // 旧结论晚归
  await env.tick();

  env.pushDecision(3, "logged-out"); // 同一轮里再来一次 Absent
  await env.tick();
  assert.equal(button.clicks, 1, "旧 logged-in 若覆盖就会让这条开新一轮，从而多点一次");
});

test("旧序号的决策不应用到当前页面", async () => {
  const env = await boot({ decision: [5, "logged-in"] }); // 重读：当前页已登录 seq=5
  const button = env.loginButtons()[0];

  env.pushDecision(4, "logged-out"); // 旧页面留下的 Absent
  await env.tick();
  env.pushDecision(5, "logged-out"); // 同一序号，不能当新结论
  await env.tick();
  assert.equal(button.clicks, 0, "序号不前进就不许弹");

  env.pushDecision(6, "logged-out");
  await env.tick();
  assert.equal(button.clicks, 1, "新序号才应用");
});

test("同一序号重复推送只点一次", async () => {
  const env = await boot({ decision: [0, "pending"] });
  env.pushDecision(1, "logged-out");
  env.pushDecision(1, "logged-out");
  await env.tick();
  env.advance(LONG_ENOUGH_MS);
  assert.equal(env.loginButtons()[0].clicks, 1);
});

/* ── 登录状态转换：跟着 Rust 的每次决策走 ───────────────────────
 *
 * 决策的每次变化都必须能推动状态：观测到凭证 -> 不再提示；从已登录再次
 * 观测不到凭证 -> 新一轮提示重新开始。旧实现只有一个永不复位的标记，于是
 * 登录过一次之后会话再失效就永远不提示。
 *
 * 反方向也要挡住：点了登录按钮之后、观测到凭证之前，都属于同一轮登录尝试。
 * 这期间站点可能连报多次登出，用户也可能把登录框关掉，包装层一律不再点；
 * 弹窗关闭不能证明登录已经完成，"过了多久"同样不是证据。
 */

test("凭证出现→消失→恢复→再次消失：每一轮登出都提示一次", async () => {
  const env = await boot({ decision: [1, "pending"] }); // 还没有结论：启动阶段什么都不做
  const button = env.loginButtons()[0];
  assert.equal(button.clicks, 0, "前置条件：启动阶段不该弹登录框");

  env.pushDecision(2, "logged-in"); // 观测到凭证
  await env.tick();
  env.pushDecision(3, "logged-out"); // 凭证消失
  await env.tick();
  assert.equal(button.clicks, 1, "登录过之后会话失效，必须重新提示");

  env.pushDecision(4, "logged-in"); // 凭证恢复
  await env.tick();
  env.pushDecision(5, "logged-out"); // 再次消失
  await env.tick();
  assert.equal(button.clicks, 2, "第二轮失效同样要提示，不能停在第一轮");

  env.advance(LONG_ENOUGH_MS);
  assert.equal(button.clicks, 2, "两轮各一次，不许补点");
  assert.deepEqual(env.navigations, [], "登录提示不带任何自动导航");
  assert.deepEqual(env.reloads, [], "登录提示也不刷新页面");
});

test("按钮已在、登录框还没渲染出来：连续两次登出决策只点一次", async () => {
  /* 站点渲染登录框是异步的：点下去到登录框可见之间有一段空白。
     空白期内连来两次登出决策，是同一次登录尝试，不是两轮。 */
  const env = await boot({ decision: [1, "logged-out"] });
  const button = env.loginButtons()[0];
  assert.equal(button.clicks, 1, "前置条件：第一条决策点出登录框");

  env.pushDecision(2, "logged-out");
  await env.tick();
  assert.equal(button.clicks, 1, "同一轮里的第二次登出只能点一次");
  env.advance(LONG_ENOUGH_MS);
  assert.equal(button.clicks, 1, "过一会儿也不许补点");
});

test("排队重试与新的登出决策交错：只点一次", async () => {
  const env = await boot({
    html: fixture("catalog-not-yet-rendered.html"),
    decision: [1, "logged-out"],
  });

  const button = env.showLoginButton(); // 按钮出现，登录框还没渲染出来
  env.pushDecision(2, "logged-out"); // 新的即时决策插进来
  await env.tick();

  assert.equal(button.clicks, 1, "决策接手后点一次");
  env.advance(LONG_ENOUGH_MS);
  assert.equal(button.clicks, 1, "原来那个排队重试不许再点第二次");
});

test("排队重试期间重复登出决策：不重置重试预算", async () => {
  const env = await boot({
    html: fixture("catalog-not-yet-rendered.html"),
    decision: [1, "logged-out"],
  });
  const tick = retryTickMs(env);
  const retries = retryBudget(env);

  // 预算内不断插入重复决策；每条都不该把 tries 清零、让重试无限续命
  for (let i = 0; i < retries + 4; i++) {
    env.pushDecision(i + 2, "logged-out");
    await env.tick();
    env.advance(tick);
  }

  const button = env.showLoginButton();
  env.advance(LONG_ENOUGH_MS);
  assert.equal(button.clicks, 0, "预算用尽后，重复决策不能重开一轮再点");
});

test("排队等按钮时观测到凭证：排队作废，之后再次失效仍能提示", async () => {
  const env = await boot({
    html: fixture("catalog-not-yet-rendered.html"),
    decision: [1, "logged-out"],
  });

  env.pushDecision(2, "logged-in"); // 凭证来了 -> 排队作废
  await env.tick();

  const button = env.showLoginButton();
  env.advance(LONG_ENOUGH_MS);
  assert.equal(button.clicks, 0, "凭证已经在，排队中的提示不能再点");
  if (detail(env)) {
    assert.equal(detail(env).promptTimerActive(), false, "凭证决策必须停掉排队");
  }

  env.pushDecision(3, "logged-out"); // 凭证又没了
  await env.tick();
  assert.equal(button.clicks, 1, "按钮已经在，这一轮登出要立刻提示一次");
});

test("pending 取消按钮等待，但不重置已 requested 的闩锁", async () => {
  // waiting：pending 必须停掉还没执行的重试
  const waiting = await boot({
    html: fixture("catalog-not-yet-rendered.html"),
    decision: [1, "logged-out"],
  });
  waiting.pushDecision(2, "pending");
  await waiting.tick();
  if (detail(waiting)) {
    assert.equal(detail(waiting).promptTimerActive(), false, "pending 必须停掉排队重试");
  }

  const button = waiting.showLoginButton();
  waiting.advance(LONG_ENOUGH_MS);
  assert.equal(button.clicks, 0, "等待已被 pending 取消，不能再点");

  waiting.pushDecision(3, "logged-out");
  await waiting.tick();
  assert.equal(button.clicks, 1, "之后新的 Absent 要能重新提示");

  // requested：pending 不许把它清回 idle，同一轮的 Absent 仍要合并
  const requested = await boot({ decision: [1, "logged-out"] });
  const requestedButton = requested.loginButtons()[0];
  assert.equal(requestedButton.clicks, 1, "前置条件：先点一次");
  requested.pushDecision(2, "pending");
  await requested.tick();
  requested.pushDecision(3, "logged-out");
  await requested.tick();
  assert.equal(requestedButton.clicks, 1, "pending + Absent 仍在同一轮，不许第二次点击");
});

test("用户关掉登录框不算登录完成：必须先 Present 再 Absent 才是新一轮", async () => {
  const env = await boot({
    html: fixture("login-modal-hidden.html"),
    decision: [1, "logged-out"],
  });
  const button = env.loginButtons()[0];
  assert.equal(button.clicks, 1, "常驻 DOM 但不可见的登录框：要点出来");

  const modal = env.showLoginModal(); // 站点把登录框显示出来
  env.pushDecision(2, "logged-out");
  await env.tick();
  assert.equal(button.clicks, 1, "登录框开着就是登录进行中，不许再点");

  env.advance(LONG_ENOUGH_MS); // 用户看了一会儿
  env.hideLoginModal(modal); // 用户把登录框关掉
  env.advance(LONG_ENOUGH_MS); // 又过了一段

  env.pushDecision(3, "logged-out");
  await env.tick();
  assert.equal(button.clicks, 1, "关掉登录框不证明登录完成，不许据关闭自动重开");

  env.pushDecision(4, "logged-in"); // 站点真的给到凭证
  await env.tick();
  env.pushDecision(5, "logged-out"); // 之后凭证再次失效
  await env.tick();
  assert.equal(button.clicks, 2, "先 Present 再 Absent 才算新一轮");
});

test("长时间没有弹窗：再收到登出决策不靠时间推断上一轮已结束", async () => {
  const env = await boot({
    html: fixture("login-modal-hidden.html"),
    decision: [1, "logged-out"],
  });
  const button = env.loginButtons()[0];
  assert.equal(button.clicks, 1, "前置条件：先点出登录框");

  env.advance(LONG_ENOUGH_MS); // 60 秒里既没有 Present，也没有可见登录框
  assert.equal(button.clicks, 1, "没有 Present 就不能认定上一轮结束");

  env.pushDecision(2, "logged-out");
  await env.tick();
  assert.equal(button.clicks, 1, "同一轮里的 Absent 持续合并，不许第二次点击");
});

test("点击登录按钮同步触发登出决策：不重入点第二次", async () => {
  const env = await boot({ html: fixture("login-modal-hidden.html"), decision: [1, "pending"] });
  const button = env.loginButtons()[0];

  let clicksAtSync = null;
  button.onClick = () => {
    // 站点在 click 的同步回调里再报一条新序号的登出
    env.pushDecision(3, "logged-out");
    clicksAtSync = button.clicks;
  };

  env.pushDecision(2, "logged-out"); // 点出登录框；click 回调里又推了一条
  await env.tick();

  assert.equal(button.clicks, 1, "click 同步回调里的登出决策属于同一轮");
  assert.equal(clicksAtSync, 1);
  env.advance(LONG_ENOUGH_MS);
  assert.equal(button.clicks, 1, "过一会儿也不许补点");
});
/* ── 练习区：不再特殊对待，登录提示一视同仁 ───────────────────── */

test("直接落在 /ti/ 页面、还没有结论：不弹、也不跳转", async () => {
  const env = await boot({ url: PRACTICE_URL, html: fixture("practice-page.html") });
  env.advance(LONG_ENOUGH_MS);

  assert.equal(env.loginButtons()[0].clicks, 0, "没有有效观察之前不许弹");
  assert.deepEqual(env.navigations, []);
  assert.deepEqual(env.reloads, []);
});

test("在 /ti/ 页面判定登出：立刻弹框，不排队", async () => {
  const env = await boot({
    url: PRACTICE_URL,
    html: fixture("practice-page.html"),
    decision: [1, "logged-out"],
  });
  const button = env.loginButtons()[0];

  assert.equal(button.clicks, 1, "练习页不再推迟登录提示");

  env.advance(LONG_ENOUGH_MS);
  assert.equal(button.clicks, 1, "只弹一次");
});

test("在 /ti/ 页面也不跳转、不刷新", async () => {
  const env = await boot({
    url: PRACTICE_URL,
    html: fixture("practice-page.html"),
    decision: [1, "logged-in"],
  });

  env.advance(LONG_ENOUGH_MS);
  assert.deepEqual(env.navigations, []);
  assert.deepEqual(env.reloads, []);
});
