/* JS 行为测试的替身环境：最小 DOM + 可控时钟 + 可观察的导航。
 *
 * 为什么不用 jsdom：注入脚本和本地工具栏只用到有限的 DOM 接口，测试还需
 * 精确控制时钟和导航历史。jsdom 不执行真实的 location 导航，故在这里按需实现。
 *
 * ⚠️ 这是替身，不是浏览器。通过它只证明**包装层自己的调度逻辑**；
 * 真实 WebView 里的登录行为必须另外人工验证（见 CONTRIBUTING.md）。
 *
 * 通过 FENBI_INIT_JS=<path> 可以让测试跑另一份 init.js —— 用来验证"修复前的
 * 代码确实让这些用例变红"。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_INIT_JS = path.join(REPO_ROOT, "src-tauri/init.js");

export const TARGET_URL = "https://www.fenbi.com/spa/tiku/guide/catalog";
export const CATALOG_PATH = "/spa/tiku/guide/catalog";
export const PRACTICE_URL = "https://spa.fenbi.com/ti/exam/exercise/1234567";

/** init.js 的原始文本，占位符已替换成可在 Node 里执行的字面量。 */
export function initSource() {
  const file = process.env.FENBI_INIT_JS ?? DEFAULT_INIT_JS;
  return (
    readFileSync(path.join(REPO_ROOT, "src-tauri/toolbar/shortcuts.js"), "utf8") + "\n" + readFileSync(file, "utf8")
      // 现在 init.js 里占位符不带引号（由 serde_json 生成字面量）；
      // 旧版本写成 "__TARGET_URL__"，两种都兼容，方便拿旧版本验证测试有效性。
      .replace('"__TARGET_URL__"', JSON.stringify(TARGET_URL))
      .replace("__TARGET_URL__", JSON.stringify(TARGET_URL))
      .replace("__DEBUG__", "true")
  );
}

/* ------------------------------------------------------------------ *
 * 可控时钟
 * ------------------------------------------------------------------ */

class Clock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  schedule(fn, ms, every) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + (ms || 0), fn, every });
    return id;
  }

  setTimeout(fn, ms) {
    return this.schedule(fn, ms, null);
  }

  setInterval(fn, ms) {
    return this.schedule(fn, ms || 1, ms || 1);
  }

  clear(id) {
    this.timers.delete(id);
  }

  /** 把所有到期的定时器按时间顺序跑完，最多推进 `ms` 毫秒。 */
  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      let next = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (next === null || timer.at < next.timer.at)) {
          next = { id, timer };
        }
      }
      if (!next) break;
      this.now = next.timer.at;
      if (next.timer.every) {
        next.timer.at = this.now + next.timer.every;
      } else {
        this.timers.delete(next.id);
      }
      next.timer.fn();
    }
    this.now = end;
  }

}

/* ------------------------------------------------------------------ *
 * 最小 DOM
 * ------------------------------------------------------------------ */

class Element {
  constructor(tag, className = "", attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.className = className;
    this.id = attrs.id ?? "";
    this.visible = attrs.visible !== false;
    this.children = [];
    this.ownText = "";
    this.attributes = {};
    this.clicks = 0;
    this.onClick = null;
    this.listeners = {};
    this.style = {};
    this.shadowRoot = null;
  }

  /* 按真实 DOM 语义：读是聚合所有后代文本，写是清空子节点换成文本。 */
  get textContent() {
    if (this.children.length) {
      return this.children.map((child) => child.textContent).join("");
    }
    return this.ownText;
  }

  set textContent(value) {
    this.ownText = String(value);
    this.children.length = 0;
  }

  get offsetWidth() {
    return this.visible ? 10 : 0;
  }

  get offsetHeight() {
    return this.visible ? 10 : 0;
  }

  getClientRects() {
    return this.visible ? [{}] : [];
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  attachShadow() {
    this.shadowRoot = new Element("shadow-root");
    return this.shadowRoot;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    const at = reference ? this.children.indexOf(reference) : -1;
    if (at < 0) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }

  removeChild(child) {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    return child;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ target: this, ...event });
  }

  click() {
    this.clicks++;
    if (this.onClick) this.onClick(this);
    this.dispatch("click");
  }
}

/** 从 fixture HTML 里抽出元素。只认标签名、class、id、data-invisible。 */
function parseHtml(html) {
  const elements = [];
  const tagPattern = /<([a-zA-Z][\w-]*)([^<>]*)>/g;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const [, tag, rawAttrs] = match;
    // 跳过闭合标签与自闭合的单例标签
    if (rawAttrs.trimEnd().endsWith("/")) continue;
    const classMatch = rawAttrs.match(/class\s*=\s*"([^"]*)"/);
    const idMatch = rawAttrs.match(/id\s*=\s*"([^"]*)"/);
    elements.push(
      new Element(tag, classMatch ? classMatch[1].trim() : "", {
        id: idMatch ? idMatch[1] : "",
        visible: !/data-invisible/.test(rawAttrs),
      })
    );
  }
  return elements;
}

function parseSimpleSelector(part) {
  const trimmed = part.trim();
  const id = trimmed.match(/#([\w-]+)/);
  const classes = [...trimmed.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const tag = trimmed.match(/^([a-zA-Z][\w-]*)/);
  return { tag: tag ? tag[1].toUpperCase() : null, classes, id: id ? id[1] : null };
}

function matches(element, selectorList) {
  return selectorList.split(",").some((part) => {
    const { tag, classes, id } = parseSimpleSelector(part);
    if (tag && element.tagName !== tag) return false;
    if (id && element.id !== id) return false;
    const own = element.className.split(/\s+/).filter(Boolean);
    return classes.every((cls) => own.includes(cls));
  });
}

/* ------------------------------------------------------------------ *
 * 环境
 * ------------------------------------------------------------------ */

/**
 * 建一个跑着真实 init.js 的替身环境。
 *
 * @param {object} options
 * @param {string} options.url             页面地址（决定 hostname / pathname）
 * @param {string} options.html            模拟页面（见 tests/fixtures/）
 * @param {[number,string]|Error} options.decision
 *                                         Rust 侧当前快照：
 *                                         [序号, "pending" | "logged-in" | "logged-out"]；
 *                                         传 Error 模拟 current_login_decision 调用失败
 * @param {number|function} options.invokeDelay
 *                                         current_login_decision 的回复延迟（毫秒）。
 *                                         函数按调用序号（1 起）返回延迟，用来构造乱序返回
 * @param {function} options.invoke        完全自定义的 invoke 替身（覆盖上面的默认实现）
 * @param {boolean} options.domReady       默认 true；false 时先停在 loading，
 *                                         等 env.domReady() 再触发 DOMContentLoaded
 */
export function createEnv(options = {}) {
  const clock = new Clock();
  const navigations = [];
  const reloads = [];
  const beacons = [];
  const invocations = [];
  const logs = [];
  const localStore = new Map();

  const parsed = new URL(options.url ?? TARGET_URL);

  /* 会话历史用一个真的栈来模拟。assign 新增条目；replace 替换当前条目、
   * **不**截断 forward 栈（Chromium 实测：A→B→back→replace(C)→forward 到 B）。 */
  const stack = [parsed.href];
  let cursor = 0;

  function setLocation(href) {
    const next = new URL(href);
    location.hostname = next.hostname;
    location.pathname = next.pathname;
    location.search = next.search;
    location.href = next.href;
  }

  const location = {
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search,
    href: parsed.href,
    assign(to) {
      navigations.push(to);
      stack.splice(cursor + 1);
      stack.push(new URL(to, location.href).href);
      cursor = stack.length - 1;
      setLocation(stack[cursor]);
    },
    replace(to) {
      navigations.push(to);
      stack[cursor] = new URL(to, parsed.origin).href;
      setLocation(stack[cursor]);
    },
    reload() {
      reloads.push(location.pathname);
    },
  };

  const document = {
    readyState: options.domReady === false ? "loading" : "complete",
    listeners: {},
    createElement(tag) {
      return new Element(tag);
    },
    createElementNS(_namespace, tag) {
      return new Element(tag);
    },
    addEventListener(type, fn) {
      (document.listeners[type] ??= []).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of document.listeners[type] ?? []) fn({ target: document, ...event });
    },
    querySelectorAll(selector) {
      return descendants().filter((el) => matches(el, selector));
    },
    querySelector(selector) {
      return document.querySelectorAll(selector)[0] ?? null;
    },
  };
  const head = new Element("head");
  const body = new Element("body");
  const documentElement = new Element("html");
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  document.documentElement = documentElement;
  document.head = head;
  document.body = body;

  /** 深度优先遍历整棵假 DOM（含 shadow root）。 */
  function descendants(root = documentElement) {
    const out = [];
    const visit = (el) => {
      for (const child of el.children ?? []) {
        out.push(child);
        visit(child);
      }
      if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  }

  const window = {
    listeners: {},
    addEventListener(type, fn) {
      (window.listeners[type] ??= []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of window.listeners[type] ?? []) fn(event);
    },
  };

  class FakeImage {
    set src(value) {
      beacons.push(value);
    }
  }

  const history = {
    get length() {
      return stack.length;
    },
    pushState(_state, _title, to) {
      stack.splice(cursor + 1);
      stack.push(new URL(to, `${parsed.origin}${location.pathname}`).href);
      cursor = stack.length - 1;
      setLocation(stack[cursor]);
    },
    replaceState(_state, _title, to) {
      stack[cursor] = new URL(to, `${parsed.origin}${location.pathname}`).href;
      setLocation(stack[cursor]);
    },
    back() {
      if (cursor === 0) return;
      cursor--;
      setLocation(stack[cursor]);
    },
    forward() {
      if (cursor === stack.length - 1) return;
      cursor++;
      setLocation(stack[cursor]);
    },
  };

  /* 假 DOM：fixture 元素就是 body 的子节点，注入脚本插进来的节点也在同一棵树里。 */
  for (const el of parseHtml(options.html ?? "")) body.appendChild(el);

  /* Rust 侧当前快照：(序号, 结论)。env.pushDecision 会更新它。 */
  let snapshot = options.decision ?? [0, "pending"];

  /* 回复延迟（毫秒）。数字对所有重读生效；函数按调用序号（1 起）返回延迟，
   * 用来构造「旧结论晚归、新结论先到」的乱序场景。 */
  const delayFor = (callIndex) =>
    typeof options.invokeDelay === "function"
      ? options.invokeDelay(callIndex)
      : options.invokeDelay ?? 0;

  const calls = [];
  const invokeImpl =
    options.invoke ??
    ((command) => {
      if (command === "current_login_decision") {
        if (snapshot instanceof Error) return Promise.reject(snapshot);
        const result = snapshot.slice();
        const ms = delayFor(invocations.length);
        if (!ms) return Promise.resolve(result);
        return new Promise((resolve) => clock.setTimeout(() => resolve(result), ms));
      }
      return Promise.resolve(null);
    });

  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      invocations.push(command);
      calls.push({ command, args });
      return invokeImpl(command, args);
    },
  };

  for (const [key, value] of Object.entries(options.storage ?? {})) {
    localStore.set(key, String(value));
  }

  const localStorage = {
    getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
    setItem: (key, value) => localStore.set(key, String(value)),
    removeItem: (key) => localStore.delete(key),
  };

  /* 平台只影响按钮上的键位提示文案（⌘[ vs Alt+←）。 */
  const navigator = { platform: options.platform ?? "MacIntel", userAgent: "harness" };

  const sandbox = {
    window,
    document,
    location,
    history,
    localStorage,
    navigator,
    Image: FakeImage,
    console: { log: (...args) => logs.push(args.join(" ")), error: (...args) => logs.push(args.join(" ")) },
    Date: { now: () => clock.now },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearTimeout: (id) => clock.clear(id),
    clearInterval: (id) => clock.clear(id),
  };

  const names = Object.keys(sandbox);
  // 用 new Function 把 init.js 的源码直接跑起来：测的是真实实现，不是副本。
  const source = options.toolbar
    ? readFileSync(path.join(REPO_ROOT, "src-tauri/toolbar/shortcuts.js"), "utf8") + "\n" + readFileSync(path.join(REPO_ROOT, "src-tauri/toolbar/toolbar.js"), "utf8")
    : initSource();
  new Function(...names, source)(...Object.values(sandbox));

  const env = {
    clock,
    location,
    window,
    document,
    navigations,
    reloads,
    beacons,
    invocations,
    calls,
    refreshToolbar: () => window.__fenbiRefreshToolbar(),
    logs,
    history,
    localStorage: localStore,

    /** 让 Promise 回调跑完。 */
    async tick() {
      await new Promise((resolve) => setImmediate(resolve));
    },

    /** 推进虚拟时间，沿途跑掉到期的定时器。 */
    advance(ms) {
      clock.advance(ms);
    },

    /** 模拟文档从 loading 走到 DOMContentLoaded（配合 domReady: false）。 */
    domReady() {
      document.readyState = "complete";
      document.dispatch("DOMContentLoaded");
    },

    /**
     * 模拟 Rust 更新快照后 wake：更新 harness 里的当前快照，再调用
     * window.__fenbiRefreshLoginDecision()——生产里 Rust 的 eval 就是这一句，
     * **不带结论**。页面重读快照后按 seq 去重。
     */
    pushDecision(seq, kind) {
      snapshot = [seq, kind];
      env.wake();
    },

    /**
     * 只发一次裸 wake（不更新快照）：模拟旧文档留下的 eval 落到新文档。
     */
    wake() {
      if (typeof window.__fenbiRefreshLoginDecision !== "function") {
        throw new Error("init.js 还没有 __fenbiRefreshLoginDecision 入口");
      }
      window.__fenbiRefreshLoginDecision();
    },

    /** 让站点"渲染出"登录按钮（模拟按钮延迟出现）。 */
    showLoginButton() {
      const button = new Element("button", "header-content-logon-btn");
      button.textContent = "登录";
      body.appendChild(button);
      return button;
    },

    /** 让站点"渲染出"登录框。 */
    showLoginModal() {
      const modal = new Element("div", "login-web-modal");
      body.appendChild(modal);
      return modal;
    },

    /** 站点用 display 控制登录框显隐；这是"用户把登录框关掉"的替身。 */
    hideLoginModal(modal) {
      modal.visible = false;
      return modal;
    },

    /** 把所有登录入口按钮都找出来。 */
    loginButtons() {
      return document.querySelectorAll(".header-content-logon-btn, .header-content-login-btn");
    },

    /** 横栏根节点（注入脚本放在 body 首位）。 */
    toolbar() {
      return body.children.find((el) => el.getAttribute("data-fenbi-toolbar") !== null) ?? null;
    },

    /** 横栏状态：collapsed / expanded，没注入就是 null。 */
    toolbarState() {
      const host = env.toolbar();
      return host ? host.getAttribute("data-fenbi-toolbar") : null;
    },

    /** 横栏最外层那根条（展开/收起都靠它断言结构）。 */
    toolbarBar() {
      return document.querySelectorAll(".fenbi-toolbar")[0] ?? null;
    },

    /** 展开/收起开关：两种状态下必须是**同一个控件**。 */
    toolbarToggle() {
      return document.querySelectorAll(".fenbi-toolbar-toggle")[0] ?? null;
    },

    /** 横栏展开后的四个动作按钮（按 data-fenbi-action 找）。 */
    toolbarButton(action) {
      return document
        .querySelectorAll(".fenbi-toolbar-btn")
        .find((el) => el.getAttribute("data-fenbi-action") === action) ?? null;
    },

    /** 从按钮的无障碍名称读取快捷键；可见提示在悬停/聚焦时显示在栏内。 */
    hintText(button) {
      return button?.getAttribute("aria-label")?.match(/\(([^)]+)\)$/)?.[1] ?? null;
    },

    /** 仅 debug 构建暴露的内部观察口（见 init.js 末尾）。 */
    get internals() {
      return window.__fenbiWrapperInternals ?? null;
    },
  };

  return env;
}
