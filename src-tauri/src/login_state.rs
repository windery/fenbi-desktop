//! 登录决策与路由分类的**纯逻辑**。
//!
//! 这里不碰 WebView、不读文件、不睡觉，所以全部可以单元测试。
//! `lib.rs` 只负责把外部世界（cookie、文件、窗口 URL、页面加载事件）翻译成
//! 这里的输入，再照返回的动作执行。
//!
//! ## 术语：登录态的三个层次
//!
//! | 层次 | 谁提供 | 含义 |
//! | --- | --- | --- |
//! | 登录记录 | 本地缓存文件 | "上次观测到的是已登录"，会过期 |
//! | 本地凭证信号 | [`Credentials`] | 现在能不能在本地看到登录 cookie |
//! | 网站真实会话 | 站点服务端 | 只有站点知道，wrapper 观测不到 |
//!
//! 本模块判定的只是前两层。**凭证存在不等于已登录**，所以所有对外措辞都不写
//! "已验证登录"，只写"观测到凭证"。

use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// 登录 cookie 的名字。
///
/// 认**任一**存在，因为三者生命周期不同：
///   * `persistent` —— 落盘的长期凭证（`Max-Age=31536000`），跨重启登录状态的真正来源
///   * `sess` / `userid` —— 会话级，**从不落盘**，冷启动时由 `persistent` 现场换取
///
/// 只看 `sess`：页面没重载时它可能一直不存在，据此判定"已登出"会误报。
/// 只看 `persistent`：若某次登录没下发它而 `sess` 有效，会误判成未登录。
pub const LOGIN_COOKIE_NAMES: [&str; 3] = ["persistent", "sess", "userid"];

/// 本地凭证信号。**不是**"网站是否认可这个会话"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Credentials {
    /// 读到了已知的登录 cookie 名字
    Present,
    /// 读取成功，但没有登录 cookie
    Absent,
    /// 读取失败——保持未知，**不能当成登出**
    Unknown,
}

/// 把一次 cookie 读取的结果映射成凭证信号。
///
/// `Err` 表示读取本身失败（窗口还没建好、WebView 调用出错）。把它映射成
/// `Absent` 会把一次读取故障写进登录记录并弹登录框，所以单独成一态。
pub fn credentials_from(cookie_names: Result<Vec<String>, ()>) -> Credentials {
    match cookie_names {
        Ok(names) => {
            if names
                .iter()
                .any(|n| LOGIN_COOKIE_NAMES.contains(&n.as_str()))
            {
                Credentials::Present
            } else {
                Credentials::Absent
            }
        }
        Err(()) => Credentials::Unknown,
    }
}

/// 解析登录记录文件的内容。内容不认识时返回 `None`（当作没有记录）。
pub fn parse_login_flag(text: &str) -> Option<bool> {
    match text.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// 序列化登录记录文件的内容。
pub fn format_login_flag(logged_in: bool) -> &'static str {
    if logged_in {
        "true"
    } else {
        "false"
    }
}

/// 回环地址：本地模拟站用的 host。两种 IPv6 写法都收，因为 JS 侧
/// `location.hostname` 带方括号、Rust 侧 `Url::host_str` 不一定。
fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

/// 入口 URL 的放行策略。
///
/// 窗口入口来自 `FENBI_ENTRY_URL` / `FENBI_PRACTICE_URL` 环境变量，直接喂给
/// WebView。这里只放行明文 HTTPS，外加回环地址的 HTTP（本地模拟站点用）。
/// 其余 scheme（`file:`、`javascript:`、`data:` …）一律拒绝。
///
/// 参数由调用方用真正的 URL 解析器拆好，避免手写解析被绕过。
pub fn entry_url_policy(scheme: &str, host: Option<&str>) -> Result<(), String> {
    let host = host.unwrap_or("");
    match scheme {
        "https" if !host.is_empty() => Ok(()),
        "https" => Err("入口 URL 缺少主机名".to_string()),
        "http" if is_loopback_host(host) => Ok(()),
        "http" => Err(format!("http 只允许回环地址，收到 host={host:?}")),
        other => Err(format!(
            "不支持的 scheme: {other:?}（只允许 https，回环地址可用 http）"
        )),
    }
}

/// 这个 host 是不是粉笔（含任意子域）。
fn is_fenbi_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "fenbi.com" || host.ends_with(".fenbi.com")
}

/// 「新窗口请求」的放行策略——`window.open` / `target="_blank"` 的目标算不算站内。
///
/// 桌面端只有一扇窗口：站内的新窗口请求由 `lib.rs` 改成**在当前窗口打开**，
/// 站外的直接丢弃，页面停在原地（没有地址栏，被带走就回不来了）。
///
/// 为什么必须有这个判断：Tauri 在没有 `on_new_window` handler 时会**丢掉所有**
/// 新窗口请求。粉笔搜题正是 `window.open("/spa/tiku/guide/question/search?...",
/// "_blank")`（实测），于是搜索点了没反应。相对 URL 由 WebView 解析成绝对地址后
/// 才进这里，所以拿到的一定是带 host 的地址。
///
/// 放行范围与 `entry_url_policy` 一致：https + 粉笔域名，回环地址额外允许 http。
pub fn new_window_allowed(scheme: &str, host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    match scheme {
        "https" => is_fenbi_host(host),
        "http" => is_loopback_host(host),
        _ => false,
    }
}

/// 页面加载「静止」之后做一次权威判定，该执行什么动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettleAction {
    /// 记录改写为 true。`notify_page` 时还要通知页面：启动路径可能已按过期的
    /// 记录排好了一个弹框，得让它取消。
    LoggedIn { notify_page: bool },
    /// 记录改写为 false；`notify_page` 时通知页面弹登录框。
    LoggedOut { notify_page: bool },
    /// 证据不足，保持现状——不写记录、不弹框。
    Keep,
}

/// 页面加载完成（并等站点恢复会话）后的判定。
///
/// 这是启动路径唯一的权威判定：此刻站点已经用 `persistent` 把 `sess` 换出来了，
/// 所以读到的是它能给的最好证据。
pub fn settle_action(creds: Credentials, recorded: Option<bool>) -> SettleAction {
    match creds {
        // 读取失败：保持未知。不覆盖记录，也不据此弹框。
        Credentials::Unknown => SettleAction::Keep,
        // 观测到凭证：记录纠正为 true；记录原本不是 true 才需要通知页面取消弹框。
        Credentials::Present => SettleAction::LoggedIn {
            notify_page: recorded != Some(true),
        },
        // 观测不到凭证：记录改 false。
        // 只有"记录说已登录"才需要提示——记录本来就是 false 时启动路径已经弹过了，
        // 再弹一次就是重复通知。
        Credentials::Absent => SettleAction::LoggedOut {
            notify_page: recorded == Some(true),
        },
    }
}

/// 常驻心跳复查时该执行什么动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeartbeatAction {
    /// 没有新信息
    Nothing,
    /// 之前观测到已登录，现在凭证没了——通知页面弹登录框
    SessionGone,
    /// 之前没观测到、现在观测到了
    SessionPresent,
}

/// 心跳复查的判定。`observed` 是上一次的判定结果（`None` 表示还没判定过）。
pub fn heartbeat_action(observed: Option<bool>, creds: Credentials) -> HeartbeatAction {
    match (observed, creds) {
        // 读取失败不改变任何状态——尤其不能当成登出。
        (_, Credentials::Unknown) => HeartbeatAction::Nothing,
        (Some(true), Credentials::Absent) => HeartbeatAction::SessionGone,
        (Some(false), Credentials::Present) | (None, Credentials::Present) => {
            HeartbeatAction::SessionPresent
        }
        _ => HeartbeatAction::Nothing,
    }
}

/// 页面加载信号：既记代号，又让心跳线程可以被唤醒。
///
/// 心跳平时睡五分钟。若期间发生页面加载（SPA 重载、站点跳转），判定必须立刻
/// 重新起算，而不是等这一觉睡满——否则新页面加载后最长五分钟内没有任何判定。
pub struct PageLoadSignal {
    gen: Mutex<u64>,
    cv: Condvar,
}

impl PageLoadSignal {
    pub fn new() -> Self {
        Self {
            gen: Mutex::new(0),
            cv: Condvar::new(),
        }
    }

    /// 记录一次页面加载，并唤醒正在等待的线程。
    pub fn bump(&self) {
        let mut gen = self.lock();
        *gen += 1;
        self.cv.notify_all();
    }

    /// 当前代号。调用方拿它当"我已经处理到哪一代"的基准。
    pub fn current(&self) -> u64 {
        *self.lock()
    }

    /// 最多等 `timeout_ms`。期间发生页面加载就提前返回 `true`。
    ///
    /// 返回 `true` 表示调用方应立即回到循环顶部重新判定，不要再执行心跳。
    pub fn wait_for_load(&self, seen: u64, timeout_ms: u64) -> bool {
        let gen = self.lock();
        if *gen != seen {
            return true;
        }
        let (gen, _) = self
            .cv
            .wait_timeout_while(gen, Duration::from_millis(timeout_ms), |g| *g == seen)
            .unwrap_or_else(|e| e.into_inner());
        *gen != seen
    }

    /// 锁中毒时取回内部值继续用：这里的数据只是一个计数器，没有需要保护的不变量。
    fn lock(&self) -> std::sync::MutexGuard<'_, u64> {
        self.gen.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Default for PageLoadSignal {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Result<Vec<String>, ()> {
        Ok(list.iter().map(|s| s.to_string()).collect())
    }

    // ── 凭证三态 ────────────────────────────────────────────────

    #[test]
    fn cookie_read_failure_is_unknown_not_absent() {
        assert_eq!(credentials_from(Err(())), Credentials::Unknown);
    }

    #[test]
    fn any_login_cookie_counts_as_present() {
        for name in LOGIN_COOKIE_NAMES {
            assert_eq!(credentials_from(names(&[name])), Credentials::Present);
            assert_eq!(
                credentials_from(names(&["other", name, "another"])),
                Credentials::Present
            );
        }
    }

    #[test]
    fn unrelated_cookies_are_absent() {
        assert_eq!(credentials_from(names(&[])), Credentials::Absent);
        assert_eq!(
            credentials_from(names(&["theme", "lang"])),
            Credentials::Absent
        );
    }

    // ── 记录文件 ────────────────────────────────────────────────

    #[test]
    fn login_flag_roundtrip() {
        for value in [true, false] {
            assert_eq!(parse_login_flag(format_login_flag(value)), Some(value));
        }
    }

    #[test]
    fn login_flag_tolerates_whitespace_but_rejects_junk() {
        assert_eq!(parse_login_flag("  true\n"), Some(true));
        assert_eq!(parse_login_flag("false "), Some(false));
        // 截断、损坏、被别的程序改过 —— 都当作"没有记录"，而不是某种登录态。
        assert_eq!(parse_login_flag(""), None);
        assert_eq!(parse_login_flag("tru"), None);
        assert_eq!(parse_login_flag("1"), None);
    }

    // ── 入口 URL 策略 ──────────────────────────────────────────

    #[test]
    fn entry_url_policy_allows_https_and_loopback_http() {
        assert!(entry_url_policy("https", Some("www.fenbi.com")).is_ok());
        assert!(entry_url_policy("https", Some("spa.fenbi.com")).is_ok());
        assert!(entry_url_policy("http", Some("127.0.0.1")).is_ok());
        assert!(entry_url_policy("http", Some("localhost")).is_ok());
    }

    #[test]
    fn entry_url_policy_rejects_everything_else() {
        // 明文 http 指向外部主机：拒绝（否则入口可被环境变量指向任意站点）
        assert!(entry_url_policy("http", Some("evil.example")).is_err());
        // 伪装成回环的域名：host 解析后不是回环，拒绝
        assert!(entry_url_policy("http", Some("127.0.0.1.evil.example")).is_err());
        // 能执行代码或读本地文件的 scheme
        assert!(entry_url_policy("javascript", None).is_err());
        assert!(entry_url_policy("file", None).is_err());
        assert!(entry_url_policy("data", Some("example.com")).is_err());
        // 没有主机名的 https
        assert!(entry_url_policy("https", None).is_err());
    }

    // ── 新窗口请求策略 ─────────────────────────────────────────

    #[test]
    fn new_window_requests_inside_fenbi_are_allowed() {
        for host in [
            "fenbi.com",
            "www.fenbi.com",
            "spa.fenbi.com",
            "login.fenbi.com",
            "tiku.fenbi.com",
        ] {
            assert!(new_window_allowed("https", Some(host)), "{host} 应放行");
        }
        // 大小写不敏感，容忍结尾点
        assert!(new_window_allowed("https", Some("WWW.Fenbi.COM")));
        assert!(new_window_allowed("https", Some("www.fenbi.com.")));
        // 本地模拟站（对着假站点验证用）
        assert!(new_window_allowed("http", Some("127.0.0.1")));
        assert!(new_window_allowed("http", Some("localhost")));
    }

    #[test]
    fn new_window_requests_outside_fenbi_are_dropped() {
        // 伪装成粉笔子域的域名：不是粉笔
        assert!(!new_window_allowed("https", Some("fenbi.com.evil.example")));
        assert!(!new_window_allowed("https", Some("notfenbi.com")));
        assert!(!new_window_allowed("https", Some("evil.example")));
        // 明文 http 指向粉笔：站点不会这么用，拒绝更安全
        assert!(!new_window_allowed("http", Some("www.fenbi.com")));
        // 能执行代码或读本地文件的 scheme
        assert!(!new_window_allowed("javascript", None));
        assert!(!new_window_allowed("file", None));
        assert!(!new_window_allowed("data", Some("fenbi.com")));
        assert!(!new_window_allowed("about", Some("blank")));
        // 没有主机名
        assert!(!new_window_allowed("https", None));
    }

    // ── 页面加载后的判定 ───────────────────────────────────────

    #[test]
    fn unknown_credentials_never_change_anything() {
        for recorded in [None, Some(true), Some(false)] {
            assert_eq!(
                settle_action(Credentials::Unknown, recorded),
                SettleAction::Keep
            );
            assert_eq!(
                heartbeat_action(recorded, Credentials::Unknown),
                HeartbeatAction::Nothing
            );
        }
    }

    #[test]
    fn stale_true_record_without_credentials_prompts() {
        // 文档验收矩阵：缓存 true、凭证没了 -> 提示（不分页面，练习区也一样）
        assert_eq!(
            settle_action(Credentials::Absent, Some(true)),
            SettleAction::LoggedOut { notify_page: true }
        );
        // 记录本来就是 false —— 启动路径已经弹过框了，不再重复弹
        assert_eq!(
            settle_action(Credentials::Absent, Some(false)),
            SettleAction::LoggedOut { notify_page: false }
        );
        // 没有记录（首次启动）—— 同上，不重复弹
        assert_eq!(
            settle_action(Credentials::Absent, None),
            SettleAction::LoggedOut { notify_page: false }
        );
    }

    #[test]
    fn credentials_present_corrects_a_stale_false_record_by_notifying_the_page() {
        // 记录 false 但凭证在：启动路径可能已排好弹框，必须通知页面取消
        assert_eq!(
            settle_action(Credentials::Present, Some(false)),
            SettleAction::LoggedIn { notify_page: true }
        );
        assert_eq!(
            settle_action(Credentials::Present, None),
            SettleAction::LoggedIn { notify_page: true }
        );
        // 记录已是 true：没有待取消的弹框
        assert_eq!(
            settle_action(Credentials::Present, Some(true)),
            SettleAction::LoggedIn { notify_page: false }
        );
    }

    // ── 心跳 ──────────────────────────────────────────────────

    #[test]
    fn heartbeat_detects_session_loss() {
        assert_eq!(
            heartbeat_action(Some(true), Credentials::Absent),
            HeartbeatAction::SessionGone
        );
    }

    #[test]
    fn heartbeat_reports_new_credentials_once() {
        for observed in [None, Some(false)] {
            assert_eq!(
                heartbeat_action(observed, Credentials::Present),
                HeartbeatAction::SessionPresent
            );
        }
        // 已经是 true 了，没有新信息
        assert_eq!(
            heartbeat_action(Some(true), Credentials::Present),
            HeartbeatAction::Nothing
        );
        // 一直没凭证
        assert_eq!(
            heartbeat_action(Some(false), Credentials::Absent),
            HeartbeatAction::Nothing
        );
    }

    // ── 可唤醒等待 ────────────────────────────────────────────

    #[test]
    fn wait_returns_immediately_when_a_load_already_happened() {
        let signal = PageLoadSignal::new();
        signal.bump();
        let started = std::time::Instant::now();
        assert!(signal.wait_for_load(0, 5_000));
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn wait_times_out_on_its_own_without_a_load() {
        let signal = PageLoadSignal::new();
        assert!(!signal.wait_for_load(signal.current(), 30));
    }

    #[test]
    fn a_page_load_wakes_a_sleeping_waiter() {
        use std::sync::Arc;
        let signal = Arc::new(PageLoadSignal::new());
        let seen = signal.current();

        let bumper = {
            let signal = Arc::clone(&signal);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                signal.bump();
            })
        };

        let started = std::time::Instant::now();
        // 心跳间隔故意设得远大于唤醒时间：没有唤醒就要睡满 5 分钟
        assert!(signal.wait_for_load(seen, 5 * 60 * 1000));
        let waited = started.elapsed();
        bumper.join().expect("唤醒线程 panic");
        assert!(
            waited < Duration::from_secs(2),
            "等待没有被打断，等了 {waited:?}"
        );
    }

    #[test]
    fn consecutive_loads_are_reported_once_each() {
        let signal = PageLoadSignal::new();
        assert_eq!(signal.current(), 0);
        signal.bump();
        signal.bump();
        assert_eq!(signal.current(), 2);
        assert!(!signal.wait_for_load(2, 10));
    }
}
