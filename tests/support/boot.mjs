import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_PATH, createEnv } from "./browser-env.mjs";

export { CATALOG_PATH, PRACTICE_URL, TARGET_URL } from "./browser-env.mjs";

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
