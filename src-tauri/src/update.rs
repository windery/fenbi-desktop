//! 检查更新：问 GitHub「本仓库最新发布是哪一版」，比本机新就记下来，工具栏据此画红点。
//!
//! 只读一个版本号。不下载、不安装，结果只活在内存里。
//! 请求的是发布页网址本身：GitHub 用一次跳转回答，跳转地址末尾就是最新发布的 tag。
//! 草稿和预发布不会成为这个跳转的目标。
use super::toolbar::require_toolbar;
use semver::Version;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

/// 发布页。检查更新请求它，下载新版也只打开它。
pub const RELEASES_URL: &str = "https://github.com/windery/fenbi-desktop/releases/latest";

const TIMEOUT: Duration = Duration::from_secs(8);

/// 比本机新的那个版本；没有或还没查到就是空。
#[derive(Default)]
pub struct UpdateState {
    newer: Mutex<Option<Version>>,
}

impl UpdateState {
    pub fn has_update(&self) -> bool {
        self.newer.lock().is_ok_and(|v| v.is_some())
    }

    /// 已知的新版本号（不带 `v`）；没有就是空。
    pub fn newer_version(&self) -> Option<String> {
        self.newer.lock().ok()?.as_ref().map(Version::to_string)
    }

    /// 记下一次检查的结果，返回这次是否查到了新版。
    fn record(&self, current: &Version, latest: Version) -> bool {
        if latest <= *current {
            return false;
        }
        if let Ok(mut newer) = self.newer.lock() {
            *newer = Some(latest);
        }
        true
    }
}

/// 从跳转地址（`…/releases/tag/v0.1.4`）读出版本号。读不出来就当作没有新版。
fn version_from_location(location: &str) -> Option<Version> {
    let (_, tag) = location.rsplit_once("/releases/tag/")?;
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

fn fetch_latest(url: &str, user_agent: &str, timeout: Duration) -> Result<Version, String> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .max_redirects(0)
            .max_redirects_will_error(false)
            .http_status_as_error(false)
            .timeout_global(Some(timeout))
            .user_agent(user_agent)
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
    timeout: Duration,
) -> Result<Option<String>, String> {
    let latest = fetch_latest(url, &format!("fenbi-desktop/{current}"), timeout)?;
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

/// 「检查更新」按钮。联网放在后台线程，查到新版就让工具栏补上红点。
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
            TIMEOUT,
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .inspect_err(|e| eprintln!("[fenbi-wrapper] 检查更新失败：{e}"))?;
    if found.is_some() {
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
        match fetch_latest(&check_url(), &user_agent, TIMEOUT) {
            Ok(latest) => {
                if app.state::<UpdateState>().record(&current, latest)
                    && let Some(view) = app.get_webview(super::toolbar::TOOLBAR)
                {
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
            assert_eq!(state.has_update(), expected, "{latest}");
        }
    }

    #[test]
    fn nothing_is_an_update_before_a_check_finishes() {
        assert!(!UpdateState::default().has_update());
    }

    #[test]
    fn a_redirecting_release_page_yields_its_version() {
        let url = fake_release_page(Some(
            "HTTP/1.1 302 Found\r\nLocation: https://github.com/windery/fenbi-desktop/releases/tag/v9.9.9\r\nContent-Length: 0\r\n\r\n",
        ));
        assert_eq!(
            fetch_latest(&url, "fenbi-desktop/test", Duration::from_secs(2)),
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
            timeout,
        );
        assert_eq!(found, Ok(Some("0.1.4".to_string())));
        assert_eq!(state.newer_version(), Some("0.1.4".to_string()));

        let state = UpdateState::default();
        let found = check_now(&state, &v("0.1.3"), &fake_release_page(Some(SAME)), timeout);
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
        assert!(check_now(&state, &v("0.1.3"), &url, Duration::from_secs(2)).is_err());
        assert_eq!(state.newer_version(), Some("0.1.4".to_string()));
    }

    #[test]
    fn a_page_that_does_not_redirect_is_a_failed_check() {
        let url = fake_release_page(Some("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
        assert!(fetch_latest(&url, "fenbi-desktop/test", Duration::from_secs(2)).is_err());
    }

    #[test]
    fn a_silent_server_fails_the_check_at_the_timeout() {
        let url = fake_release_page(None);
        let started = std::time::Instant::now();
        assert!(fetch_latest(&url, "fenbi-desktop/test", Duration::from_millis(300)).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
