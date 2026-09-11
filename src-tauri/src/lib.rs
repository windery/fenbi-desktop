// 粉笔刷题 wrapper
//
// 目标：打开 app 就直接落在刷题入口页。登录、做题、看报告全部交给粉笔网站
// 自己的逻辑处理。
//
// ## 设计原则：不干预站点运行
//
// 这是一个**展示层 wrapper**：只负责把窗口开到刷题页，并在需要时裁剪页面元素。
// 它不接管登录流程、不读 cookie 判登录态、不刷新页面、不模拟点击。
//
// 教训：早期版本为了「登录后自动跳转」而轮询 cookie 并强制 location.reload()，
// 结果在用户刚扫码成功、站点正在建立会话的瞬间把页面刷掉，亲手打断了站点的登录。
// 站点自己的登录流程本来是好的 —— 不要碰它。
//
// ## 实测站点事实（详见 README）
//   * 刷题入口: /tiku/guide/home/{courseSet}/{prefix}
//     事业单位笔试-公基 = /tiku/guide/home/sydw/sydw?labelId=4147
//   * www.fenbi.com 与 spa.fenbi.com 是同一套 SPA
//   * 登录是页内模态框，凭证是 HttpOnly cookie，JS 读不到
//   * login.fenbi.com/api/users/{info,current} 在未登录时也返回 200 + userId，不可作判据

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 刷题入口页 = 题库目录页。
///
/// 这个页面会由粉笔自己**恢复用户上次选择的题库分类**，所以 wrapper 不需要
/// 知道用户刷的是行测还是事业单位，跳过去就行。
const PRACTICE_URL: &str = "https://www.fenbi.com/spa/tiku/guide/catalog";

const WINDOW_LABEL: &str = "main";

/// 诊断日志开关。debug 构建默认开；release 下用环境变量打开：
///   FENBI_DEBUG=1 open -a 粉笔刷题
/// 打开后注入脚本会把行为日志送到 127.0.0.1:8799（见 README 排查一节）。
fn debug_enabled() -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    matches!(
        std::env::var("FENBI_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

/// 环境变量覆盖，仅用于对着本地假站点验证跳转逻辑：
///   FENBI_PRACTICE_URL   跳转目标（注入脚本里的 TARGET_URL）
///   FENBI_ENTRY_URL      窗口初始加载的 URL（不设则等于目标）
fn practice_url() -> String {
    std::env::var("FENBI_PRACTICE_URL").unwrap_or_else(|_| PRACTICE_URL.to_string())
}

fn entry_url(target: &str) -> String {
    std::env::var("FENBI_ENTRY_URL").unwrap_or_else(|_| target.to_string())
}

/// 把字符串转义成可安全嵌入 JS 双引号字面量的形式
fn js_string_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 当前是否持有登录凭证。
///
/// 认**任一**凭证，因为两个 cookie 的生命周期完全不同：
///   * `persistent` —— 落盘的长期凭证，`Max-Age=31536000`（实测 1 年）。
///     它是跨重启登录状态的真正来源。
///   * `sess` / `userid` —— 会话级，**从不落盘**，冷启动时由 `persistent`
///     现场换取，只存在于内存。
///
/// 所以不能只看 `sess`：页面没重载时它可能一直不存在，据此判定"已登出"会误报。
/// 反过来只看 `persistent` 也不行——若某次登录没下发它而 `sess` 有效，
/// 会误判成未登录。认"任一存在"是唯一安全的方向。
fn credentials_present(win: &tauri::WebviewWindow) -> bool {
    const NAMES: [&str; 3] = ["persistent", "sess", "userid"];
    win.cookies()
        .map(|cs| cs.iter().any(|c| NAMES.contains(&c.name())))
        .unwrap_or(false)
}

/* ------------------------------------------------------------------ *
 * 登录状态记录
 *
 * 「曾经登录成功」记在一个小文件里，放在 app 数据目录下。
 * 记下来之后，下次启动直接进刷题页，**完全跳过检查和弹窗**。
 *
 * 为什么不每次都去查 cookie：冷启动时站点要用 persistent cookie 才能
 * 恢复出 sess，这个恢复过程需要时间。查早了就误判未登录，于是每次启动都
 * 白弹一次登录框。记一个标记就绕开了这个时序问题。
 * ------------------------------------------------------------------ */

fn login_flag_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("login-state"))
}

fn read_login_flag(app: &tauri::AppHandle) -> Option<bool> {
    let path = login_flag_path(app)?;
    let text = std::fs::read_to_string(path).ok()?;
    match text.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn write_login_flag(app: &tauri::AppHandle, logged_in: bool) {
    let Some(path) = login_flag_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, if logged_in { "true" } else { "false" }) {
        if debug_enabled() {
            println!("[fenbi-wrapper] write login flag failed: {e}");
        }
    } else if debug_enabled() {
        println!("[fenbi-wrapper] login flag = {logged_in}");
    }
}

/// 注入脚本启动时调用。返回 true 表示「以前登录成功过」，
/// 此时脚本不做任何检查和弹窗，直接停在刷题页。
#[tauri::command]
fn is_known_logged_in(app: tauri::AppHandle) -> bool {
    read_login_flag(&app).unwrap_or(false)
}

/// 是否在练习/考试流程内：此时不应该弹登录框打断做题，也不应该跳转。
///
/// 注意真实的练习页在 `spa.fenbi.com/ti/exam/exercise/<id>`，
/// **不在 `/tiku` 之下**。最初只判断 `/tiku/...` 导致这个保护完全失效。
fn inside_practice(win: &tauri::WebviewWindow) -> bool {
    const PREFIXES: [&str; 4] = [
        "/ti/", // 真实练习/考试页
        "/tiku/exercise",
        "/tiku/guide/realTest",
        "/tiku/report",
    ];
    let Ok(url) = win.url() else {
        return false;
    };
    let path = url.path();
    PREFIXES.iter().any(|p| path.starts_with(p))
}

/// 通知页面「已登出」，让页面弹登录框。
fn notify_logged_out(win: &tauri::WebviewWindow) {
    let _ = win.eval("window.__fenbiLoggedOut && window.__fenbiLoggedOut('session-lost');");
}

/// 页面加载完成后的「判定」与常驻心跳。
///
/// ## 权威判定
///
/// **启动时页面加载完成后检测一次，这才是登录与否的权威判定。**
/// `login-state` 记录只是加速缓存：它让启动路径 0 等待（不必先查凭证），
/// 但真相永远以这次检测为准——检测完就把记录改写成检测结果。
///
/// 为什么这次检测可信：`sess` 是会话级 cookie，要靠落盘的 `persistent` 换取。
/// 页面加载完成时站点已经把这一步做完了，所以此刻读到的就是最终状态。
/// 我们**不**在启动路径上查凭证，正是为了绕开"页面还没加载完"那段空窗期。
///
/// ## 心跳
///
/// 之后每 `heartbeat_ms` 复查一次，用于捕捉运行中的登出（比如你在页面里点了
/// 「退出登录」）。检测到会话消失时：不在练习区就弹框，在练习区只记记录不打断。
fn spawn_login_watch(win: tauri::WebviewWindow, load_gen: std::sync::Arc<std::sync::atomic::AtomicU64>) {
    use std::sync::atomic::Ordering;

    /// 页面加载完成后等一会儿再判定，让站点的登录态请求先落地
    const SETTLE_MS: u64 = 1500;
    /// 等待判定期间的轮询间隔
    const FAST_POLL_MS: u64 = 500;

    // 心跳间隔。FENBI_DEBUG_HEARTBEAT_MS 仅用于测试时收缩间隔。
    let heartbeat_ms: u64 = std::env::var("FENBI_DEBUG_HEARTBEAT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5 * 60 * 1000);

    std::thread::spawn(move || {
        // pending：观察到新页面加载但还没判定，要跨迭代保留。
        // settle_at：该页面加载对应的判定时刻，**只在观察到新代号时设一次**。
        // 早期版本用 `gen > settled_gen && now >= verify_at` 判断"要不要重新计时"，
        // 结果每次到点都把时刻又推后 1.5 秒，永远到不了 —— 死循环。
        let mut settled_gen: u64 = 0;
        let mut pending = false;
        let mut settle_at = std::time::Instant::now() + std::time::Duration::from_millis(SETTLE_MS);
        let mut logged_in: Option<bool> = None;
        let mut first_settle_done = false;

        if debug_enabled() {
            println!("[fenbi-wrapper] watch start");
        }

        loop {
            let gen = load_gen.load(Ordering::SeqCst);

            // 观察到新的页面加载：重新起算判定时刻（每个代号只设一次）
            if gen > settled_gen {
                settled_gen = gen;
                pending = true;
                settle_at = std::time::Instant::now()
                    + std::time::Duration::from_millis(SETTLE_MS);
                if debug_enabled() {
                    println!("[fenbi-wrapper] page load #{gen} -> settle in {SETTLE_MS}ms");
                }
            }

            if pending && std::time::Instant::now() >= settle_at {
                pending = false;
                // ── 权威判定 ──
                let has = credentials_present(&win);
                let recorded = read_login_flag(&win.app_handle().clone());
                if debug_enabled() {
                    println!(
                        "[fenbi-wrapper] verify after page load: creds={has} record={recorded:?}"
                    );
                }
                match (has, recorded) {
                    // 检测到已登录：记录纠正为 true。
                    // 记录原本不是 true 时也要通知页面——启动路径可能已经按
                    // 过期的 false 排好了一个弹框，得让它取消；
                    // 若站点把我们带到了别处，也顺便回目录页。
                    (true, r) => {
                        logged_in = Some(true);
                        write_login_flag(&win.app_handle().clone(), true);
                        if r != Some(true) {
                            if debug_enabled() {
                                println!("[fenbi-wrapper] record corrected -> notify page");
                            }
                            let _ = win.eval(
                                "window.__fenbiLoginSucceeded && window.__fenbiLoginSucceeded();",
                            );
                        }
                    }
                    // 检测到未登录：记录改 false；若记录原说已登录且不在练习区，弹框
                    (false, r) => {
                        logged_in = Some(false);
                        write_login_flag(&win.app_handle().clone(), false);
                        if r == Some(true) && !inside_practice(&win) {
                            notify_logged_out(&win);
                        }
                    }
                }
                if !first_settle_done {
                    first_settle_done = true;
                    if debug_enabled() {
                        println!("[fenbi-wrapper] first settle done -> heartbeat every {heartbeat_ms}ms");
                    }
                }
            }

            // 首次判定完成前一律快轮询：线程启动时页面还没加载，
            // 若此时就按心跳间隔睡，会直接错过整个判定时机。
            let sleep_ms = if pending || !first_settle_done {
                FAST_POLL_MS
            } else {
                heartbeat_ms
            };
            std::thread::sleep(std::time::Duration::from_millis(sleep_ms));

            // ── 心跳复查 ──
            // 待判定期间不做心跳，那套快轮询已经在看凭证了。
            if !pending && first_settle_done {
                let has = credentials_present(&win);
                match (logged_in, has) {
                    (Some(true), false) => {
                        logged_in = Some(false);
                        write_login_flag(&win.app_handle().clone(), false);
                        let interrupt = !inside_practice(&win);
                        if debug_enabled() {
                            println!(
                                "[fenbi-wrapper] heartbeat: session gone (interrupt={interrupt})"
                            );
                        }
                        if interrupt {
                            notify_logged_out(&win);
                        }
                    }
                    (Some(false), true) | (None, true) => {
                        logged_in = Some(true);
                        write_login_flag(&win.app_handle().clone(), true);
                        if debug_enabled() {
                            println!("[fenbi-wrapper] heartbeat: session present");
                        }
                        let _ = win.eval(
                            "window.__fenbiLoginSucceeded && window.__fenbiLoginSucceeded();",
                        );
                    }
                    _ => {}
                }
            }
        }
    });
}

/// **仅诊断用**：驱动站点自己的「退出登录」，用来验证退出检测链路。
/// release 构建下不注册该命令。
#[cfg(debug_assertions)]
#[tauri::command]
fn debug_request_logout(window: tauri::WebviewWindow) -> Result<(), String> {
    // 直接驱动站点自己的退出登录，这样验证的是完整链路。
    window
        .eval(
            r#"
            (function () {
              var el = document.querySelector(".show-logout, .content-logon-success .show-logout");
              if (el) { el.click(); return; }
              // 退而求其次：找文案是"退出登录"的可点元素
              var all = document.querySelectorAll("div,span,button,a,li");
              for (var i = 0; i < all.length; i++) {
                if ((all[i].textContent || "").trim() === "\u9000\u51fa\u767b\u5f55") {
                  all[i].click();
                  return;
                }
              }
              console.log("[fenbi-wrapper] debug: logout control not found");
            })();
            "#,
        )
        .map_err(|e| e.to_string())?;
    println!("[fenbi-wrapper] debug: asked site to log out");
    Ok(())
}

/// 读取注入脚本。
///
/// debug 构建下优先从 target 目录读磁盘副本（由 build.rs 拷贝），
/// 这样改脚本只需重开 app，不用重编译（release 的 LTO 编译要一分半）。
/// 读不到就回退到 `include_str!` 内嵌的版本，保证任何情况下都能跑。
/// release 构建直接用内嵌版本，产物自包含。
fn load_script(name: &str, embedded: &'static str) -> String {
    if cfg!(debug_assertions) {
        // build.rs 把脚本副本放在可执行文件同目录（target/debug/）与 target/ 下
        if let Ok(exe) = std::env::current_exe() {
            let mut candidates = Vec::new();
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join(name));
                if let Some(parent) = dir.parent() {
                    candidates.push(parent.join(name));
                }
            }
            for path in candidates {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    return text;
                }
            }
        }
    }
    embedded.to_string()
}

fn build_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let target = practice_url();
    let entry = entry_url(&target);
    if debug_enabled() {
        println!("[fenbi-wrapper] entry={entry} target={target}");
    }

    // debug 构建才把诊断片段拼进去，release 产物里不含调试代码
    let debug_hook = if cfg!(debug_assertions) {
        load_script("init-debug.js", include_str!("../init-debug.js"))
    } else {
        String::new()
    };
    let script = format!(
        "{}\n{}",
        load_script("init.js", include_str!("../init.js")),
        debug_hook
    )
    .replace("__TARGET_URL__", &js_string_escape(&target))
    .replace("__DEBUG__", if debug_enabled() { "true" } else { "false" });

    // 页面加载代号：每次页面加载递增，监听线程据此知道"该做一次判定了"
    let load_gen = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    let win = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::External(entry.parse().expect("entry URL 必须是合法 URL")),
    )
    .title("粉笔刷题")
    // 启动即全屏（macOS 原生全屏，绿点那种）。
    // 想改成"最大化但保留标题栏"就换成 .maximized(true)；
    // 想固定尺寸就把这两行删掉，用下面那组 inner_size。
    .fullscreen(true)
    .inner_size(1180.0, 880.0)
    .min_inner_size(900.0, 640.0)
    .initialization_script(&script)
    .on_page_load({
        let load_gen = load_gen.clone();
        move |_w, _payload| {
            load_gen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if debug_enabled() {
                println!("[fenbi-wrapper] on_page_load: {}", _payload.url());
            }
        }
    })
    .build()?;

    if debug_enabled() {
        println!("[fenbi-wrapper] window built ok");
    }

    // 页面加载后的权威判定 + 常驻心跳
    spawn_login_watch(win.clone(), load_gen);

    // 诊断：FENBI_DEBUG_DROP_AFTER=6000 会在 6 秒后删掉 sess cookie，
    // 用来自动验证「退出登录 -> 弹登录框」这条路径。仅 debug 构建。
    #[cfg(debug_assertions)]
    if let Ok(ms) = std::env::var("FENBI_DEBUG_DROP_AFTER") {
        if let Ok(ms) = ms.parse::<u64>() {
            let w = win.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(ms));
                println!("[fenbi-wrapper] DEBUG: dropping session after {ms}ms");
                let _ = w.eval("window.__fenbiDebugRequestLogout && window.__fenbiDebugRequestLogout();");
            });
        }
    }

    let _ = win.set_focus();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            is_known_logged_in,
            #[cfg(debug_assertions)]
            debug_request_logout,
        ])
        .setup(|app| {
            build_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动粉笔 wrapper 失败");
}
