//! 登录决策与路由分类的**纯逻辑**。
//!
//! 这里不碰 WebView、不读文件、不睡觉，所以全部可以单元测试。
//! `lib.rs` 只负责把外部世界（cookie、文件、窗口 URL、页面加载事件）翻译成
//! 这里的输入，再照返回的动作执行。
//!
//! ## 术语：登录态的两个层次
//!
//! | 层次 | 谁提供 | 含义 |
//! | --- | --- | --- |
//! | 本地凭证信号 | [`Credentials`] | 现在能不能在本地看到登录 cookie |
//! | 网站真实会话 | 站点服务端 | 只有站点知道，wrapper 观测不到 |
//!
//! 本模块判定的只是第一层，而且结果只活在内存里、不落盘。**凭证存在不等于已登录**，
//! 所以所有对外措辞都不写"已验证登录"，只写"观测到凭证"。

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

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

/// 回环地址：本地模拟站用的 host。两种 IPv6 写法都收，因为 JS 侧
/// `location.hostname` 带方括号、Rust 侧 `Url::host_str` 不一定。
fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

/// 入口 URL 的放行策略。
///
/// 窗口入口来自 `FENBI_ENTRY_URL` / `FENBI_PRACTICE_URL` 环境变量，直接喂给
/// WebView，所以按 scheme 把关：任意 HTTPS 主机都放行，回环地址额外允许 HTTP
/// （本地模拟站点用）。其余 scheme（`file:`、`javascript:`、`data:` …）一律拒绝。
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
/// 放行范围比 `entry_url_policy` 窄：入口允许任意 HTTPS 主机，这里还要求
/// host 是粉笔（含子域），因为新窗口请求来自页面里的任意链接；回环地址额外
/// 允许 http。
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

/// 页面加载阶段。`Navigating` 表示新页面已开始加载、还没完成——此时旧观察作废，
/// 也不能读凭证。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoadPhase {
    Navigating,
    Settled,
}

/// 给页面的最终判定。`Pending` 表示当前页面还没有有效观察结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageDecision {
    Pending,
    LoggedIn,
    LoggedOut,
}

impl PageDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            PageDecision::Pending => "pending",
            PageDecision::LoggedIn => "logged-in",
            PageDecision::LoggedOut => "logged-out",
        }
    }
}

/// `Finished` 之后留出的观察窗口。
///
/// ⚠️ 这只是"给站点一点时间把会话恢复出来"的观察窗口，**不是**站点会话恢复
/// 完成的保证。窗口到期后读取失败（Unknown）会继续重试；读完得到 `Absent` 也
/// 只是这一次的本地观察，网站真实会话仍可能不同步。
const SETTLE_MS: u64 = 1500;

/// 读凭证失败（Unknown）后的重试间隔。Unknown 不改判定、不通知，只重试。
const RETRY_MS: u64 = 500;

/// 调度器要求的下一步动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchStep {
    /// 等新页面加载事件；没有事件就什么都别做。
    WaitForLoad,
    /// 等到 `at_ms`，或者提前被加载事件唤醒。
    WaitUntil { at_ms: u64 },
    /// 现在读一次凭证；回来把 `token` 交回 [`WatchMachine::on_read`]。
    ReadCredentials { token: u64 },
}

/// 调度器产出的外部动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchAction {
    /// 改写页面判定；`notify` 为真时还要提醒页面重读快照。
    Decide {
        decision: PageDecision,
        notify: bool,
    },
}

/// 登录观察的纯调度状态机（不加锁）。
///
/// 所有时间都是调用方给的毫秒数（生产里是自线程启动起的毫秒），所以测试能用
/// 一个可控时钟直接驱动**同一份**状态机，而不是复制一份逻辑。
///
/// 不变量：
///   * `Navigating` 期间不读凭证、不心跳；
///   * 只有 `Settled`（Finished）之后才起观察窗口，初始未 Finished 一律不读；
///   * 读凭证是外部动作，结果回来时必须核对代号，旧页面的结果一律丢弃；
///   * `Unknown` 不改判定、不通知，只安排重试，并保留上一次观察结果。
struct WatchMachine {
    /// 外部已经处理到哪一代页面；每次 Started 都是新的一代。
    generation: u64,
    phase: LoadPhase,
    /// 下一次观察（settle 或 Unknown 重试）的时刻。
    deadline_ms: Option<u64>,
    /// 下一次心跳的时刻。
    heartbeat_ms: Option<u64>,
    decision: PageDecision,
    /// 已经发出 `ReadCredentials`、还没回结果。
    awaiting_read: bool,
    heartbeat_interval_ms: u64,
}

impl WatchMachine {
    fn new(heartbeat_interval_ms: u64) -> Self {
        Self {
            generation: 0,
            phase: LoadPhase::Navigating,
            deadline_ms: None,
            heartbeat_ms: None,
            decision: PageDecision::Pending,
            awaiting_read: false,
            heartbeat_interval_ms,
        }
    }

    /// 页面 Started：代号前进，暂停一切观察与心跳，判定回到 Pending。
    fn begin_navigation(&mut self) {
        self.generation += 1;
        self.phase = LoadPhase::Navigating;
        self.deadline_ms = None;
        self.heartbeat_ms = None;
        self.awaiting_read = false;
        self.decision = PageDecision::Pending;
    }

    /// 页面 Finished：只有此刻才允许起 1500ms 观察窗口。
    ///
    /// 没有 Started 的 Finished（`generation == 0`）忽略，保证"初始未 Finished 不读"。
    fn settle(&mut self, now_ms: u64) {
        if self.generation == 0 || self.phase == LoadPhase::Settled {
            return;
        }
        self.phase = LoadPhase::Settled;
        self.deadline_ms = Some(now_ms + SETTLE_MS);
        self.heartbeat_ms = None;
    }

    /// 调度器现在该做什么。
    fn poll(&mut self, now_ms: u64) -> WatchStep {
        if self.awaiting_read {
            // 读还在路上；外部会先把结果交回 on_read，不会重复问。
            return WatchStep::WaitForLoad;
        }
        if let Some(at) = self.deadline_ms {
            if now_ms >= at {
                self.awaiting_read = true;
                return WatchStep::ReadCredentials {
                    token: self.generation,
                };
            }
            return WatchStep::WaitUntil { at_ms: at };
        }
        if let Some(at) = self.heartbeat_ms {
            if now_ms >= at {
                self.awaiting_read = true;
                return WatchStep::ReadCredentials {
                    token: self.generation,
                };
            }
            return WatchStep::WaitUntil { at_ms: at };
        }
        WatchStep::WaitForLoad
    }

    /// 一次凭证读取的结果。`token` 是 `poll` 给出的代号。
    ///
    /// 读 cookie 可能很慢，结果回来时页面可能已经换了一代：这时直接丢弃，
    /// 旧结果不能通知新页面。
    fn on_read(&mut self, token: u64, creds: Credentials, now_ms: u64) -> Vec<WatchAction> {
        self.awaiting_read = false;
        if token != self.generation {
            return Vec::new();
        }
        match creds {
            Credentials::Unknown => {
                // 读取失败：保持未知，不通知，过一会儿再试。
                // 上一次的观察结果原样保留，但不声称它仍是真实的网站会话。
                self.heartbeat_ms = None;
                self.deadline_ms = Some(now_ms + RETRY_MS);
                Vec::new()
            }
            Credentials::Present => self.record(true, now_ms),
            Credentials::Absent => self.record(false, now_ms),
        }
    }

    fn record(&mut self, present: bool, now_ms: u64) -> Vec<WatchAction> {
        let decision = if present {
            PageDecision::LoggedIn
        } else {
            PageDecision::LoggedOut
        };
        let mut actions = Vec::new();
        if self.decision != decision {
            self.decision = decision;
            actions.push(WatchAction::Decide {
                decision,
                notify: true,
            });
        }
        self.deadline_ms = None;
        self.heartbeat_ms = Some(now_ms + self.heartbeat_interval_ms);
        actions
    }
}

/// `next_step` 的返回值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchPoll {
    /// 现在读一次凭证；回来把 `token` 交给 `finish_read`。读发生在锁外。
    Read { token: u64 },
    /// 先睡；`version` 变化（新页面开始/完成、窗口销毁）或超时后回到 `next_step`。
    Wait {
        version: u64,
        timeout_ms: Option<u64>,
    },
    /// 窗口已销毁，watcher 退出。
    Stop,
}

/// 页面代号/阶段、调度状态机与判定快照的**唯一**同步状态。
///
/// 一把锁同时保护三者，一个 Condvar 让 watcher 能被页面加载或窗口销毁唤醒。
/// 锁内只做纯内存操作；cookie 读取与任何 WebView 调用（eval）一律在锁外。
/// `finish_read` 在锁内核对代号与 `stopped`，所以有效结果更新快照与 Started
/// 线性化，过期结果和窗口销毁后的结果直接丢弃。
pub struct WatchShared {
    inner: Mutex<Inner>,
    cv: Condvar,
    /// 生产的毫秒时钟起点。
    start: Instant,
}

struct Inner {
    machine: WatchMachine,
    /// 给页面重读的快照序号；每次判定变化或新页面开始都前进。
    seq: u64,
    decision: PageDecision,
    /// 等待谓词用的版本号；任何可能唤醒 watcher 的变化都让它前进。
    version: u64,
    stopped: bool,
}

impl WatchShared {
    pub fn new(heartbeat_interval_ms: u64) -> Self {
        Self {
            inner: Mutex::new(Inner {
                machine: WatchMachine::new(heartbeat_interval_ms),
                seq: 0,
                decision: PageDecision::Pending,
                version: 0,
                stopped: false,
            }),
            cv: Condvar::new(),
            start: Instant::now(),
        }
    }

    /// 自启动起的毫秒数；生产里页面回调与调度线程都用它。
    pub fn now_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    /// `Started`：立刻换代号、把快照清成 pending 并递增序号、暂停观察。
    pub fn on_started(&self) {
        {
            let mut inner = self.lock();
            inner.machine.begin_navigation();
            inner.seq += 1;
            inner.decision = PageDecision::Pending;
            inner.version += 1;
        }
        self.cv.notify_all();
    }

    /// `Finished`：允许 1500ms 后观察这一代页面。
    pub fn on_finished(&self, now_ms: u64) {
        {
            let mut inner = self.lock();
            inner.machine.settle(now_ms);
            inner.version += 1;
        }
        self.cv.notify_all();
    }

    /// 当前快照。`current_login_decision` 命令就是读它，不读 cookie。
    pub fn snapshot(&self) -> (u64, PageDecision) {
        let inner = self.lock();
        (inner.seq, inner.decision)
    }

    /// 下一步：要么在锁外读一次 cookie，要么等待超时/新事件。
    pub fn next_step(&self, now_ms: u64) -> WatchPoll {
        let mut inner = self.lock();
        if inner.stopped {
            return WatchPoll::Stop;
        }
        match inner.machine.poll(now_ms) {
            WatchStep::WaitForLoad => WatchPoll::Wait {
                version: inner.version,
                timeout_ms: None,
            },
            WatchStep::WaitUntil { at_ms } => WatchPoll::Wait {
                version: inner.version,
                timeout_ms: Some(at_ms.saturating_sub(now_ms)),
            },
            WatchStep::ReadCredentials { token } => WatchPoll::Read { token },
        }
    }

    /// 等到超时或状态变化（新页面开始/完成、窗口销毁）。
    ///
    /// 谓词保证不会丢唤醒：变化发生在进入 wait 之前时，这里会立刻返回。
    pub fn wait(&self, version: u64, timeout_ms: Option<u64>) {
        let inner = self.lock();
        match timeout_ms {
            Some(ms) => {
                let _ = self
                    .cv
                    .wait_timeout_while(inner, Duration::from_millis(ms), |i| i.version == version)
                    .unwrap_or_else(|e| e.into_inner());
            }
            None => {
                let _guard = self
                    .cv
                    .wait_while(inner, |i| i.version == version)
                    .unwrap_or_else(|e| e.into_inner());
            }
        }
    }

    /// 把一次锁外 cookie 读取的结果交回来。
    ///
    /// 锁内先核对代号与 `stopped`：结果回来时页面可能已经换了一代，或窗口
    /// 已经销毁，这两种情况都直接丢弃、不通知。有效结果在同一把锁里更新快照，
    /// 与 Started 线性化。返回 `true` 表示锁外应提醒页面重读快照。
    pub fn finish_read(&self, token: u64, creds: Credentials, now_ms: u64) -> bool {
        let mut inner = self.lock();
        if inner.stopped {
            // 窗口已销毁：在途结果一律丢弃，不通知。
            return false;
        }
        if token != inner.machine.generation {
            // 过期：Started 已经把这一代的观察作废了。
            return false;
        }
        let actions = inner.machine.on_read(token, creds, now_ms);
        let mut notify = false;
        for action in actions {
            let WatchAction::Decide {
                decision,
                notify: n,
            } = action;
            inner.seq += 1;
            inner.decision = decision;
            notify |= n;
        }
        inner.version += 1;
        notify
    }

    /// 窗口销毁：让 watcher 退出，不留下永远等 Condvar 的线程。
    pub fn stop(&self) {
        {
            let mut inner = self.lock();
            inner.stopped = true;
            inner.version += 1;
        }
        self.cv.notify_all();
    }

    /// 锁中毒时取回内部值继续用：这里没有需要跨 panic 保持的不变量。
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
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

    // ── 生产调度器：直接驱动 WatchShared ──────────────────────

    fn read_token(shared: &WatchShared, now_ms: u64) -> u64 {
        match shared.next_step(now_ms) {
            WatchPoll::Read { token } => token,
            other => panic!("预期读取凭证，得到 {other:?}"),
        }
    }

    #[test]
    fn wait_and_unnotified_reads_are_expected_before_finished() {
        let shared = WatchShared::new(60_000);
        // 初始（线程刚起、还没有任何 Finished）不读
        assert_eq!(shared.snapshot(), (0, PageDecision::Pending));
        assert_eq!(
            shared.next_step(0),
            WatchPoll::Wait {
                version: 0,
                timeout_ms: None
            }
        );

        // 慢加载：Started 之后、Finished 之前仍然不读
        shared.on_started();
        assert_eq!(shared.snapshot(), (1, PageDecision::Pending));
        assert_eq!(
            shared.next_step(10_000),
            WatchPoll::Wait {
                version: 1,
                timeout_ms: None
            }
        );
    }

    #[test]
    fn only_finished_starts_the_settle_window() {
        let shared = WatchShared::new(60_000);
        shared.on_started();
        shared.on_finished(0);
        // 1500ms 未到：等这 1ms
        assert_eq!(
            shared.next_step(SETTLE_MS - 1),
            WatchPoll::Wait {
                version: 2,
                timeout_ms: Some(1)
            }
        );
        // 窗口到了：读这一代页面
        assert_eq!(shared.next_step(SETTLE_MS), WatchPoll::Read { token: 1 });
    }

    #[test]
    fn unknown_never_decides_and_a_later_absent_prompts() {
        let shared = WatchShared::new(60_000);
        shared.on_started();
        shared.on_finished(0);
        let token = read_token(&shared, SETTLE_MS);
        let notify = shared.finish_read(token, Credentials::Unknown, SETTLE_MS);
        assert!(!notify, "Unknown 不新提示");
        assert_eq!(shared.snapshot(), (1, PageDecision::Pending));

        // Unknown 安排 500ms 后重试
        assert_eq!(
            shared.next_step(SETTLE_MS + RETRY_MS - 1),
            WatchPoll::Wait {
                version: 3,
                timeout_ms: Some(1)
            }
        );
        let token = read_token(&shared, SETTLE_MS + RETRY_MS);
        let notify = shared.finish_read(token, Credentials::Absent, SETTLE_MS + RETRY_MS);
        assert!(notify, "首次 Unknown 之后重试到 Absent 必须提示");
        assert_eq!(shared.snapshot(), (2, PageDecision::LoggedOut));
    }

    #[test]
    fn unknown_after_an_observation_keeps_the_last_decision_without_notifying() {
        let shared = WatchShared::new(1000);
        shared.on_started();
        shared.on_finished(0);
        let token = read_token(&shared, SETTLE_MS);
        assert!(shared.finish_read(token, Credentials::Present, SETTLE_MS));
        let before = shared.snapshot();

        let next = SETTLE_MS + 1000;
        let token = read_token(&shared, next);
        let notify = shared.finish_read(token, Credentials::Unknown, next);
        assert!(!notify, "已观察过，Unknown 不新提示");
        assert_eq!(shared.snapshot(), before, "Unknown 保留上次观察结果");
    }

    #[test]
    fn a_read_finishing_after_started_is_discarded() {
        let shared = WatchShared::new(60_000);
        shared.on_started();
        shared.on_finished(0);
        let stale_token = read_token(&shared, SETTLE_MS);

        // 读取还在路上，页面已经换了一代
        shared.on_started();
        assert_eq!(shared.snapshot(), (2, PageDecision::Pending));

        let notify = shared.finish_read(stale_token, Credentials::Present, SETTLE_MS + 10);
        assert!(!notify, "过期结果不通知");
        assert_eq!(shared.snapshot(), (2, PageDecision::Pending));

        // 新页面 Finished 之前不读，之后读的是新一代
        assert_eq!(
            shared.next_step(SETTLE_MS + 100),
            WatchPoll::Wait {
                version: 3,
                timeout_ms: None
            }
        );
        shared.on_finished(SETTLE_MS + 100);
        assert_eq!(
            read_token(&shared, SETTLE_MS + 100 + SETTLE_MS),
            2,
            "读的必须是新一代的 token"
        );
    }

    #[test]
    fn a_read_finishing_after_stop_is_discarded() {
        let shared = WatchShared::new(60_000);
        shared.on_started();
        shared.on_finished(0);
        let in_flight = read_token(&shared, SETTLE_MS);

        // 窗口已销毁：在途的读取结果回来时必须丢弃
        shared.stop();

        let notify = shared.finish_read(in_flight, Credentials::Present, SETTLE_MS);
        assert!(!notify, "stop 之后在途结果不通知");
        assert_eq!(shared.snapshot(), (1, PageDecision::Pending));
    }

    #[test]
    fn consecutive_loads_each_get_a_fresh_window() {
        let shared = WatchShared::new(60_000);
        shared.on_started();
        shared.on_finished(0);
        // 上一步的窗口还没到就又开始新页面
        shared.on_started();
        assert_eq!(shared.snapshot(), (2, PageDecision::Pending));
        // 新页面 Finished 之前不读
        assert_eq!(
            shared.next_step(SETTLE_MS),
            WatchPoll::Wait {
                version: 3,
                timeout_ms: None
            }
        );
        shared.on_finished(1000);
        assert_eq!(
            shared.next_step(1000 + SETTLE_MS - 1),
            WatchPoll::Wait {
                version: 4,
                timeout_ms: Some(1)
            }
        );
        assert_eq!(read_token(&shared, 1000 + SETTLE_MS), 2);
    }

    #[test]
    fn a_new_page_snapshot_is_pending_immediately() {
        let shared = WatchShared::new(60_000);
        shared.on_started();
        shared.on_finished(0);
        let token = read_token(&shared, SETTLE_MS);
        assert!(shared.finish_read(token, Credentials::Present, SETTLE_MS));
        assert_eq!(shared.snapshot(), (2, PageDecision::LoggedIn));

        // 新页面一开始就是 pending，不等 Finished
        shared.on_started();
        assert_eq!(shared.snapshot(), (3, PageDecision::Pending));
    }

    #[test]
    fn heartbeat_flips_between_present_and_absent() {
        let shared = WatchShared::new(1000);
        shared.on_started();
        shared.on_finished(0);
        let token = read_token(&shared, SETTLE_MS);
        assert!(shared.finish_read(token, Credentials::Present, SETTLE_MS));
        assert_eq!(shared.snapshot(), (2, PageDecision::LoggedIn));

        let next = SETTLE_MS + 1000;
        let token = read_token(&shared, next);
        assert!(shared.finish_read(token, Credentials::Absent, next));
        assert_eq!(shared.snapshot(), (3, PageDecision::LoggedOut));

        let next = next + 1000;
        let token = read_token(&shared, next);
        assert!(shared.finish_read(token, Credentials::Present, next));
        assert_eq!(shared.snapshot(), (4, PageDecision::LoggedIn));
    }

    // ── 可唤醒等待与退出 ──────────────────────────────────────

    #[test]
    fn a_page_load_wakes_a_waiting_watcher() {
        use std::sync::Arc;
        let shared = Arc::new(WatchShared::new(60_000));
        let WatchPoll::Wait {
            version,
            timeout_ms: None,
        } = shared.next_step(0)
        else {
            panic!("初始应为无限等待");
        };

        let waiter = {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || shared.wait(version, None))
        };
        std::thread::sleep(Duration::from_millis(50));

        let started = Instant::now();
        shared.on_started();
        waiter.join().expect("等待线程 panic");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "等待没有被页面加载打断，等了 {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn stop_releases_the_watcher_immediately() {
        let shared = WatchShared::new(60_000);
        let WatchPoll::Wait { version, .. } = shared.next_step(0) else {
            panic!("初始应为等待");
        };

        shared.stop();
        assert_eq!(shared.next_step(0), WatchPoll::Stop);

        let started = Instant::now();
        shared.wait(version, None);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "stop 之后不该继续睡，等了 {:?}",
            started.elapsed()
        );
    }
}
