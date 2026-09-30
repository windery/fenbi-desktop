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
mod toolbar;

use login_state::{Credentials, WatchPoll, WatchShared};
use std::sync::Arc;
use tauri::webview::PageLoadEvent;
use tauri::{
    LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl, WindowBuilder,
};

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
fn read_credentials(win: &Webview) -> Credentials {
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
 * 「上次观测到的是否已登录」记在 app 数据目录下的小文件里。
 *
 * 它不参与判定：启动时读出来只作为缓存镜像的初值，观察结果与它相同时就
 * 不必再写一遍。内容不可读按"没有记录"处理，判定始终来自本轮观察。
 *
 * 冷启动时机由观察窗口处理：站点要用 persistent cookie 才能恢复出 sess，
 * 这段恢复需要时间，查早了会误判未登录。
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

/// 注入脚本重读当前判定。返回 `[seq, "pending" | "logged-in" | "logged-out"]`。
///
/// 只读共享快照，**不读 cookie**：判定由观察线程在锁内线性化地写好，页面拿到的是
/// 当下这一刻的结论，而不是命令执行时重新探测出来的结论。
#[tauri::command]
fn current_login_decision(state: tauri::State<'_, Arc<WatchShared>>) -> (u64, String) {
    let (seq, decision) = state.snapshot();
    (seq, decision.as_str().to_string())
}

/// 提醒页面重读当前判定快照。
///
/// eval 只喊一声，**绝不携带序号或判定**：读到什么永远取决于页面重读的那一刻。
/// 旧文档里发出的 eval 晚到新文档时，只会让新页面重读它自己的 pending，不会把
/// 旧页面的过期判定写进去——所以这里不需要 document token。
const REFRESH_DECISION_SCRIPT: &str =
    "window.__fenbiRefreshLoginDecision && window.__fenbiRefreshLoginDecision();";

fn refresh_page_decision(win: &Webview) {
    let _ = win.eval(REFRESH_DECISION_SCRIPT);
}

/// 一次页面加载事件对共享状态的更新。生产回调与测试共用这一份。
///
/// `Started` 先把快照清成 pending，再由调用方在锁外提醒页面重读：导航开始时
/// 旧文档可能还活着，它那套「等按钮」轮询要靠这次 wake 才知道判定已作废。
/// `Finished` 只安排观察窗口。两者都不读 cookie、不写缓存。
fn handle_page_event<F>(shared: &WatchShared, event: PageLoadEvent, now_ms: u64, notify_page: F)
where
    F: FnOnce(),
{
    match event {
        PageLoadEvent::Started => {
            shared.on_started();
            notify_page();
        }
        PageLoadEvent::Finished => shared.on_finished(now_ms),
    }
}

/// 这个窗口事件是否该让 watcher 退出。
///
/// 用 `Destroyed` 而不是 `CloseRequested`：后者只是"请求关闭"，用户或页面
/// 还可能把它取消。窗口真正销毁后再停线程。
fn window_destroyed(event: &tauri::WindowEvent) -> bool {
    matches!(event, tauri::WindowEvent::Destroyed)
}

/// 登录观察线程：本地凭证观测 + 常驻心跳。
///
/// ## 首次观察
///
/// 页面 `Finished` 后等一个观察窗口再读一次本地凭证。这个窗口只是给站点恢复
/// 会话留时间，读到什么仍只是本地观测，**不是**网站真实会话的判定。
///
/// ## 心跳
///
/// 之后每 `heartbeat_ms` 复查一次，用于捕捉运行中的登出（比如你在页面里点了
/// 「退出登录」）。等待**不是盲睡**：页面加载事件会提前唤醒它。
///
/// 线程只做三件事：问共享状态下一步、在锁外读一次 cookie、把结果交回去。
/// 判定与缓存写入由 [`WatchShared`] 在锁内线性化；页面的 eval 永远在锁外。
fn spawn_login_watch(win: Webview, shared: Arc<WatchShared>) {
    std::thread::spawn(move || {
        let app = win.app_handle().clone();
        if debug_enabled() {
            println!("[fenbi-wrapper] watch start");
        }

        loop {
            match shared.next_step(shared.now_ms()) {
                WatchPoll::Stop => {
                    if debug_enabled() {
                        println!("[fenbi-wrapper] watch stop");
                    }
                    break;
                }
                WatchPoll::Wait {
                    version,
                    timeout_ms,
                } => shared.wait(version, timeout_ms),
                WatchPoll::Read { token } => {
                    // cookie 读取在锁外：可能很慢，期间页面还可能换一代。
                    let creds = read_credentials(&win);
                    if debug_enabled() {
                        println!("[fenbi-wrapper] read token={token} creds={creds:?}");
                    }
                    let notify = shared.finish_read(token, creds, shared.now_ms(), |present| {
                        write_login_flag(&app, present);
                    });
                    // eval 在锁外；只提醒页面重读 snapshot，不带序号也不带判定。
                    if notify {
                        refresh_page_decision(&win);
                    }
                }
            }
        }
    });
}

/// **仅诊断用**：驱动站点自己的「退出登录」，用来验证退出检测链路。
/// release 构建下不注册该命令。
#[cfg(debug_assertions)]
#[tauri::command]
fn debug_request_logout(window: tauri::Webview) -> Result<(), String> {
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
    shared: Arc<WatchShared>,
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
        "{}\n{}\n{}",
        load_script("shortcuts.js", include_str!("../toolbar/shortcuts.js")),
        load_script("init.js", include_str!("../init.js")),
        debug_hook
    )
    .replace("__TARGET_URL__", &target_literal)
    .replace("__DEBUG__", if debug_enabled() { "true" } else { "false" });

    // 页面加载事件（Started/Finished）直接写进共享状态，watcher 用 Condvar 等它。
    app.manage(toolbar::ToolbarState::new(app, parsed_target.as_str()));
    let window = WindowBuilder::new(app, WINDOW_LABEL)
        .title("粉笔刷题")
        .fullscreen(true)
        .inner_size(1180.0, 880.0)
        .min_inner_size(900.0, 640.0)
        .build()?;
    // Visible uses FullSizeContentView on macOS and clips child views under the titlebar.
    #[cfg(target_os = "macos")]
    window.set_title_bar_style(tauri::TitleBarStyle::Transparent)?;
    window.add_child(
        WebviewBuilder::new(toolbar::TOOLBAR, WebviewUrl::App("index.html".into()))
            .on_navigation(toolbar::local_url_allowed),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(1180.0, toolbar::EXPANDED_HEIGHT),
    )?;
    let content = WebviewBuilder::new(toolbar::CONTENT, WebviewUrl::External(parsed_entry))
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
                    if let Some(win) = handle.get_webview(toolbar::CONTENT) {
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
            let shared = Arc::clone(&shared);
            move |w, payload| {
                // Started 后立刻在锁外喊一次，让还在旧文档里的轮询重读 pending。
                handle_page_event(&shared, payload.event(), shared.now_ms(), || {
                    refresh_page_decision(&w)
                });
                if debug_enabled() {
                    // 只记路径：完整 URL 的 query 可能带用户信息，不进日志
                    println!(
                        "[fenbi-wrapper] on_page_load: {:?} {}",
                        payload.event(),
                        payload.url().path()
                    );
                }
            }
        });
    let win = window.add_child(
        content,
        LogicalPosition::new(0.0, toolbar::EXPANDED_HEIGHT),
        LogicalSize::new(1180.0, 880.0 - toolbar::EXPANDED_HEIGHT),
    )?;
    toolbar::layout(&window)?;

    if debug_enabled() {
        println!("[fenbi-wrapper] window built ok");
    }

    // 窗口销毁后让 watcher 退出，不留下永远等 Condvar 的线程。
    {
        let shared = Arc::clone(&shared);
        let handle = app.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                if let Some(window) = handle.get_window(WINDOW_LABEL) {
                    if let Err(e) = toolbar::layout(&window) {
                        eprintln!("[fenbi-wrapper] layout: {e}");
                    }
                }
            }
            if window_destroyed(event) {
                shared.stop();
            }
        });
    }

    // 首次观察 + 常驻心跳
    spawn_login_watch(win.clone(), shared);

    // 诊断：FENBI_DEBUG_DROP_AFTER=6000 会在 6 秒后驱动站点自己的退出登录，
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

/// 心跳间隔。`FENBI_DEBUG_HEARTBEAT_MS` 仅用于测试时收缩间隔。
fn heartbeat_interval_ms() -> u64 {
    std::env::var("FENBI_DEBUG_HEARTBEAT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5 * 60 * 1000)
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
            current_login_decision,
            toolbar::toolbar_action,
            toolbar::toolbar_state,
            toolbar::toggle_toolbar,
            #[cfg(debug_assertions)]
            debug_request_logout,
        ])
        .setup(move |app| {
            // 共享状态先于窗口注册：注入脚本随时可能 invoke 重读判定。
            let shared = Arc::new(WatchShared::new(
                read_login_flag(app.handle()),
                heartbeat_interval_ms(),
            ));
            app.manage(Arc::clone(&shared));
            build_window(app.handle(), &target, &parsed_target, parsed_entry, shared)?;
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
    fn current_login_decision_serializes_as_a_two_element_array() {
        // 跨语言协议：`current_login_decision` 的返回值序列化成 [seq, decision]，
        // decision 取 "pending" / "logged-in" / "logged-out"。注入脚本按数组解。
        let payload = (7u64, "pending".to_string());
        assert_eq!(serde_json::to_string(&payload).unwrap(), r#"[7,"pending"]"#);
    }

    #[test]
    fn started_clears_snapshot_then_wakes_the_page_without_reading_or_writing() {
        // Started 必须先把快照清成 pending，再在锁外通知页面重读；通知回调里
        // 看到的快照就是旧文档即将读到的值。
        let shared = WatchShared::new(None, 60_000);
        shared.on_started();
        shared.on_finished(0);
        let token = match shared.next_step(1_000_000) {
            WatchPoll::Read { token } => token,
            other => panic!("预期读取凭证，得到 {other:?}"),
        };
        let mut writes = Vec::new();
        assert!(
            shared.finish_read(token, Credentials::Present, 1_000_000, |p| {
                writes.push(p)
            })
        );
        writes.clear();
        assert_eq!(
            shared.snapshot().1,
            login_state::PageDecision::LoggedIn,
            "先制造一个非 pending 的旧判定"
        );

        let mut snapshot_at_notify = None;
        handle_page_event(&shared, PageLoadEvent::Started, 1_000_000, || {
            snapshot_at_notify = Some(shared.snapshot());
        });

        assert_eq!(
            snapshot_at_notify.map(|(_, decision)| decision),
            Some(login_state::PageDecision::Pending),
            "通知页面重读时快照必须已经是 pending"
        );
        // 不读 cookie：Started 之后没有安排任何读取
        assert!(matches!(
            shared.next_step(1_000_000),
            WatchPoll::Wait { .. }
        ));
        // 不写缓存：Started 只更新内存快照
        assert!(writes.is_empty());
    }

    #[test]
    fn destroyed_window_stops_the_watcher() {
        // Destroyed 才让 watcher 退出。CloseRequested 只是"请求关闭"，
        // 可能被取消，不能停线程；它带私有的 CloseRequestApi，构造不出来，
        // 所以这里只锁定 Destroyed 这一侧。
        assert!(window_destroyed(&tauri::WindowEvent::Destroyed));
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
