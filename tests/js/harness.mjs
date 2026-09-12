/* JS 行为测试的替身环境：最小 DOM + 可控时钟 + 可观察的导航。
 *
 * 为什么不用 jsdom：init.js 只用到极少数 DOM 接口（几个选择器、一次 click、
 * 一次 appendChild），而测试真正要控制的是**时钟**和**导航**——这两样在 jsdom 里
 * 都不可控（location 是 non-configurable，导航会变成 "Not implemented" 错误）。
 * 与其和 jsdom 的语义较劲，不如按需实现这几个接口。
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
    readFileSync(file, "utf8")
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
 * @param {string} options.url            页面地址（决定 hostname / pathname）
 * @param {string} options.html           模拟页面（见 tests/fixtures/）
 * @param {boolean|Error} options.record  is_known_logged_in 的返回值
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

  /* 会话历史用一个真的栈来模拟，`replace` 按实测的浏览器语义实现：
   * 替换当前条目、**不**截断 forward 栈（Chromium 实测：A→B→back→replace(C)→forward 到 B）。 */
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
    readyState: "complete",
    listeners: {},
    createElement(tag) {
      return new Element(tag);
    },
    addEventListener(type, fn) {
      (document.listeners[type] ??= []).push(fn);
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

  const invokeImpl =
    options.invoke ??
    (() =>
      options.record instanceof Error
        ? Promise.reject(options.record)
        : Promise.resolve(Boolean(options.record)));

  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      invocations.push(command);
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
    console: { log: (...args) => logs.push(args.join(" ")) },
    Date: { now: () => clock.now },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearTimeout: (id) => clock.clear(id),
    clearInterval: (id) => clock.clear(id),
  };

  const names = Object.keys(sandbox);
  // 用 new Function 把 init.js 的源码直接跑起来：测的是真实实现，不是副本。
  new Function(...names, initSource())(...Object.values(sandbox));

  const env = {
    clock,
    location,
    window,
    document,
    navigations,
    reloads,
    beacons,
    invocations,
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

    /** 收起态那个小箭头。 */
    toolbarHandle() {
      return document.querySelectorAll(".fenbi-toolbar-handle")[0] ?? null;
    },

    /** 横栏展开后的四个动作按钮（按 data-fenbi-action 找）。 */
    toolbarButton(action) {
      return document
        .querySelectorAll(".fenbi-toolbar-btn")
        .find((el) => el.getAttribute("data-fenbi-action") === action) ?? null;
    },

    /** 仅 debug 构建暴露的内部观察口（见 init.js 末尾）。 */
    get internals() {
      return window.__fenbiWrapperInternals ?? null;
    },
  };

  return env;
}
