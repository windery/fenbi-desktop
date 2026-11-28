//! 划词标记按练习落盘（2026-11-28 用户授权放开，仅限划词标记；登录态照旧不落盘）。
//!
//! - 存在 app_data_dir 下的 `practice-marks.json`：`{ 练习: { updated: 毫秒时间戳, marks: [[题号, 起, 止, 颜色], …] } }`。
//!   只存「第几道题 + 题内文字偏移 + 颜色 + 最后修改时间」，不存选中的文字。先写临时文件再改名。
//! - 粉笔页面只拿到两条窄命令：按练习读、按练习写（`allow-practice-marks`，只给 main WebView）。
//!   写入时校验练习 id、每条标记的结构、单个练习和整个文件的大小，超限直接拒绝。没有列举、删别的练习的能力。
//! - 「记住标记」关着时两条命令都不碰文件。启动时按「标记保留天数」清掉过期的练习。
//! - 「清除全部标记」只有本地工具栏能调。
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, Webview};

use super::settings::SettingsState;
use super::toolbar::{CONTENT, require_toolbar};

/// [第几道题, 题内起点偏移, 题内终点偏移, 颜色下标]
pub type Mark = [u32; 4];

/// 一个练习最多存多少处标记。一页 15 题，一题标十几处已经很多。
pub const MAX_MARKS_PER_PRACTICE: usize = 500;
/// 整个文件最多多大（字节）。按每处标记约 30 字节，够存几百份练习。
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_QUESTION: u32 = 1000;
const MAX_OFFSET: u32 = 1_000_000;
const COLORS: u32 = 3;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Entry {
    updated: u64,
    marks: Vec<Mark>,
}

type Book = BTreeMap<String, Entry>;

/// 练习 id：`exercise:<id>` 或 `memorize:<id>`，id 是字母、数字、`_`、`-`，最长 64。
/// 和 highlight.js 的 PRACTICE_PATH 对应（spa.fenbi.com/ti/exam/exercise/<id>、/ti/memorize/<id>）。
pub fn valid_practice(practice: &str) -> bool {
    let Some((kind, id)) = practice.split_once(':') else {
        return false;
    };
    matches!(kind, "exercise" | "memorize")
        && (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn validate(practice: &str, marks: &[Mark]) -> Result<(), String> {
    if !valid_practice(practice) {
        return Err("练习 id 不对".into());
    }
    if marks.len() > MAX_MARKS_PER_PRACTICE {
        return Err(format!("一份练习最多存 {MAX_MARKS_PER_PRACTICE} 处标记"));
    }
    for &[question, start, end, color] in marks {
        if question > MAX_QUESTION || start >= end || end > MAX_OFFSET || color >= COLORS {
            return Err("标记的格式不对".into());
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
        .filter(|(practice, entry)| validate(practice, &entry.marks).is_ok())
        .collect()
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let pending = path.with_extension("json.tmp");
    std::fs::write(&pending, bytes)?;
    std::fs::rename(&pending, path)
}

pub struct MarksState {
    book: Mutex<Book>,
    path: Option<PathBuf>,
}

impl MarksState {
    /// 读文件并按保留天数清过期条目；清掉了就写回去。
    pub fn load(app: &tauri::AppHandle, retention_days: u32) -> Self {
        let path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|p| p.join("practice-marks.json"));
        Self::open(path, retention_days, now_ms())
    }

    fn open(path: Option<PathBuf>, retention_days: u32, now: u64) -> Self {
        let mut book = path
            .as_deref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|text| parse(&text))
            .unwrap_or_default();
        let state = Self {
            book: Mutex::new(Book::new()),
            path,
        };
        if prune(&mut book, retention_days, now)
            && let Err(e) = state.persist(&book)
        {
            eprintln!("[fenbi-wrapper] marks prune: {e}");
        }
        *state.book.lock().unwrap() = book;
        state
    }

    fn persist(&self, book: &Book) -> Result<(), String> {
        let path = self.path.as_deref().ok_or("找不到应用数据目录")?;
        let bytes = serde_json::to_vec(book).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err("标记文件已满，先在设置里清除或缩短保留天数".into());
        }
        write_atomically(path, &bytes).map_err(|e| e.to_string())
    }

    fn read(&self, practice: &str) -> Result<Vec<Mark>, String> {
        if !valid_practice(practice) {
            return Err("练习 id 不对".into());
        }
        let book = self.book.lock().map_err(|e| e.to_string())?;
        Ok(book
            .get(practice)
            .map(|entry| entry.marks.clone())
            .unwrap_or_default())
    }

    /// 整份替换一个练习的标记；空列表就删掉这一条。先写盘，写成了才改内存。
    fn write(&self, practice: &str, marks: Vec<Mark>, now: u64) -> Result<(), String> {
        validate(practice, &marks)?;
        let mut book = self.book.lock().map_err(|e| e.to_string())?;
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
        *book = next;
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        let mut book = self.book.lock().map_err(|e| e.to_string())?;
        if let Some(path) = self.path.as_deref() {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        book.clear();
        Ok(())
    }
}

fn require_content(label: &str) -> Result<(), String> {
    if label == CONTENT {
        Ok(())
    } else {
        Err("仅粉笔页面可调用此命令".into())
    }
}

fn remembering(app: &tauri::AppHandle) -> bool {
    let settings = app.state::<SettingsState>().current();
    settings.highlight.enabled && settings.highlight.remember
}

/// 粉笔页面：读一份练习的标记。「记住标记」关着时不读文件，回空。
#[tauri::command]
pub fn read_practice_marks(
    webview: Webview,
    app: tauri::AppHandle,
    practice: String,
) -> Result<Vec<Mark>, String> {
    require_content(webview.label())?;
    if !remembering(&app) {
        return Ok(Vec::new());
    }
    app.state::<MarksState>().read(&practice)
}

/// 粉笔页面：整份替换一份练习的标记。「记住标记」关着时拒绝、不碰文件。
#[tauri::command]
pub fn write_practice_marks(
    webview: Webview,
    app: tauri::AppHandle,
    practice: String,
    marks: Vec<Mark>,
) -> Result<(), String> {
    require_content(webview.label())?;
    if !remembering(&app) {
        return Err("「记住标记」已关闭".into());
    }
    app.state::<MarksState>().write(&practice, marks, now_ms())
}

/// 本地工具栏：清除全部标记，并让当前粉笔页面清掉已经显示的标记。
#[tauri::command]
pub fn clear_practice_marks(webview: Webview, app: tauri::AppHandle) -> Result<(), String> {
    require_toolbar(webview.label())?;
    app.state::<MarksState>().clear()?;
    if let Some(content) = app.get_webview(CONTENT) {
        let _ = content.eval("window.__fenbiClearMarks && window.__fenbiClearMarks();");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fenbi-marks-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("practice-marks.json")
    }

    #[test]
    fn practice_ids_are_kind_and_site_id() {
        for ok in [
            "exercise:1_3e_2k95rs8",
            "memorize:1_3e_2k96k2k",
            "exercise:abc-DEF_9",
        ] {
            assert!(valid_practice(ok), "{ok}");
        }
        let long = format!("exercise:{}", "a".repeat(65));
        for bad in [
            "",
            "exercise:",
            "exercise",
            "solution:1",
            "exercise:a/b",
            "exercise:a b",
            "exercise:..",
            &long,
        ] {
            assert!(!valid_practice(bad), "{bad}");
        }
    }

    #[test]
    fn writes_survive_a_restart_and_practices_stay_apart() {
        let path = temp_path("restart");
        let state = MarksState::open(Some(path.clone()), 30, NOW);
        state.write("exercise:a", vec![[0, 2, 7, 1]], NOW).unwrap();
        state.write("memorize:a", vec![[3, 0, 4, 2]], NOW).unwrap();
        assert!(
            !path.with_extension("json.tmp").exists(),
            "临时文件要改名掉"
        );

        let reopened = MarksState::open(Some(path.clone()), 30, NOW);
        assert_eq!(reopened.read("exercise:a").unwrap(), vec![[0, 2, 7, 1]]);
        assert_eq!(
            reopened.read("memorize:a").unwrap(),
            vec![[3, 0, 4, 2]],
            "练习和背题分开存"
        );
        assert_eq!(reopened.read("exercise:b").unwrap(), Vec::<Mark>::new());

        reopened.write("exercise:a", vec![], NOW).unwrap();
        let again = MarksState::open(Some(path.clone()), 30, NOW);
        assert_eq!(
            again.read("exercise:a").unwrap(),
            Vec::<Mark>::new(),
            "空列表就删掉这一条"
        );
        assert_eq!(again.read("memorize:a").unwrap(), vec![[3, 0, 4, 2]]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn bad_writes_are_rejected_and_leave_the_file_alone() {
        let path = temp_path("reject");
        let state = MarksState::open(Some(path.clone()), 30, NOW);
        state.write("exercise:a", vec![[0, 1, 2, 0]], NOW).unwrap();
        let before = std::fs::read(&path).unwrap();
        let too_many = vec![[0, 1, 2, 0]; MAX_MARKS_PER_PRACTICE + 1];
        for (practice, marks) in [
            ("exercise:../x", vec![[0, 1, 2, 0]]),
            ("exercise:a", vec![[0, 5, 5, 0]]),
            ("exercise:a", vec![[0, 6, 5, 0]]),
            ("exercise:a", vec![[0, 1, 2, 3]]),
            ("exercise:a", vec![[MAX_QUESTION + 1, 1, 2, 0]]),
            ("exercise:a", vec![[0, 1, MAX_OFFSET + 1, 0]]),
            ("exercise:a", too_many),
        ] {
            assert!(
                state.write(practice, marks.clone(), NOW).is_err(),
                "{practice} {:?}",
                marks.first()
            );
        }
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(state.read("exercise:a").unwrap(), vec![[0, 1, 2, 0]]);
        assert!(state.read("exercise:a/b").is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_full_file_rejects_new_practices() {
        let path = temp_path("full");
        let state = MarksState::open(Some(path.clone()), 0, NOW);
        let big = vec![[999, 999_000, 999_999, 2]; MAX_MARKS_PER_PRACTICE];
        let mut written = 0;
        let rejected = (0..1000).find_map(|i| {
            match state.write(&format!("exercise:p{i}"), big.clone(), NOW) {
                Ok(()) => {
                    written += 1;
                    None
                }
                Err(e) => Some(e),
            }
        });
        assert!(
            rejected.is_some_and(|e| e.contains("已满")),
            "写满之后要拒绝"
        );
        assert!(written > 0);
        assert!(std::fs::metadata(&path).unwrap().len() as usize <= MAX_FILE_BYTES);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn expired_practices_are_dropped_at_startup() {
        let path = temp_path("expire");
        let state = MarksState::open(Some(path.clone()), 0, NOW);
        state
            .write("exercise:old", vec![[0, 1, 2, 0]], NOW - 31 * DAY_MS)
            .unwrap();
        state
            .write("exercise:new", vec![[0, 1, 2, 0]], NOW - 29 * DAY_MS)
            .unwrap();

        let forever = MarksState::open(Some(path.clone()), 0, NOW);
        assert_eq!(
            forever.read("exercise:old").unwrap().len(),
            1,
            "永久保留不清"
        );

        let month = MarksState::open(Some(path.clone()), 30, NOW);
        assert!(month.read("exercise:old").unwrap().is_empty());
        assert_eq!(month.read("exercise:new").unwrap().len(), 1);
        let reopened = MarksState::open(Some(path.clone()), 0, NOW);
        assert!(
            reopened.read("exercise:old").unwrap().is_empty(),
            "清掉的要写回文件"
        );

        let week = MarksState::open(Some(path.clone()), 7, NOW);
        assert!(week.read("exercise:new").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn clear_removes_everything_on_disk() {
        let path = temp_path("clear");
        let state = MarksState::open(Some(path.clone()), 30, NOW);
        state.write("exercise:a", vec![[0, 1, 2, 0]], NOW).unwrap();
        state.clear().unwrap();
        assert!(!path.exists());
        assert!(state.read("exercise:a").unwrap().is_empty());
        state.clear().unwrap();
        let reopened = MarksState::open(Some(path.clone()), 30, NOW);
        assert!(reopened.read("exercise:a").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_corrupt_file_reads_as_empty_and_bad_entries_are_dropped() {
        assert!(parse("not json").is_empty());
        let book = parse(
            r#"{"exercise:a":{"updated":1,"marks":[[0,1,2,0]]},"exercise:b":{"updated":1,"marks":[[0,2,1,0]]},"x":{"updated":1,"marks":[]}}"#,
        );
        assert_eq!(book.keys().collect::<Vec<_>>(), ["exercise:a"]);
    }

    #[test]
    fn only_the_page_can_read_and_write_and_only_the_toolbar_can_clear() {
        assert!(require_content(CONTENT).is_ok());
        assert!(require_content(super::super::toolbar::TOOLBAR).is_err());
        let website = include_str!("../capabilities/default.json");
        let toolbar = include_str!("../capabilities/toolbar.json");
        let permissions = include_str!("../permissions/wrapper-commands.toml");
        assert!(website.contains("allow-practice-marks"));
        assert!(!toolbar.contains("allow-practice-marks"));
        assert!(toolbar.contains("allow-clear-practice-marks"));
        assert!(!website.contains("allow-clear-practice-marks"));
        assert!(
            permissions
                .contains(r#"commands.allow = ["read_practice_marks", "write_practice_marks"]"#),
            "粉笔页面只拿到按练习读、写两条命令"
        );
    }
}
