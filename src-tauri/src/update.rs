//! 检查更新：问 GitHub「本仓库最新发布是哪一版」，比本机新就记下来，工具栏据此画红点。
//!
//! 只读一个版本号。不下载、不安装，结果只活在内存里。
//! 请求的是发布页网址本身：GitHub 用一次跳转回答，跳转地址末尾就是最新发布的 tag。
//! 草稿和预发布不会成为这个跳转的目标。
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
