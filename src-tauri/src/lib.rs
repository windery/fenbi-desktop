// 粉笔刷题 wrapper
//
// 目标：打开 app 就直接落在刷题入口页。登录、做题、看报告全部交给粉笔网站
// 自己的逻辑处理。
//
// ## 边界：只做展示层
//
// 它把窗口开到刷题页、按需裁剪页面元素、必要时点击**站点自己的登录入口按钮**。
// 它不驱动答题、不提交试卷、不选分类、不调用站点私有接口。
//
// ## 它确实会读 cookie —— 但只读名字
//
// 为了判断"还要不要弹登录框"，这里用 `Webview::cookies()` 读本地凭证信号。
// 读到凭证**不等于**登录有效：那只是一个本地观测，服务端可能早就拒绝了它。
// 所以代码和文案里都不写"已验证登录"，只写"观测到凭证"。
// 判定的分层见 `login_state.rs` 的模块文档。
//
// 教训：早期版本为了「登录后自动跳转」而轮询 cookie 并强制 location.reload()，
// 结果在用户刚扫码成功、站点正在建立会话的瞬间把页面刷掉，亲手打断了站点的登录。
// 站点自己的登录流程本来是好的 —— 不要碰它。
//
// ## 已知的站点事实（详见 CONTRIBUTING.md「已验证的站点事实」）
//   * 刷题入口: /tiku/guide/home/{courseSet}/{prefix}
//     事业单位笔试-公基 = /tiku/guide/home/sydw/sydw?labelId=4147
//   * www.fenbi.com 与 spa.fenbi.com 是同一套 SPA
//   * 登录是页内模态框，凭证是 HttpOnly cookie，JS 读不到
//   * login.fenbi.com/api/users/{info,current} 在未登录时也返回 200 + userId，不可作判据

mod login_state;

use login_state::{Credentials, HeartbeatAction, PageLoadSignal, SettleAction};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 刷题入口页 = 题库目录页。
///
/// 这个页面会由粉笔自己**恢复用户上次选择的题库分类**，所以 wrapper 不需要
/// 知道用户刷的是行测还是事业单位，跳过去就行。
const PRACTICE_URL: &str = "https://www.fenbi.com/spa/tiku/guide/catalog";

const WINDOW_LABEL: &str = "main";

/// 诊断日志开关。debug 构建默认开；release 下用环境变量打开：
///   FENBI_DEBUG=1 open -a 粉笔刷题
/// 打开后注入脚本会把行为日志送到 127.0.0.1:8799（见 CONTRIBUTING.md 排查一节）。
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

/// 解析并放行一个会进入 WebView 的 URL。
///
/// 这两个地址都可以被环境变量覆盖，所以必须校验：入口决定窗口加载什么，
/// 跳转目标会被序列化进注入脚本。放行策略在 `login_state::entry_url_policy`。
fn parse_checked_url(raw: &str, what: &str) -> Result<tauri::Url, Box<dyn std::error::Error>> {
    let url = tauri::Url::parse(raw).map_err(|e| format!("{what}不是合法 URL：{raw}（{e}）"))?;
    login_state::entry_url_policy(url.scheme(), url.host_str())
        .map_err(|e| format!("{what}被拒绝：{raw}（{e}）"))?;
    Ok(url)
}

/// 读一次本地凭证信号。
///
/// 读取失败映射成 [`Credentials::Unknown`]，**不是** `Absent`：一次读取故障
/// 不等于用户登出，把它当登出会写坏记录并弹出本不该弹的登录框。
fn read_credentials(win: &WebviewWindow) -> Credentials {
    let names = win
        .cookies()
        .map(|cookies| {
            cookies
                .iter()
                .map(|c| c.name().to_string())
                .collect::<Vec<_>>()
        })
        .map_err(|_| ());
    login_state::credentials_from(names)
}

/* ------------------------------------------------------------------ *
 * 登录状态记录
 *
 * 「上次观测到已登录」记在一个小文件里，放在 app 数据目录下。
 * 记下来之后，下次启动直接进刷题页，**完全跳过检查和弹窗**。
 *
 * 它是**加速缓存**，不是真相来源：内容不可读时按"没有记录"处理，
 * 检测结果与它不一致时以检测为准并改写它。
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
    login_state::parse_login_flag(&text)
}

fn write_login_flag(app: &tauri::AppHandle, logged_in: bool) {
    let Some(path) = login_flag_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, login_state::format_login_flag(logged_in)) {
        if debug_enabled() {
            println!("[fenbi-wrapper] write login flag failed: {e}");
        }
    } else if debug_enabled() {
        println!("[fenbi-wrapper] login flag = {logged_in}");
    }
}

/// 注入脚本启动时调用。返回 true 表示「以前观测到登录成功过」，
/// 此时脚本不做任何检查和弹窗，直接停在刷题页。
#[tauri::command]
fn is_known_logged_in(app: tauri::AppHandle) -> bool {
    read_login_flag(&app).unwrap_or(false)
}

/// 注入脚本暴露的两个页面通知入口。两份通知都只做一件事，就写在这里，
/// 不再往 `login_state` 里塞没有决策的函数。
const LOGGED_OUT_SCRIPT: &str =
    "window.__fenbiLoggedOut && window.__fenbiLoggedOut('session-lost');";
const LOGGED_IN_SCRIPT: &str = "window.__fenbiLoginSucceeded && window.__fenbiLoginSucceeded();";

/// 通知页面「观测不到会话了」，让页面弹登录框。
///
/// 不分页面：练习/考试/报告页也立刻提示。站点自己实时上报答题数据，
/// 包装层不需要（也不该）替它判断"现在打不打扰"。
fn notify_logged_out(win: &WebviewWindow) {
    let _ = win.eval(LOGGED_OUT_SCRIPT);
}

fn notify_logged_in(win: &WebviewWindow) {
    let _ = win.eval(LOGGED_IN_SCRIPT);
}

/// 页面加载完成后的「判定」与常驻心跳。
///
/// ## 权威判定
///
/// **启动时页面加载完成后检测一次，这是启动路径唯一的权威判定。**
/// `login-state` 记录只是加速缓存：它让启动路径 0 等待（不必先查凭证），
/// 但真相永远以这次检测为准——检测完就把记录改写成检测结果。
///
/// 为什么这次检测可信：`sess` 是会话级 cookie，要靠落盘的 `persistent` 换取。
/// 页面加载完成时站点已经把这一步做完了，所以此刻读到的是它能给的最好证据。
/// 我们**不**在启动路径上查凭证，正是为了绕开"页面还没加载完"那段空窗期。
///
/// ## 心跳
///
/// 之后每 `heartbeat_ms` 复查一次，用于捕捉运行中的登出（比如你在页面里点了
/// 「退出登录」）。这段时间**不是盲睡**：页面加载会让 [`PageLoadSignal`] 唤醒它，
/// 否则新页面加载后最长五分钟内不会有任何判定。
fn spawn_login_watch(win: WebviewWindow, signal: Arc<PageLoadSignal>) {
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
        let app = win.app_handle().clone();
        // settled_gen：已经为哪一代页面加载起过判定。
        // settle_at：该页面加载对应的判定时刻，**只在观察到新代号时设一次**。
        // 早期版本用 `gen > settled_gen && now >= verify_at` 判断"要不要重新计时"，
        // 结果每次到点都把时刻又推后 1.5 秒，永远到不了 —— 死循环。
        let mut settled_gen: u64 = 0;
        let mut pending = true;
        let mut settle_at = Instant::now() + Duration::from_millis(SETTLE_MS);
        let mut logged_in: Option<bool> = None;
        let mut first_settle_done = false;

        if debug_enabled() {
            println!("[fenbi-wrapper] watch start");
        }

        loop {
            let gen = signal.current();

            // 观察到新的页面加载：重新起算判定时刻（每个代号只设一次）
            if gen > settled_gen {
                settled_gen = gen;
                pending = true;
                settle_at = Instant::now() + Duration::from_millis(SETTLE_MS);
                if debug_enabled() {
                    println!("[fenbi-wrapper] page load #{gen} -> settle in {SETTLE_MS}ms");
                }
            }

            if pending && Instant::now() >= settle_at {
                pending = false;
                // ── 权威判定 ──
                let creds = read_credentials(&win);
                let recorded = read_login_flag(&app);
                if debug_enabled() {
                    println!("[fenbi-wrapper] settle: creds={creds:?} record={recorded:?}");
                }
                match login_state::settle_action(creds, recorded) {
                    // 观测到凭证：记录纠正为 true。
                    // 记录原本不是 true 时也要通知页面——启动路径可能已经按
                    // 过期的 false 排好了一个弹框，得让它取消。
                    SettleAction::LoggedIn { notify_page } => {
                        logged_in = Some(true);
                        write_login_flag(&app, true);
                        if notify_page {
                            if debug_enabled() {
                                println!("[fenbi-wrapper] record corrected -> notify page");
                            }
                            notify_logged_in(&win);
                        }
                    }
                    SettleAction::LoggedOut { notify_page } => {
                        logged_in = Some(false);
                        write_login_flag(&app, false);
                        if notify_page {
                            notify_logged_out(&win);
                        }
                    }
                    // 凭证读取失败：保持未知，不写记录、不弹框、不改变已判定状态。
                    SettleAction::Keep => {
                        if debug_enabled() {
                            println!("[fenbi-wrapper] settle: credentials unknown, keep state");
                        }
                    }
                }
                if !first_settle_done {
                    first_settle_done = true;
                    if debug_enabled() {
                        println!(
                            "[fenbi-wrapper] first settle done -> heartbeat every {heartbeat_ms}ms"
                        );
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

            // 这一觉可以被页面加载打断。被打断就回顶部重新起算判定，
            // 不要再执行心跳——新页面的判定马上就会覆盖它。
            if signal.wait_for_load(gen, sleep_ms) {
                if debug_enabled() {
                    println!("[fenbi-wrapper] page load woke the watcher");
                }
                continue;
            }

            // ── 心跳复查 ──
            // 待判定期间不做心跳，那套快轮询已经在看凭证了。
            if pending || !first_settle_done {
                continue;
            }
            let creds = read_credentials(&win);
            match login_state::heartbeat_action(logged_in, creds) {
                HeartbeatAction::SessionGone => {
                    logged_in = Some(false);
                    write_login_flag(&app, false);
                    if debug_enabled() {
                        println!("[fenbi-wrapper] heartbeat: session gone");
                    }
                    notify_logged_out(&win);
                }
                HeartbeatAction::SessionPresent => {
                    logged_in = Some(true);
                    write_login_flag(&app, true);
                    if debug_enabled() {
                        println!("[fenbi-wrapper] heartbeat: session present");
                    }
                    notify_logged_in(&win);
                }
                HeartbeatAction::Nothing => {}
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

/// 启动前把两个会被环境变量覆盖的地址解析并校验好。
///
/// 必须在 `tauri::Builder::run()` **之前**调用：setup 里返回的错误会被 Tauri 的
/// 事件循环当成"无法 unwind 的 panic"处理，打出一屏 backtrace，
/// 真正的拒绝原因反而被埋掉。
fn resolve_urls() -> Result<(String, tauri::Url, tauri::Url), Box<dyn std::error::Error>> {
    let target = practice_url();
    let entry = entry_url(&target);
    // 入口决定窗口加载什么，跳转目标会被序列化进注入脚本，两个都要先放行
    let parsed_target = parse_checked_url(&target, "跳转目标")?;
    let parsed_entry = parse_checked_url(&entry, "窗口入口")?;
    Ok((target, parsed_target, parsed_entry))
}

fn build_window(
    app: &tauri::AppHandle,
    target: &str,
    parsed_target: &tauri::Url,
    parsed_entry: tauri::Url,
) -> Result<(), Box<dyn std::error::Error>> {
    let entry = parsed_entry.as_str().to_string();
    if debug_enabled() {
        println!("[fenbi-wrapper] entry={entry} target={target}");
    }

    // debug 构建才把诊断片段拼进去，release 产物里不含调试代码
    let debug_hook = if cfg!(debug_assertions) {
        load_script("init-debug.js", include_str!("../init-debug.js"))
    } else {
        String::new()
    };
    // 跳转目标用 JSON 序列化嵌进脚本，而不是手工转义引号——
    // 序列化器负责所有转义，目标里出现换行或引号也逃不出字符串字面量。
    let target_literal = serde_json::to_string(parsed_target.as_str())?;
    let script = format!(
        "{}\n{}",
        load_script("init.js", include_str!("../init.js")),
        debug_hook
    )
    .replace("__TARGET_URL__", &target_literal)
    .replace("__DEBUG__", if debug_enabled() { "true" } else { "false" });

    // 页面加载信号：每次页面加载递增代号并唤醒监听线程
    let signal = Arc::new(PageLoadSignal::new());

    let win = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(parsed_entry))
        .title("粉笔刷题")
        // 启动即全屏（macOS 原生全屏，绿点那种）。
        // 想改成"最大化但保留标题栏"就换成 .maximized(true)；
        // 想固定尺寸就把这两行删掉，用下面那组 inner_size。
        .fullscreen(true)
        .inner_size(1180.0, 880.0)
        .min_inner_size(900.0, 640.0)
        .initialization_script(&script)
        .on_new_window({
            let handle = app.clone();
            move |url, _features| {
                // 桌面端只有一扇窗口。Tauri 没接这个 handler 时会**丢掉所有**
                // 新窗口请求，粉笔搜题的 `window.open(..., "_blank")` 就是这么
                // 变成"点了没反应"的。站内的改成在当前窗口打开，站外的丢弃、
                // 页面停在原地（没有地址栏，被带走就回不来了）。
                if login_state::new_window_allowed(url.scheme(), url.host_str()) {
                    if debug_enabled() {
                        println!(
                            "[fenbi-wrapper] new window -> open in place: {}",
                            url.path()
                        );
                    }
                    if let Some(win) = handle.get_webview_window(WINDOW_LABEL) {
                        let _ = win.navigate(url);
                    }
                } else if debug_enabled() {
                    // 只记 scheme/host：路径与 query 可能带用户信息
                    println!(
                        "[fenbi-wrapper] new window denied: scheme={} host={:?}",
                        url.scheme(),
                        url.host_str()
                    );
                }
                tauri::webview::NewWindowResponse::Deny
            }
        })
        .on_page_load({
            let signal = Arc::clone(&signal);
            move |_w, payload| {
                signal.bump();
                if debug_enabled() {
                    // 只记路径：完整 URL 的 query 可能带用户信息，不进日志
                    println!("[fenbi-wrapper] on_page_load: {}", payload.url().path());
                }
            }
        })
        .build()?;

    if debug_enabled() {
        println!("[fenbi-wrapper] window built ok");
    }

    // 页面加载后的权威判定 + 常驻心跳
    spawn_login_watch(win.clone(), signal);

    // 诊断：FENBI_DEBUG_DROP_AFTER=6000 会在 6 秒后删掉 sess cookie，
    // 用来自动验证「退出登录 -> 弹登录框」这条路径。仅 debug 构建。
    #[cfg(debug_assertions)]
    if let Ok(ms) = std::env::var("FENBI_DEBUG_DROP_AFTER") {
        if let Ok(ms) = ms.parse::<u64>() {
            let w = win.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(ms));
                println!("[fenbi-wrapper] DEBUG: dropping session after {ms}ms");
                let _ = w.eval(
                    "window.__fenbiDebugRequestLogout && window.__fenbiDebugRequestLogout();",
                );
            });
        }
    }

    let _ = win.set_focus();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 地址来自环境变量：先校验，不合法就干净退出。
    // 拖到 setup 里才发现的话，用户看到的是一屏 backtrace 而不是原因。
    let (target, parsed_target, parsed_entry) = match resolve_urls() {
        Ok(urls) => urls,
        Err(e) => {
            eprintln!("[fenbi-wrapper] 启动失败：{e}");
            std::process::exit(2);
        }
    };

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            is_known_logged_in,
            #[cfg(debug_assertions)]
            debug_request_logout,
        ])
        .setup(move |app| {
            build_window(app.handle(), &target, &parsed_target, parsed_entry)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动粉笔 wrapper 失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_check_accepts_the_real_entry_and_loopback_test_pages() {
        assert!(parse_checked_url(PRACTICE_URL, "跳转目标").is_ok());
        assert!(parse_checked_url("http://127.0.0.1:8850/ti/exam/exercise/1", "入口").is_ok());
    }

    #[test]
    fn url_check_rejects_schemes_that_could_execute_code() {
        // 环境变量可以指向任意字符串，这里是它们进入 WebView 前的唯一闸门
        assert!(parse_checked_url("javascript:alert(1)", "入口").is_err());
        assert!(parse_checked_url("file:///etc/passwd", "入口").is_err());
        assert!(parse_checked_url("http://evil.example/login", "入口").is_err());
        assert!(parse_checked_url("not a url", "入口").is_err());
    }

    #[test]
    fn init_script_takes_the_target_as_a_bare_json_literal() {
        // lib.rs 用 serde_json 生成**带引号**的字面量去替换占位符，
        // 所以 init.js 里那个占位符不能自己再包一层引号。两边必须同步改。
        let script = include_str!("../init.js");
        assert!(
            script.contains("var TARGET_URL = __TARGET_URL__;"),
            "init.js 的 TARGET_URL 占位符写法变了，需同步 lib.rs 的替换方式"
        );

        let substituted = script.replace("__TARGET_URL__", &format!("\"{PRACTICE_URL}\""));
        assert!(substituted.contains(&format!("var TARGET_URL = \"{PRACTICE_URL}\";")));
    }
}
