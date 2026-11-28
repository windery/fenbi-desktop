//! 检查更新：问 GitHub「本仓库最新发布是哪一版」，比本机新就记下来，工具栏据此画红点。
//!
//! 只读一个版本号。不下载、不安装。查到的结果只活在内存里；存盘的只有「已看过的版本号」。
//! 请求的是发布页网址本身：GitHub 用一次跳转回答，跳转地址末尾就是最新发布的 tag。
//! 草稿和预发布不会成为这个跳转的目标。
use super::toolbar::require_toolbar;
use semver::Version;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

/// 发布页。检查更新请求它，下载新版也只打开它。
pub const RELEASES_URL: &str = "https://github.com/windery/fenbi-desktop/releases/latest";

const TIMEOUT: Duration = Duration::from_secs(8);

/// 检查更新记下的两个版本号。
#[derive(Default)]
struct Versions {
    /// 比本机新的那个版本；没有或还没查到就是空。只活在内存里。
    newer: Option<Version>,
    /// 已看过的版本号：用户最近一次在设置页面里看到的新版。存盘，重启后还在。
    seen: Option<Version>,
}

#[derive(Default)]
pub struct UpdateState {
    versions: Mutex<Versions>,
    /// 已看过的版本号存在哪个文件；空表示不存盘。
    seen_path: Option<PathBuf>,
}

/// 已看过的版本号的存盘位置：和工具栏展开/收起状态同一目录。
pub fn seen_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("seen-version"))
}

impl UpdateState {
    /// 启动时读回已看过的版本号。文件没有或读不懂，就当作什么都没看过。
    pub fn load(seen_path: Option<PathBuf>) -> Self {
        let seen = seen_path
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| Version::parse(text.trim()).ok());
        Self {
            versions: Mutex::new(Versions { newer: None, seen }),
            seen_path,
        }
    }

    /// 要不要画红点：有新版，而且它比已看过的版本号高。
    pub fn has_unseen_update(&self) -> bool {
        self.versions
            .lock()
            .is_ok_and(|v| match (&v.newer, &v.seen) {
                (Some(newer), Some(seen)) => newer > seen,
                (newer, _) => newer.is_some(),
            })
    }

    /// 已知的新版本号（不带 `v`）；没有就是空。
    pub fn newer_version(&self) -> Option<String> {
        let versions = self.versions.lock().ok()?;
        versions.newer.as_ref().map(Version::to_string)
    }

    /// 记下一次检查的结果，返回这次是否查到了新版。
    fn record(&self, current: &Version, latest: Version) -> bool {
        if latest <= *current {
            return false;
        }
        if let Ok(mut versions) = self.versions.lock() {
            versions.newer = Some(latest);
        }
        true
    }

    /// 用户在设置页面里看到了新版：把它记成已看过的版本号并存盘，红点随之消失。
    /// 已看过的版本号只升不降。存盘失败只打日志，这次运行里红点照样消失。
    pub fn mark_seen(&self) {
        let Ok(mut versions) = self.versions.lock() else {
            return;
        };
        let Some(newer) = versions.newer.clone() else {
            return;
        };
        if versions.seen.as_ref().is_some_and(|seen| *seen >= newer) {
            return;
        }
        if let Some(path) = &self.seen_path {
            let save = || -> std::io::Result<()> {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(path, newer.to_string())
            };
            if let Err(e) = save() {
                eprintln!("[fenbi-wrapper] 已看过的版本号没存上：{e}");
            }
        }
        versions.seen = Some(newer);
    }
}

/// 从跳转地址（`…/releases/tag/v0.1.4`）读出版本号。读不出来就当作没有新版。
fn version_from_location(location: &str) -> Option<Version> {
    let (_, tag) = location.rsplit_once("/releases/tag/")?;
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

/// 检查更新走哪个代理：环境变量里的优先；没有就用系统设置里的代理；都没有就直连。
///
/// - Windows：ureq 开了 `win-system-proxy`，`try_from_env` 读完环境变量会接着读系统设置里的代理。
/// - macOS：读系统设置里的 HTTPS 代理（见 `proxy_from_scutil`）。从访达或程序坞打开的应用
///   拿不到终端里设的环境变量，所以 Mac 上实际靠的是这一步。
/// - Linux：只认环境变量。
/// - 读不出来或格式不认识，当作没有代理，检查照常直连。PAC 自动配置和 SOCKS 代理不管。
fn update_proxy() -> Option<ureq::Proxy> {
    pick_proxy(ureq::Proxy::try_from_env(), system_proxy)
}

/// 有环境变量里的代理就用它，不再读系统设置（macOS 上读一次要起一个子进程）。
fn pick_proxy(
    from_env: Option<ureq::Proxy>,
    system: impl FnOnce() -> Option<ureq::Proxy>,
) -> Option<ureq::Proxy> {
    from_env.or_else(system)
}

#[cfg(target_os = "macos")]
fn system_proxy() -> Option<ureq::Proxy> {
    let output = std::process::Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    proxy_from_scutil(&String::from_utf8_lossy(&output.stdout))
}

/// Windows 的系统代理由 ureq 在 `try_from_env` 里读；Linux 不读系统代理。
#[cfg(not(target_os = "macos"))]
fn system_proxy() -> Option<ureq::Proxy> {
    None
}

/// 从 `scutil --proxy` 的输出里读 HTTPS 代理（系统设置里的「安全网页代理」）。
///
/// 检查更新只发 HTTPS 请求，系统对 HTTPS 请求也只用这一项，所以只开了 HTTP 代理时不用它。
/// 只看最外层的键：`__SCOPED__` 里是各网卡自己的设置，最外层才是正在生效的那份。
/// 系统设置里「忽略这些主机的代理设置」（`ExceptionsList`）里的主机照样直连。
#[cfg(any(target_os = "macos", test))]
fn proxy_from_scutil(output: &str) -> Option<ureq::Proxy> {
    let mut depth = 0usize;
    let mut in_exceptions = false;
    let (mut enabled, mut host, mut port) = (false, None, None);
    let mut exceptions = Vec::new();
    for line in output.lines().map(str::trim) {
        if line == "}" {
            depth = depth.saturating_sub(1);
            in_exceptions = false;
            continue;
        }
        if let Some((key, value)) = line.split_once(" : ") {
            match (depth, key) {
                (1, "HTTPSEnable") => enabled = value == "1",
                (1, "HTTPSProxy") => host = Some(value),
                (1, "HTTPSPort") => port = value.parse::<u16>().ok(),
                (1, "ExceptionsList") => in_exceptions = true,
                (2, _) if in_exceptions => exceptions.push(value),
                _ => {}
            }
        }
        if line.ends_with('{') {
            depth += 1;
        }
    }
    let host = host.filter(|host| enabled && !host.is_empty())?;
    let mut proxy = ureq::Proxy::builder(ureq::ProxyProtocol::Http).host(host);
    if let Some(port) = port {
        proxy = proxy.port(port);
    }
    for exception in exceptions {
        proxy = proxy.no_proxy(exception);
    }
    proxy.build().ok()
}

/// `proxy` 为空就直连。不交给 ureq 默认的「读环境变量」，走不走代理只由调用方决定。
fn fetch_latest(
    url: &str,
    user_agent: &str,
    proxy: Option<ureq::Proxy>,
    timeout: Duration,
) -> Result<Version, String> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .max_redirects(0)
            .max_redirects_will_error(false)
            .http_status_as_error(false)
            .timeout_global(Some(timeout))
            .user_agent(user_agent)
            .proxy(proxy)
            .build(),
    );
    let response = agent.get(url).call().map_err(|e| e.to_string())?;
    if !response.status().is_redirection() {
        return Err(format!("发布页没有跳转（{}）", response.status()));
    }
    response
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .and_then(version_from_location)
        .ok_or_else(|| "跳转地址里读不出版本号".to_string())
}

fn check_url() -> String {
    // 自测用：开发版可以把检查指向本机的假发布页。正式版只认写死的地址。
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("FENBI_UPDATE_URL") {
        return url;
    }
    RELEASES_URL.into()
}

/// 用户点「检查更新」时查一次：查到比本机新的就记下并返回它的版本号，没有新版返回空。
fn check_now(
    state: &UpdateState,
    current: &Version,
    url: &str,
    proxy: Option<ureq::Proxy>,
    timeout: Duration,
) -> Result<Option<String>, String> {
    let latest = fetch_latest(url, &format!("fenbi-desktop/{current}"), proxy, timeout)?;
    let version = latest.to_string();
    Ok(state.record(current, latest).then_some(version))
}

/// 设置页面要显示的两个版本号：本机的，和已知的新版（没有就是空）。
#[tauri::command]
pub fn settings_info(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    updates: tauri::State<'_, UpdateState>,
) -> Result<(String, Option<String>), String> {
    require_toolbar(webview.label())?;
    Ok((
        app.package_info().version.to_string(),
        updates.newer_version(),
    ))
}

/// 「检查更新」按钮。联网放在后台线程，查到新版就让工具栏重读状态。
#[tauri::command]
pub async fn check_update(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    require_toolbar(webview.label())?;
    let handle = app.clone();
    let found = tauri::async_runtime::spawn_blocking(move || {
        let current = handle.package_info().version.clone();
        check_now(
            &handle.state::<UpdateState>(),
            &current,
            &check_url(),
            update_proxy(),
            TIMEOUT,
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .inspect_err(|e| eprintln!("[fenbi-wrapper] 检查更新失败：{e}"))?;
    if found.is_some() {
        // 「检查更新」按钮只在设置页面里，查到的新版用户当场就看到了。
        app.state::<UpdateState>().mark_seen();
        let _ = webview.eval("window.__fenbiRefreshToolbar && window.__fenbiRefreshToolbar();");
    }
    Ok(found)
}

/// 「下载新版」按钮：让系统浏览器打开发布页。网址写死，界面传不进别的。
#[tauri::command]
pub fn open_release_page(webview: tauri::Webview) -> Result<(), String> {
    require_toolbar(webview.label())?;
    open::that_detached(RELEASES_URL).map_err(|e| e.to_string())
}

/// 启动时查一次。在后台线程里跑，失败不出提示。
pub fn spawn_startup_check(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let current = app.package_info().version.clone();
        let user_agent = format!("fenbi-desktop/{current}");
        match fetch_latest(&check_url(), &user_agent, update_proxy(), TIMEOUT) {
            Ok(latest) => {
                let updates = app.state::<UpdateState>();
                let found = updates.record(&current, latest);
                // 查完时设置页面已经开着：用户马上就看到这个新版，不再亮红点。
                if found && app.state::<super::toolbar::ToolbarState>().settings_open() {
                    updates.mark_seen();
                }
                if found && let Some(view) = app.get_webview(super::toolbar::TOOLBAR) {
                    let _ = view
                        .eval("window.__fenbiRefreshToolbar && window.__fenbiRefreshToolbar();");
                }
            }
            Err(e) => eprintln!("[fenbi-wrapper] 检查更新失败：{e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    /// 本机假发布页：对第一个请求回 `response`；`None` 表示收下请求但一直不回。
    fn fake_release_page(response: Option<&'static str>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/releases/latest", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.read(&mut [0u8; 2048]);
            match response {
                Some(text) => {
                    let _ = stream.write_all(text.as_bytes());
                }
                None => std::thread::sleep(Duration::from_secs(5)),
            }
        });
        url
    }

    #[test]
    fn reads_the_version_from_the_redirect_target() {
        assert_eq!(
            version_from_location("https://github.com/windery/fenbi-desktop/releases/tag/v0.1.4"),
            Some(v("0.1.4"))
        );
        assert_eq!(
            version_from_location("/windery/fenbi-desktop/releases/tag/1.2.3"),
            Some(v("1.2.3"))
        );
    }

    #[test]
    fn an_unreadable_redirect_target_is_not_a_version() {
        for location in [
            "https://github.com/windery/fenbi-desktop/releases",
            "https://github.com/windery/fenbi-desktop/releases/tag/nightly",
            "https://github.com/login",
            "",
        ] {
            assert_eq!(version_from_location(location), None, "{location}");
        }
    }

    #[test]
    fn only_a_version_above_the_running_one_counts_as_an_update() {
        for (latest, expected) in [
            ("0.1.4", true),
            ("0.2.0", true),
            ("0.1.3", false),
            ("0.1.2", false),
            ("0.1.3-beta.1", false),
        ] {
            let state = UpdateState::default();
            assert_eq!(state.record(&v("0.1.3"), v(latest)), expected, "{latest}");
            assert_eq!(state.has_unseen_update(), expected, "{latest}");
        }
    }

    #[test]
    fn nothing_is_an_update_before_a_check_finishes() {
        assert!(!UpdateState::default().has_unseen_update());
    }

    fn temp_seen_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fenbi-seen-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("seen-version")
    }

    #[test]
    fn the_dot_goes_once_the_new_version_is_seen_and_returns_for_a_higher_one() {
        let state = UpdateState::default();
        state.record(&v("0.1.3"), v("0.1.4"));
        assert!(state.has_unseen_update());

        state.mark_seen();
        assert!(!state.has_unseen_update(), "看过就不再亮");
        assert_eq!(
            state.newer_version(),
            Some("0.1.4".to_string()),
            "设置页面里仍然显示这个新版"
        );

        state.record(&v("0.1.3"), v("0.1.4"));
        assert!(!state.has_unseen_update(), "再查到同一版不亮");

        state.record(&v("0.1.3"), v("0.1.5"));
        assert!(state.has_unseen_update(), "出了更高的版本再亮");
    }

    #[test]
    fn seeing_nothing_remembers_nothing() {
        let path = temp_seen_path("nothing");
        let state = UpdateState::load(Some(path.clone()));
        state.mark_seen();
        assert!(!path.exists(), "没有新版时不写文件");
    }

    #[test]
    fn the_seen_version_survives_a_restart() {
        let path = temp_seen_path("restart");
        let first = UpdateState::load(Some(path.clone()));
        first.record(&v("0.1.3"), v("0.1.4"));
        first.mark_seen();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "0.1.4");

        let second = UpdateState::load(Some(path.clone()));
        second.record(&v("0.1.3"), v("0.1.4"));
        assert!(!second.has_unseen_update(), "重启后查到同一版不亮");
        second.record(&v("0.1.3"), v("0.1.5"));
        assert!(second.has_unseen_update(), "重启后查到更高的版本再亮");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn the_seen_version_never_goes_down() {
        let path = temp_seen_path("down");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "0.2.0\n").unwrap();
        let state = UpdateState::load(Some(path.clone()));
        state.record(&v("0.1.3"), v("0.1.4"));
        assert!(!state.has_unseen_update());
        state.mark_seen();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "0.2.0\n");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn an_unreadable_seen_file_counts_as_nothing_seen() {
        let path = temp_seen_path("broken");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "不是版本号").unwrap();
        let state = UpdateState::load(Some(path.clone()));
        state.record(&v("0.1.3"), v("0.1.4"));
        assert!(state.has_unseen_update());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_redirecting_release_page_yields_its_version() {
        let url = fake_release_page(Some(
            "HTTP/1.1 302 Found\r\nLocation: https://github.com/windery/fenbi-desktop/releases/tag/v9.9.9\r\nContent-Length: 0\r\n\r\n",
        ));
        assert_eq!(
            fetch_latest(&url, "fenbi-desktop/test", None, Duration::from_secs(2)),
            Ok(v("9.9.9"))
        );
    }

    #[test]
    fn a_manual_check_reports_and_remembers_only_a_newer_version() {
        const NEWER: &str = "HTTP/1.1 302 Found\r\nLocation: /windery/fenbi-desktop/releases/tag/v0.1.4\r\nContent-Length: 0\r\n\r\n";
        const SAME: &str = "HTTP/1.1 302 Found\r\nLocation: /windery/fenbi-desktop/releases/tag/v0.1.3\r\nContent-Length: 0\r\n\r\n";
        let timeout = Duration::from_secs(2);

        let state = UpdateState::default();
        let found = check_now(
            &state,
            &v("0.1.3"),
            &fake_release_page(Some(NEWER)),
            None,
            timeout,
        );
        assert_eq!(found, Ok(Some("0.1.4".to_string())));
        assert_eq!(state.newer_version(), Some("0.1.4".to_string()));

        let state = UpdateState::default();
        let found = check_now(
            &state,
            &v("0.1.3"),
            &fake_release_page(Some(SAME)),
            None,
            timeout,
        );
        assert_eq!(found, Ok(None));
        assert_eq!(state.newer_version(), None);
    }

    /// 三个设置页面命令只授权给工具栏页面；粉笔页面拿到的授权里一个都没有。
    #[test]
    fn the_website_is_granted_none_of_the_settings_commands() {
        let website = [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities/dev/loopback.json"),
        ];
        let toolbar = include_str!("../capabilities/toolbar.json");
        for permission in [
            "allow-settings-info",
            "allow-check-update",
            "allow-open-release-page",
        ] {
            assert!(toolbar.contains(permission), "{permission}");
            assert!(
                website.iter().all(|c| !c.contains(permission)),
                "{permission}"
            );
        }
        assert!(require_toolbar(crate::toolbar::CONTENT).is_err());
    }

    #[test]
    fn a_failed_manual_check_is_an_error_and_keeps_what_was_known() {
        let state = UpdateState::default();
        state.record(&v("0.1.3"), v("0.1.4"));
        let url = fake_release_page(Some("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
        assert!(check_now(&state, &v("0.1.3"), &url, None, Duration::from_secs(2)).is_err());
        assert_eq!(state.newer_version(), Some("0.1.4".to_string()));
    }

    #[test]
    fn a_page_that_does_not_redirect_is_a_failed_check() {
        let url = fake_release_page(Some("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
        assert!(fetch_latest(&url, "fenbi-desktop/test", None, Duration::from_secs(2)).is_err());
    }

    #[test]
    fn a_silent_server_fails_the_check_at_the_timeout() {
        let url = fake_release_page(None);
        let started = std::time::Instant::now();
        assert!(
            fetch_latest(&url, "fenbi-desktop/test", None, Duration::from_millis(300)).is_err()
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    /// `scutil --proxy` 在系统设置里开着 HTTPS 代理（Clash 这类软件设的样子）时的输出。
    const SCUTIL_ON: &str = "<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : localhost
    3 : *.local
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}
";

    fn uri(text: &str) -> ureq::http::Uri {
        text.parse().unwrap()
    }

    #[test]
    fn the_macos_https_proxy_is_read_from_system_settings() {
        let proxy = proxy_from_scutil(SCUTIL_ON).expect("开着 HTTPS 代理");
        assert_eq!(proxy.protocol(), ureq::ProxyProtocol::Http);
        assert_eq!(proxy.host(), "127.0.0.1");
        assert_eq!(proxy.port(), 7890);
        assert!(!proxy.is_no_proxy(&uri(RELEASES_URL)), "GitHub 走代理");
    }

    #[test]
    fn hosts_excluded_in_system_settings_skip_the_macos_proxy() {
        let proxy = proxy_from_scutil(SCUTIL_ON).unwrap();
        for target in [
            "http://127.0.0.1:8850/releases/latest",
            "http://localhost/",
            "http://printer.local/",
        ] {
            assert!(proxy.is_no_proxy(&uri(target)), "{target}");
        }
    }

    #[test]
    fn no_macos_proxy_when_https_proxy_is_off_or_incomplete() {
        let cases = [
            // 这台开发机上的真实输出：代理全关着
            "<dictionary> {\n  FTPPassive : 1\n  HTTPEnable : 0\n  HTTPSEnable : 0\n  ProxyAutoConfigEnable : 0\n  SOCKSEnable : 0\n}\n",
            // 关掉后系统仍留着上次填的地址和端口
            "<dictionary> {\n  HTTPSEnable : 0\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n}\n",
            // 只开了 HTTP 代理：系统对 HTTPS 请求不用它
            "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 0\n}\n",
            // 开着但没填地址
            "<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n}\n",
            // 只有某块网卡自己的设置：最外层才是生效的那份
            "<dictionary> {\n  HTTPSEnable : 0\n  __SCOPED__ : <dictionary> {\n    en0 : <dictionary> {\n      HTTPSEnable : 1\n      HTTPSPort : 7890\n      HTTPSProxy : 127.0.0.1\n    }\n  }\n}\n",
            // 读出来的不是这个格式
            "",
            "scutil: command not found",
        ];
        for output in cases {
            assert!(proxy_from_scutil(output).is_none(), "{output}");
        }
    }

    #[test]
    fn a_proxy_from_the_environment_wins_and_system_settings_are_not_read() {
        let from_env = ureq::Proxy::new("http://10.0.0.1:1080").unwrap();
        let picked = pick_proxy(Some(from_env), || {
            panic!("有环境变量里的代理时不读系统设置")
        })
        .unwrap();
        assert_eq!(picked.host(), "10.0.0.1");

        let from_system = ureq::Proxy::new("http://127.0.0.1:7890").unwrap();
        let picked = pick_proxy(None, || Some(from_system)).unwrap();
        assert_eq!(picked.host(), "127.0.0.1");

        assert!(pick_proxy(None, || None).is_none(), "都没有就直连");
    }

    /// 读到一个请求头结束（空行）为止。请求可能分几次写过来。
    fn read_head(stream: &mut std::net::TcpStream) -> String {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).is_ok_and(|n| n == 1) {
            head.push(byte[0]);
        }
        String::from_utf8_lossy(&head).into_owned()
    }

    /// 本机假代理：收下 CONNECT 请求、答应建隧道，再在隧道里回 `response`。
    /// 返回代理地址，和一个能取到它收到的 CONNECT 请求行的接收端。
    fn fake_connect_proxy(response: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let connect = read_head(&mut stream);
            let _ = sender.send(connect.lines().next().unwrap_or_default().to_string());
            let _ = stream.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n");
            read_head(&mut stream);
            let _ = stream.write_all(response.as_bytes());
        });
        (address, receiver)
    }

    #[test]
    fn a_check_goes_through_the_proxy_it_is_given() {
        let (proxy, connects) = fake_connect_proxy(
            "HTTP/1.1 302 Found\r\nLocation: /windery/fenbi-desktop/releases/tag/v9.9.9\r\nContent-Length: 0\r\n\r\n",
        );
        let found = fetch_latest(
            "http://releases.invalid/windery/fenbi-desktop/releases/latest",
            "fenbi-desktop/test",
            Some(ureq::Proxy::new(&proxy).unwrap()),
            Duration::from_secs(2),
        );
        assert_eq!(found, Ok(v("9.9.9")));
        assert_eq!(
            connects.recv_timeout(Duration::from_secs(1)).unwrap(),
            "CONNECT releases.invalid:80 HTTP/1.1"
        );
    }
}
