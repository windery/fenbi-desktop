import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_PATH, createEnv, DEFAULT_SETTINGS } from "./browser-env.mjs";

export { CATALOG_PATH, DEFAULT_SETTINGS, PRACTICE_URL, TARGET_URL } from "./browser-env.mjs";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
export const CATALOG_URL = `https://www.fenbi.com${CATALOG_PATH}`;
/** 宽到足以跑完任何重试预算的时间。 */
export const LONG_ENOUGH_MS = 60_000;

export const fixture = (name) => readFileSync(path.join(FIXTURES, name), "utf8");

/** 默认：页面刚加载，Rust 还没有给出任何有效观察结论。 */
export async function boot(overrides = {}) {
  const env = createEnv({
    url: CATALOG_URL,
    html: fixture("catalog-page.html"),
    decision: [0, "pending"],
    ...overrides,
  });
  await env.tick();
  return env;
}

/** 独立本地工具栏 WebView：执行真实工具栏脚本，IPC 用可观察替身。 */
export async function bootToolbar(options = {}) {
  return boot({ toolbar: true, invoke: () => Promise.resolve([0, false]), ...options });
}

export function press(env, partial) {
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

/** 和 marks.rs 的 practice_of 同一条规则（tests/fixtures/practice-urls.json 锁住三份一致）。 */
export function practiceOfLocation(location) {
  if (location.hostname !== "spa.fenbi.com" || (location.protocol && location.protocol !== "https:") || location.port) return null;
  const match = /^\/ti\/(exam\/exercise|memorize)\/([A-Za-z0-9_-]{1,64})\/?$/.exec(location.pathname);
  return match ? `${match[1] === "memorize" ? "memorize" : "exercise"}:${match[2]}` : null;
}

/**
 * Rust 那份按练习存的标记（marks.rs）的替身：练习从调用方当前地址认定，读回 [代次, 标记]，写要带对代次。
 * `store` 是 Map（练习 → 标记），代次记在 store.generation；同一个 store 传给下一次 bootHighlight 就是「重启应用」。
 */
export function marksBackend(store) {
  store.generation ??= 1;
  return function invoke(command, args, { location }) {
    const practice = practiceOfLocation(location);
    if (command === "read_practice_marks") {
      if (!practice) return Promise.reject("当前页面不是做题页");
      return Promise.resolve([store.generation, structuredClone(store.get(practice) ?? [])]);
    }
    if (command === "write_practice_marks") {
      if (!practice) return Promise.reject("当前页面不是做题页");
      if (args.generation !== store.generation) return Promise.reject("stale");
      if (args.marks.length) store.set(practice, structuredClone(args.marks));
      else store.delete(practice);
    }
    return Promise.resolve(null);
  };
}

/**
 * 跑划词标记脚本（highlight.js）的环境；默认在做题页。
 * 生产里每个文档加载完成时 Rust 都会推一次当前设置（lib.rs 的 on_page_load），划词脚本收到之后才开始干活；
 * 这里默认也推一次（`finished: false` 模拟还没加载完、`current` 是 Rust 那边此刻的设置，默认就是启动时那份）。
 */
export async function bootHighlight(overrides = {}) {
  const store = overrides.store ?? new Map();
  const { finished = true, current, ...rest } = overrides;
  const env = await boot({
    url: PRACTICE_URL_FOR_HIGHLIGHT,
    html: "",
    highlight: true,
    invoke: marksBackend(store),
    ...rest,
  });
  if (finished) {
    env.applySettings(current ?? overrides.settings ?? DEFAULT_SETTINGS);
    await env.tick();
  }
  return Object.assign(env, {
    store,
    /** 设置页面点「清除全部标记」：Rust 删文件、代次加一，再推给页面（marks.rs 的 clear_practice_marks）。 */
    clearAll() {
      store.clear();
      store.generation++;
      env.window.__fenbiClearMarks(store.generation);
    },
  });
}

const PRACTICE_URL_FOR_HIGHLIGHT = "https://spa.fenbi.com/ti/exam/exercise/1_3e_2k95rs8?routecs=syzc";
