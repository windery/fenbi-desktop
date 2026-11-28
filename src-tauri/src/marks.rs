//! 划词标记按练习落盘（2026-11-28 用户授权放开，仅限划词标记；登录态照旧不落盘）。
//!
//! - 存在数据目录（store.rs，debug 构建在 `dev/` 下）的 `practice-marks.json`：
//!   `{ 练习: { updated: 毫秒时间戳, marks: [[题号, 起, 止, 颜色], …] } }`。
//!   只存「第几道题 + 题内文字偏移 + 颜色 + 最后修改时间」，不存选中的文字。先写临时文件再改名。
//! - 粉笔页面只拿到两条窄命令：读、写**当前这份练习**（`allow-practice-marks`，单独一份 capability
//!   `capabilities/practice-marks.json`，只给 `https://spa.fenbi.com` 上的 main WebView）。
//!   命令不收练习 id：Rust 从调用方 WebView 的当前地址认定练习（[`practice_of`]，和 highlight.js 的
//!   PRACTICE_PATH 是同一条规则，`tests/fixtures/practice-urls.json` 锁住两边一致），地址不是做题页就拒绝。
//!   写入时校验每条标记的结构、单个练习和整个文件的大小，超限直接拒绝。没有列举、删别的练习的能力。
//! - 存储代次：读回 `[代次, 标记]`，写要带上读到的代次。「清除全部」把代次加一，清除之前发出的迟到写入一律拒绝。
//! - 「记住标记」关着时两条命令都不碰文件，启动时也不读、不清过期；打开时才读文件并按保留天数清过期的。
//! - 写盘失败（超限 / 磁盘）时让工具栏显示一条提示，不往粉笔页面插任何东西。
//! - 「清除全部标记」只有本地工具栏能调。
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, Webview};

use super::settings::SettingsState;
use super::store;
use super::toolbar::{CONTENT, TOOLBAR, require_toolbar};

/// [第几道题, 题内起点偏移, 题内终点偏移, 颜色下标]
pub type Mark = [u32; 4];

/// 一个练习最多存多少处标记。一页 15 题，一题标十几处已经很多。
pub const MAX_MARKS_PER_PRACTICE: usize = 500;
/// 整个文件最多多大（字节）。按每处标记约 30 字节，够存几百份练习。启动读文件也按它封顶。
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_QUESTION: u32 = 1000;
const MAX_OFFSET: u32 = 1_000_000;
const COLORS: u32 = 3;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// 做题页所在的站点；`capabilities/practice-marks.json` 的 remote.urls 也只给它。
const PRACTICE_HOST: &str = "spa.fenbi.com";
/// 写入时带的代次已经过时（中间点过「清除全部」）。页面认这个串，不当成保存失败。
pub const STALE: &str = "stale";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Entry {
    updated: u64,
    marks: Vec<Mark>,
}

type Book = BTreeMap<String, Entry>;

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 练习键：`exercise:<id>` 或 `memorize:<id>`（文件里的键，读文件时用来丢掉手改坏的条目）。
fn valid_practice(practice: &str) -> bool {
    match practice.split_once(':') {
        Some((kind, id)) => matches!(kind, "exercise" | "memorize") && valid_id(id),
        None => false,
    }
}

/// 页面地址 → 练习键；不是做题页就是 None。权威判断在这里，highlight.js 的 PRACTICE_PATH 只是同一条规则的页面侧副本。
///   https://spa.fenbi.com/ti/exam/exercise/<id>   练习
///   https://spa.fenbi.com/ti/memorize/<id>        背题
/// id 是字母、数字、`_`、`-`，最长 64；允许结尾一个 `/`，查询串和 # 不看。
pub fn practice_of(url: &tauri::Url) -> Option<String> {
    if url.scheme() != "https" || url.host_str() != Some(PRACTICE_HOST) || url.port().is_some() {
        return None;
    }
    let path = url.path();
    let (kind, rest) = if let Some(rest) = path.strip_prefix("/ti/exam/exercise/") {
        ("exercise", rest)
    } else if let Some(rest) = path.strip_prefix("/ti/memorize/") {
        ("memorize", rest)
    } else {
        return None;
    };
    let id = rest.strip_suffix('/').unwrap_or(rest);
    valid_id(id).then(|| format!("{kind}:{id}"))
}

/// 写入失败的原因。
#[derive(Debug, PartialEq)]
pub enum WriteError {
    /// 代次过时：清除全部之前发出的迟到写入。
    Stale,
    /// 标记的格式不对（页面脚本出了错）。
    Invalid,
    /// 这份练习的标记超过上限。
    TooMany,
    /// 整个文件超过上限。
    Full,
    /// 写盘失败。
    Io(String),
}

impl WriteError {
    /// 要在工具栏上告诉用户的话；不用告诉的（代次过时、页面脚本的错）是 None。
    pub fn notice(&self) -> Option<String> {
        match self {
            WriteError::Stale | WriteError::Invalid => None,
            WriteError::TooMany => Some(format!(
                "标记没保存上：这份练习的标记太多了（最多 {MAX_MARKS_PER_PRACTICE} 处）"
            )),
            WriteError::Full => Some("标记没保存上：本机存的标记太多了，可在设置里清除".into()),
            WriteError::Io(_) => Some("标记没保存上：写入本机文件失败".into()),
        }
    }

    fn message(&self) -> String {
        match self {
            WriteError::Stale => STALE.into(),
            WriteError::Invalid => "标记的格式不对".into(),
            WriteError::Io(e) => format!("标记没保存上：{e}"),
            other => other.notice().unwrap_or_default(),
        }
    }
}

fn validate(marks: &[Mark]) -> Result<(), WriteError> {
    if marks.len() > MAX_MARKS_PER_PRACTICE {
        return Err(WriteError::TooMany);
    }
    for &[question, start, end, color] in marks {
        if question > MAX_QUESTION || start >= end || end > MAX_OFFSET || color >= COLORS {
            return Err(WriteError::Invalid);
        }
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 去掉 `retention_days` 天前改过的练习；0 表示永久保留。返回有没有删掉东西。
fn prune(book: &mut Book, retention_days: u32, now: u64) -> bool {
    if retention_days == 0 {
        return false;
    }
    let oldest = now.saturating_sub(u64::from(retention_days) * DAY_MS);
    let before = book.len();
    book.retain(|_, entry| entry.updated >= oldest);
    book.len() != before
}

fn parse(text: &str) -> Book {
    let Ok(book) = serde_json::from_str::<Book>(text) else {
        return Book::new();
    };
    // 被手改坏的条目单独丢掉，别的练习照常读。
    book.into_iter()
        .filter(|(practice, entry)| valid_practice(practice) && validate(&entry.marks).is_ok())
        .collect()
}

struct Store {
    /// None：「记住标记」关着启动，还没读过文件。
    book: Option<Book>,
    generation: u64,
}

pub struct MarksState {
    inner: Mutex<Store>,
    path: Option<PathBuf>,
}

/// 读写时要用的两项设置。
#[derive(Clone, Copy)]
pub struct Policy {
    pub remember: bool,
    pub retention_days: u32,
}

impl MarksState {
    /// 「记住标记」开着才读文件并清过期条目；关着就一个字节都不碰，等打开时再读（[`MarksState::activate`]）。
    pub fn load(app: &tauri::AppHandle, policy: Policy) -> Self {
        let path = store::data_dir(app).map(|dir| dir.join("practice-marks.json"));
        Self::open(path, policy, now_ms())
    }

    fn open(path: Option<PathBuf>, policy: Policy, now: u64) -> Self {
        let state = Self {
            inner: Mutex::new(Store {
                book: None,
                generation: 1,
            }),
            path,
        };
        if policy.remember {
            state.activate(policy.retention_days, now);
        }
        state
    }

    /// 打开「记住标记」：还没读过文件就读一次，按保留天数清掉过期的（清掉了就写回去）。读过了什么都不做。
    pub fn activate(&self, retention_days: u32, now: u64) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        self.ensure_loaded(&mut inner, retention_days, now);
    }

    fn ensure_loaded<'a>(
        &self,
        inner: &'a mut Store,
        retention_days: u32,
        now: u64,
    ) -> &'a mut Book {
        if inner.book.is_none() {
            let mut book = self
                .path
                .as_deref()
                .and_then(|p| store::read_capped(p, MAX_FILE_BYTES))
                .map(|text| parse(&text))
                .unwrap_or_default();
            if prune(&mut book, retention_days, now)
                && let Err(e) = self.persist(&book)
            {
                eprintln!("[fenbi-wrapper] marks prune: {e:?}");
            }
            inner.book = Some(book);
        }
        inner.book.get_or_insert_with(Book::new)
    }

    fn persist(&self, book: &Book) -> Result<(), WriteError> {
        let path = self
            .path
            .as_deref()
            .ok_or_else(|| WriteError::Io("找不到应用数据目录".into()))?;
        let bytes = serde_json::to_vec(book).map_err(|e| WriteError::Io(e.to_string()))?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(WriteError::Full);
        }
        store::write_atomically(path, &bytes).map_err(|e| WriteError::Io(e.to_string()))
    }

    /// 读一份练习：(当前代次, 标记)。
    fn read(&self, practice: &str, policy: Policy, now: u64) -> (u64, Vec<Mark>) {
        let Ok(mut inner) = self.inner.lock() else {
            return (0, Vec::new());
        };
        let generation = inner.generation;
        if !policy.remember {
            return (generation, Vec::new());
        }
        let book = self.ensure_loaded(&mut inner, policy.retention_days, now);
        let marks = book
            .get(practice)
            .map(|entry| entry.marks.clone())
            .unwrap_or_default();
        (generation, marks)
    }

    /// 整份替换一份练习的标记；空列表就删掉这一条。先写盘，写成了才改内存。代次不对直接拒绝。
    fn write(
        &self,
        practice: &str,
        generation: u64,
        marks: Vec<Mark>,
        retention_days: u32,
        now: u64,
    ) -> Result<(), WriteError> {
        validate(&marks)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| WriteError::Io(e.to_string()))?;
        if generation != inner.generation {
            return Err(WriteError::Stale);
        }
        let book = self.ensure_loaded(&mut inner, retention_days, now);
        let mut next = book.clone();
        if marks.is_empty() {
            if next.remove(practice).is_none() {
                return Ok(());
            }
        } else {
            next.insert(
                practice.to_string(),
                Entry {
                    updated: now,
                    marks,
                },
            );
        }
        self.persist(&next)?;
        inner.book = Some(next);
        Ok(())
    }

    /// 删掉文件、清空内存，代次加一；返回新代次（推给页面，页面之后的写入带它）。
    fn clear(&self) -> Result<u64, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(path) = self.path.as_deref() {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        inner.book = Some(Book::new());
        inner.generation += 1;
        Ok(inner.generation)
    }
}

fn require_content(label: &str) -> Result<(), String> {
    if label == CONTENT {
        Ok(())
    } else {
        Err("仅粉笔页面可调用此命令".into())
    }
}

/// 调用方是 main WebView、当前地址是做题页：返回这份练习的键。
fn caller_practice(label: &str, url: Option<tauri::Url>) -> Result<String, String> {
    require_content(label)?;
    url.as_ref()
        .and_then(practice_of)
        .ok_or_else(|| "当前页面不是做题页".into())
}

fn policy(app: &tauri::AppHandle) -> Policy {
    let h = app.state::<SettingsState>().current().highlight;
    Policy {
        remember: h.enabled && h.remember,
        retention_days: h.retention_days,
    }
}

/// 在工具栏的提示位上显示一句话（`toolbar.js` 的 `__fenbiShowError`）。
fn notify_toolbar(app: &tauri::AppHandle, text: &str) {
    let Some(toolbar) = app.get_webview(TOOLBAR) else {
        return;
    };
    let literal = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let _ = toolbar.eval(format!(
        "window.__fenbiShowError && window.__fenbiShowError({literal});"
    ));
}

/// 粉笔页面：读当前这份练习的标记，回 `[代次, 标记]`。「记住标记」关着时不读文件，回空。
#[tauri::command]
pub fn read_practice_marks(
    webview: Webview,
    app: tauri::AppHandle,
) -> Result<(u64, Vec<Mark>), String> {
    let practice = caller_practice(webview.label(), webview.url().ok())?;
    Ok(app
        .state::<MarksState>()
        .read(&practice, policy(&app), now_ms()))
}

/// 粉笔页面：整份替换当前这份练习的标记。「记住标记」关着时拒绝、不碰文件；写盘失败时工具栏上提示一句。
#[tauri::command]
pub fn write_practice_marks(
    webview: Webview,
    app: tauri::AppHandle,
    generation: u64,
    marks: Vec<Mark>,
) -> Result<(), String> {
    let practice = caller_practice(webview.label(), webview.url().ok())?;
    let policy = policy(&app);
    if !policy.remember {
        return Err("「记住标记」已关闭".into());
    }
    let notify = |text: &str| notify_toolbar(&app, text);
    write_reporting(
        &app.state::<MarksState>(),
        &practice,
        generation,
        marks,
        policy.retention_days,
        now_ms(),
        notify,
    )
}

/// 写一份练习；失败时该告诉用户的（超限、磁盘）交给 `notify`，页面拿到的是原因串（代次过时是 [`STALE`]）。
fn write_reporting(
    state: &MarksState,
    practice: &str,
    generation: u64,
    marks: Vec<Mark>,
    retention_days: u32,
    now: u64,
    notify: impl FnOnce(&str),
) -> Result<(), String> {
    state
        .write(practice, generation, marks, retention_days, now)
        .map_err(|e| {
            if let Some(text) = e.notice() {
                notify(&text);
            }
            e.message()
        })
}

/// 设置里刚打开「记住标记」：读一次文件并清过期的（启动时关着就没读过）。
pub fn on_settings_saved(app: &tauri::AppHandle) {
    let policy = policy(app);
    if policy.remember {
        app.state::<MarksState>()
            .activate(policy.retention_days, now_ms());
    }
}

/// 本地工具栏：清除全部标记，并让当前粉笔页面清掉已经显示的、换上新代次。
#[tauri::command]
pub fn clear_practice_marks(webview: Webview, app: tauri::AppHandle) -> Result<(), String> {
    require_toolbar(webview.label())?;
    let generation = app.state::<MarksState>().clear()?;
    if let Some(content) = app.get_webview(CONTENT) {
        let _ = content.eval(format!(
            "window.__fenbiClearMarks && window.__fenbiClearMarks({generation});"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;
    const ON: Policy = Policy {
        remember: true,
        retention_days: 30,
    };
    const OFF: Policy = Policy {
        remember: false,
        retention_days: 30,
    };
    const FOREVER: Policy = Policy {
        remember: true,
        retention_days: 0,
    };

    fn temp_path(name: &str) -> PathBuf {
        store::temp_dir(&format!("marks-{name}")).join("practice-marks.json")
    }

    fn read(state: &MarksState, practice: &str) -> Vec<Mark> {
        state.read(practice, ON, NOW).1
    }

    fn generation(state: &MarksState) -> u64 {
        state.read("exercise:any", ON, NOW).0
    }

    fn url(text: &str) -> tauri::Url {
        tauri::Url::parse(text).unwrap()
    }

    #[test]
    fn practice_comes_from_the_page_address_by_the_same_rule_as_highlight_js() {
        // highlight.test.mjs 用同一份表核对页面侧的 PRACTICE_PATH。
        let cases: Vec<(String, Option<String>)> =
            serde_json::from_str(include_str!("../../tests/fixtures/practice-urls.json")).unwrap();
        assert!(cases.len() > 10);
        for (address, expected) in cases {
            assert_eq!(practice_of(&url(&address)), expected, "{address}");
        }
    }

    #[test]
    fn only_the_page_on_a_practice_address_can_read_and_write() {
        let page = "https://spa.fenbi.com/ti/exam/exercise/a";
        assert_eq!(
            caller_practice(CONTENT, Some(url(page))).unwrap(),
            "exercise:a"
        );
        assert!(caller_practice(TOOLBAR, Some(url(page))).is_err());
        for other in [
            "https://spa.fenbi.com/ti/exam/solution/a",
            "https://www.fenbi.com/spa/tiku/guide/catalog",
            "https://x.fenbi.com/ti/exam/exercise/a",
        ] {
            assert!(
                caller_practice(CONTENT, Some(url(other))).is_err(),
                "{other}"
            );
        }
        assert!(caller_practice(CONTENT, None).is_err());
    }

    #[test]
    fn reads_and_writes_land_only_on_the_practice_of_the_current_address() {
        let path = temp_path("bound");
        let state = MarksState::open(Some(path.clone()), ON, NOW);
        let generation = generation(&state);
        let at_a = caller_practice(
            CONTENT,
            Some(url("https://spa.fenbi.com/ti/exam/exercise/A")),
        )
        .unwrap();
        state
            .write(&at_a, generation, vec![[0, 1, 2, 0]], 30, NOW)
            .unwrap();
        assert_eq!(read(&state, "exercise:A"), vec![[0, 1, 2, 0]]);
        assert_eq!(read(&state, "exercise:B"), Vec::<Mark>::new());
        assert_eq!(read(&state, "memorize:A"), Vec::<Mark>::new());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn the_marks_capability_is_its_own_file_and_only_for_spa_fenbi_com() {
        use tauri::utils::acl::RemoteUrlPattern;
        let marks: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/practice-marks.json")).unwrap();
        assert_eq!(marks["webviews"], serde_json::json!(["main"]));
        assert_eq!(marks["local"], serde_json::json!(false));
        assert_eq!(
            marks["permissions"],
            serde_json::json!(["allow-practice-marks"])
        );
        assert_eq!(
            marks["remote"]["urls"],
            serde_json::json!(["https://spa.fenbi.com"])
        );
        // 用 Tauri 自己的匹配规则核对：做题页能调，其他子域、别的协议调不到。
        let pattern: RemoteUrlPattern = "https://spa.fenbi.com".parse().unwrap();
        assert!(pattern.test(&url("https://spa.fenbi.com/ti/exam/exercise/a?x=1")));
        for other in [
            "https://www.fenbi.com/ti/exam/exercise/a",
            "https://fenbi.com/ti/exam/exercise/a",
            "https://x.spa.fenbi.com/ti/exam/exercise/a",
            "http://spa.fenbi.com/ti/exam/exercise/a",
        ] {
            assert!(!pattern.test(&url(other)), "{other}");
        }
        for (name, text) in [
            ("default.json", include_str!("../capabilities/default.json")),
            ("toolbar.json", include_str!("../capabilities/toolbar.json")),
            (
                "dev/loopback.json",
                include_str!("../capabilities/dev/loopback.json"),
            ),
        ] {
            assert!(!text.contains("allow-practice-marks"), "{name}");
        }
        let toolbar = include_str!("../capabilities/toolbar.json");
        assert!(toolbar.contains("allow-clear-practice-marks"));
        assert!(!include_str!("../capabilities/practice-marks.json").contains("allow-clear"));
        let permissions = include_str!("../permissions/wrapper-commands.toml");
        assert!(
            permissions
                .contains(r#"commands.allow = ["read_practice_marks", "write_practice_marks"]"#),
            "粉笔页面只拿到读、写当前练习两条命令"
        );
    }

    #[test]
    fn writes_survive_a_restart_and_practices_stay_apart() {
        let path = temp_path("restart");
        let state = MarksState::open(Some(path.clone()), ON, NOW);
        let g = generation(&state);
        state
            .write("exercise:a", g, vec![[0, 2, 7, 1]], 30, NOW)
            .unwrap();
        state
            .write("memorize:a", g, vec![[3, 0, 4, 2]], 30, NOW)
            .unwrap();
        let reopened = MarksState::open(Some(path.clone()), ON, NOW);
        assert_eq!(read(&reopened, "exercise:a"), vec![[0, 2, 7, 1]]);
        assert_eq!(
            read(&reopened, "memorize:a"),
            vec![[3, 0, 4, 2]],
            "练习和背题分开存"
        );
        assert_eq!(read(&reopened, "exercise:b"), Vec::<Mark>::new());

        let g = generation(&reopened);
        reopened.write("exercise:a", g, vec![], 30, NOW).unwrap();
        let again = MarksState::open(Some(path.clone()), ON, NOW);
        assert_eq!(
            read(&again, "exercise:a"),
            Vec::<Mark>::new(),
            "空列表就删掉这一条"
        );
        assert_eq!(read(&again, "memorize:a"), vec![[3, 0, 4, 2]]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn bad_writes_are_rejected_and_leave_the_file_alone() {
        let path = temp_path("reject");
        let state = MarksState::open(Some(path.clone()), ON, NOW);
        let g = generation(&state);
        state
            .write("exercise:a", g, vec![[0, 1, 2, 0]], 30, NOW)
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let too_many = vec![[0, 1, 2, 0]; MAX_MARKS_PER_PRACTICE + 1];
        for (marks, error) in [
            (vec![[0, 5, 5, 0]], WriteError::Invalid),
            (vec![[0, 6, 5, 0]], WriteError::Invalid),
            (vec![[0, 1, 2, 3]], WriteError::Invalid),
            (vec![[MAX_QUESTION + 1, 1, 2, 0]], WriteError::Invalid),
            (vec![[0, 1, MAX_OFFSET + 1, 0]], WriteError::Invalid),
            (too_many, WriteError::TooMany),
        ] {
            assert_eq!(
                state.write("exercise:a", g, marks.clone(), 30, NOW),
                Err(error),
                "{:?}",
                marks.first()
            );
        }
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(read(&state, "exercise:a"), vec![[0, 1, 2, 0]]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 跑一次写入，收集要在工具栏上显示的提示。
    fn write_noting(
        state: &MarksState,
        generation: u64,
        marks: Vec<Mark>,
    ) -> (Result<(), String>, Vec<String>) {
        let mut notices = Vec::new();
        let result = write_reporting(state, "exercise:a", generation, marks, 30, NOW, |text| {
            notices.push(text.to_string())
        });
        (result, notices)
    }

    #[test]
    fn failed_saves_tell_the_user_keep_the_old_file_and_a_retry_lands() {
        // 超限：工具栏提示「太多了」，旧档不动。
        let path = temp_path("fail");
        let state = MarksState::open(Some(path.clone()), ON, NOW);
        let g = generation(&state);
        let (ok, notices) = write_noting(&state, g, vec![[0, 1, 2, 0]]);
        assert!(ok.is_ok() && notices.is_empty(), "成功不提示");
        let before = std::fs::read(&path).unwrap();
        let (too_many, notices) =
            write_noting(&state, g, vec![[0, 1, 2, 0]; MAX_MARKS_PER_PRACTICE + 1]);
        assert!(too_many.is_err());
        assert_eq!(notices.len(), 1);
        assert!(
            notices[0].contains("标记没保存上") && notices[0].contains("太多"),
            "{notices:?}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);

        // 磁盘写不进去（目标被一个非空目录占住）：提示「写入失败」，内存里还是旧档；挪开后重试成功、落盘一致。
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir_all(path.join("blocker")).unwrap();
        let (io, notices) = write_noting(&state, g, vec![[0, 1, 2, 0], [0, 3, 4, 1]]);
        assert!(io.is_err());
        assert_eq!(notices, vec!["标记没保存上：写入本机文件失败".to_string()]);
        assert_eq!(read(&state, "exercise:a"), vec![[0, 1, 2, 0]]);
        std::fs::remove_dir_all(&path).unwrap();
        let (retry, notices) = write_noting(&state, g, vec![[0, 1, 2, 0], [0, 3, 4, 1]]);
        assert!(retry.is_ok() && notices.is_empty());

        // 代次过时：页面拿到 STALE，不打扰用户。
        let (stale, notices) = write_noting(&state, g + 1, vec![[0, 1, 2, 0]]);
        assert_eq!(stale, Err(STALE.to_string()));
        assert!(notices.is_empty());
        let reopened = MarksState::open(Some(path.clone()), ON, NOW);
        assert_eq!(
            read(&reopened, "exercise:a"),
            vec![[0, 1, 2, 0], [0, 3, 4, 1]]
        );

        // 代次过时、页面脚本的错：不打扰用户。
        assert_eq!(WriteError::Stale.notice(), None);
        assert_eq!(WriteError::Invalid.notice(), None);
        assert_eq!(WriteError::Stale.message(), STALE);
        assert!(WriteError::Full.notice().unwrap().contains("清除"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_full_file_rejects_new_practices() {
        let path = temp_path("full");
        let state = MarksState::open(Some(path.clone()), FOREVER, NOW);
        let g = generation(&state);
        let big = vec![[999, 999_000, 999_999, 2]; MAX_MARKS_PER_PRACTICE];
        let mut written = 0;
        let rejected = (0..1000).find_map(|i| {
            match state.write(&format!("exercise:p{i}"), g, big.clone(), 0, NOW) {
                Ok(()) => {
                    written += 1;
                    None
                }
                Err(e) => Some(e),
            }
        });
        assert_eq!(rejected, Some(WriteError::Full), "写满之后要拒绝");
        assert!(written > 0);
        assert!(std::fs::metadata(&path).unwrap().len() as usize <= MAX_FILE_BYTES);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn expired_practices_are_dropped_at_startup() {
        let path = temp_path("expire");
        let state = MarksState::open(Some(path.clone()), FOREVER, NOW);
        let g = generation(&state);
        state
            .write("exercise:old", g, vec![[0, 1, 2, 0]], 0, NOW - 31 * DAY_MS)
            .unwrap();
        state
            .write("exercise:new", g, vec![[0, 1, 2, 0]], 0, NOW - 29 * DAY_MS)
            .unwrap();

        let forever = MarksState::open(Some(path.clone()), FOREVER, NOW);
        assert_eq!(
            forever.read("exercise:old", FOREVER, NOW).1.len(),
            1,
            "永久保留不清"
        );

        let month = MarksState::open(Some(path.clone()), ON, NOW);
        assert!(read(&month, "exercise:old").is_empty());
        assert_eq!(read(&month, "exercise:new").len(), 1);
        let reopened = MarksState::open(Some(path.clone()), FOREVER, NOW);
        assert!(
            reopened.read("exercise:old", FOREVER, NOW).1.is_empty(),
            "清掉的要写回文件"
        );

        let week = Policy {
            remember: true,
            retention_days: 7,
        };
        let weekly = MarksState::open(Some(path.clone()), week, NOW);
        assert!(weekly.read("exercise:new", week, NOW).1.is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn with_remember_off_a_restart_neither_reads_nor_prunes_until_it_is_turned_on() {
        let path = temp_path("remember-off");
        let seed = MarksState::open(Some(path.clone()), FOREVER, NOW);
        let g = generation(&seed);
        seed.write("exercise:old", g, vec![[0, 1, 2, 0]], 0, NOW - 90 * DAY_MS)
            .unwrap();
        seed.write("exercise:new", g, vec![[0, 1, 2, 0]], 0, NOW)
            .unwrap();
        let before = std::fs::read(&path).unwrap();

        let state = MarksState::open(Some(path.clone()), OFF, NOW);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "关着记忆启动：过期条目也不清"
        );
        assert!(
            state.inner.lock().unwrap().book.is_none(),
            "关着记忆启动：不读文件"
        );
        assert_eq!(state.read("exercise:new", OFF, NOW).1, Vec::<Mark>::new());
        assert!(state.inner.lock().unwrap().book.is_none());
        assert_eq!(std::fs::read(&path).unwrap(), before);

        // 重新打开：这时才读、才按保留天数清。
        state.activate(30, NOW);
        assert_ne!(std::fs::read(&path).unwrap(), before);
        assert!(read(&state, "exercise:old").is_empty());
        assert_eq!(read(&state, "exercise:new").len(), 1);

        // 关着记忆时「清除全部」照常可用。
        let off_again = MarksState::open(Some(path.clone()), OFF, NOW);
        off_again.clear().unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn clear_removes_everything_and_rejects_late_writes_from_before() {
        let path = temp_path("clear");
        let state = MarksState::open(Some(path.clone()), ON, NOW);
        let old = generation(&state);
        state
            .write("exercise:a", old, vec![[0, 1, 2, 0]], 30, NOW)
            .unwrap();
        let new = state.clear().unwrap();
        assert!(new > old);
        assert!(!path.exists());
        assert!(read(&state, "exercise:a").is_empty());

        // 清除之前发出、清除之后才到的写入：拒绝，磁盘保持清空。
        assert_eq!(
            state.write("exercise:a", old, vec![[0, 1, 2, 0], [0, 5, 6, 1]], 30, NOW),
            Err(WriteError::Stale)
        );
        assert!(!path.exists());
        // 清除之后带新代次的写入：只含新标记。
        state
            .write("exercise:a", new, vec![[0, 7, 9, 2]], 30, NOW)
            .unwrap();
        let reopened = MarksState::open(Some(path.clone()), ON, NOW);
        assert_eq!(read(&reopened, "exercise:a"), vec![[0, 7, 9, 2]]);
        state.clear().unwrap();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_corrupt_or_oversized_file_reads_as_empty_and_bad_entries_are_dropped() {
        assert!(parse("not json").is_empty());
        let book = parse(
            r#"{"exercise:a":{"updated":1,"marks":[[0,1,2,0]]},"exercise:b":{"updated":1,"marks":[[0,2,1,0]]},"x":{"updated":1,"marks":[]}}"#,
        );
        assert_eq!(book.keys().collect::<Vec<_>>(), ["exercise:a"]);

        let path = temp_path("oversized");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut text =
            String::from(r#"{"exercise:a":{"updated":1800000000000,"marks":[[0,1,2,0]]}"#);
        text.push_str(&" ".repeat(MAX_FILE_BYTES));
        text.push('}');
        std::fs::write(&path, &text).unwrap();
        let state = MarksState::open(Some(path.clone()), FOREVER, NOW);
        assert!(state.read("exercise:a", FOREVER, NOW).1.is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
