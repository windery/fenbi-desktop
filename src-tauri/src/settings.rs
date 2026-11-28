//! 功能设置：做题页划词标记、解析页左右分栏的开关和参数。
//!
//! - 存在数据目录（store.rs，debug 构建在 `dev/` 下）的 `feature-settings.json`，先写临时文件再改名，写一半断电也不会留下半个文件。
//! - 文件读不出、不是 JSON、任何一个字段非法（含快捷键占了工具栏或系统的键）：整份回落默认值（不逐字段拼凑）。
//!   缺的字段按默认值补上，以后加设置项时老文件照样能读。
//! - 读写命令只授权给本地工具栏 WebView（`capabilities/toolbar.json`），粉笔页面拿不到。
//! - 粉笔页面拿设置只有两条路，都是 Rust 主动推：启动时拼进 initialization_script
//!   （`page-settings.js` 的 `__FENBI_SETTINGS__`），之后保存或页面加载完成时 `eval` 推一次新值。
//!   页面在收到加载完成后的那次推送之前不处理划词输入（见 page-settings.js），免得整页重载后用旧设置。
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tauri::{Manager, Webview};

use super::store;
use super::toolbar::{CONTENT, require_toolbar};

/// 设置文件不会超过这么大；更大的不是包装层写的，当没有。
const MAX_FILE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub highlight: Highlight,
    pub split: Split,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Highlight {
    pub enabled: bool,
    /// `release`：拖选松手即标记；`key`：选中后按 `mark_key` 标记。
    pub mode: String,
    pub mark_key: String,
    pub toggle_key: String,
    pub color_key: String,
    pub colors: Vec<String>,
    /// 按练习记住标记（存在 app_data_dir，见 marks.rs）。
    pub remember: bool,
    /// 标记保留多少天（按练习最后一次修改算），读标记文件时（启动或刚打开「记住标记」）清过期的；0 表示永久。
    pub retention_days: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Split {
    pub enabled: bool,
    /// 左栏占内容宽度的百分比。
    pub left_percent: u32,
    /// 窗口内容区至少多宽（CSS 像素）才分栏。
    pub min_width: u32,
}

pub const DEFAULT_COLORS: [&str; 3] = ["#ffd8a8", "#c3f0c8", "#ffc9de"];
pub const LEFT_PERCENT: (u32, u32) = (30, 70);
pub const MIN_WIDTH: (u32, u32) = (960, 2560);
const MODES: [&str; 2] = ["release", "key"];
pub const RETENTION_DAYS: [u32; 4] = [7, 30, 90, 0];
/// 快捷键里修饰键的固定顺序；录入框按这个顺序拼字符串，这里按它校验。
const MODIFIERS: [&str; 4] = ["Ctrl", "Alt", "Shift", "Meta"];

impl Default for Highlight {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: "release".into(),
            mark_key: "KeyH".into(),
            // V / C 不带修饰键：shortcuts.js 的五个键位全带 ⌘ / Ctrl / Alt，mac 系统快捷键也都带 ⌘，
            // 粉笔站点没有全局按键处理（init.js「键盘快捷键」一节的实测）；打字时由 highlight.js 放行。
            toggle_key: "KeyV".into(),
            color_key: "KeyC".into(),
            colors: DEFAULT_COLORS.iter().map(|c| c.to_string()).collect(),
            remember: true,
            retention_days: 30,
        }
    }
}

impl Default for Split {
    fn default() -> Self {
        Self {
            enabled: true,
            left_percent: 50,
            min_width: 1400,
        }
    }
}

/// `Ctrl+Alt+Shift+Meta+<code>` 的子集，修饰键按固定顺序、不重复；
/// 键用 KeyboardEvent.code：字母 `KeyA`–`KeyZ`、数字 `Digit0`–`Digit9`、`F1`–`F12`。
pub fn valid_shortcut(shortcut: &str) -> bool {
    let mut parts: Vec<&str> = shortcut.split('+').collect();
    let Some(code) = parts.pop() else {
        return false;
    };
    let mut last = None;
    for part in parts {
        let Some(at) = MODIFIERS.iter().position(|m| *m == part) else {
            return false;
        };
        if last.is_some_and(|prev| at <= prev) {
            return false;
        }
        last = Some(at);
    }
    let single = |prefix: &str, range: std::ops::RangeInclusive<char>| {
        code.strip_prefix(prefix).is_some_and(|rest| {
            let mut chars = rest.chars();
            chars.next().is_some_and(|c| range.contains(&c)) && chars.next().is_none()
        })
    };
    single("Key", 'A'..='Z')
        || single("Digit", '0'..='9')
        || code
            .strip_prefix('F')
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|n| (1..=12).contains(&n) && code == format!("F{n}"))
}

/// shortcuts.js 里夹在「/* <name> JSON 开始 */」「/* <name> JSON 结束 */」之间的那段 JSON。
fn json_block<'a>(source: &'a str, name: &str) -> Option<&'a str> {
    let start = format!("/* {name} JSON 开始 */");
    let end = format!("/* {name} JSON 结束 */");
    let from = source.find(&start)? + start.len();
    let to = from + source[from..].find(&end)?;
    Some(&source[from..to])
}

#[derive(Deserialize)]
struct Binding {
    #[serde(default)]
    ctrl: u8,
    #[serde(default)]
    alt: u8,
    #[serde(default)]
    shift: u8,
    #[serde(default)]
    meta: u8,
    key: String,
}

impl Binding {
    /// 工具栏键位 → 「Ctrl+Alt+Shift+Meta+<code>」写法。
    fn shortcut(&self) -> Option<String> {
        let code = match self.key.as_str() {
            "[" => "BracketLeft".to_string(),
            "]" => "BracketRight".to_string(),
            "left" => "ArrowLeft".to_string(),
            "right" => "ArrowRight".to_string(),
            k if k.len() == 1 && k.chars().all(|c| c.is_ascii_lowercase()) => {
                format!("Key{}", k.to_ascii_uppercase())
            }
            _ => return None,
        };
        let flags = [self.ctrl, self.alt, self.shift, self.meta];
        let mut parts: Vec<String> = MODIFIERS
            .iter()
            .zip(flags)
            .filter(|(_, on)| *on != 0)
            .map(|(m, _)| m.to_string())
            .collect();
        parts.push(code);
        Some(parts.join("+"))
    }
}

/// 划词快捷键不能占的键：(mac, Windows / Linux)。和设置页面录入框查的是同一份定义——
/// shortcuts.js 的工具栏键位表和系统快捷键表（两段纯 JSON），这里 include_str! 进来解析。
static RESERVED: LazyLock<(Vec<String>, Vec<String>)> = LazyLock::new(|| {
    let source = include_str!("../toolbar/shortcuts.js");
    let bindings: BTreeMap<String, BTreeMap<String, Binding>> = json_block(source, "键位表")
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default();
    let system: BTreeMap<String, Vec<String>> = json_block(source, "系统快捷键")
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default();
    let collect = |platform: &str| {
        let mut keys: Vec<String> = bindings
            .values()
            .filter_map(|per| per.get(platform).and_then(Binding::shortcut))
            .collect();
        keys.extend(system.get(platform).cloned().unwrap_or_default());
        keys
    };
    (collect("mac"), collect("win"))
});

fn reserved_shortcuts(mac: bool) -> &'static [String] {
    if mac { &RESERVED.0 } else { &RESERVED.1 }
}

fn valid_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..]
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

impl Settings {
    /// 返回第一条不合法的原因（给设置页面看的人话）。按当前平台查保留键。
    pub fn validate(&self) -> Result<(), String> {
        self.validate_on(cfg!(target_os = "macos"))
    }

    fn validate_on(&self, mac: bool) -> Result<(), String> {
        let h = &self.highlight;
        if !MODES.contains(&h.mode.as_str()) {
            return Err("标记方式只能是「松手即标记」或「选中后按键标记」".into());
        }
        let keys = [&h.mark_key, &h.toggle_key, &h.color_key];
        if !keys.iter().all(|k| valid_shortcut(k)) {
            return Err("快捷键请用字母、数字或 F1–F12（可搭配修饰键）".into());
        }
        if keys[0] == keys[1] || keys[0] == keys[2] || keys[1] == keys[2] {
            return Err("划词标记的几个快捷键不能重复".into());
        }
        let reserved = reserved_shortcuts(mac);
        if let Some(key) = keys.iter().find(|k| reserved.contains(k)) {
            return Err(format!("{key} 已用于工具栏或系统，请换一个"));
        }
        if h.colors.len() != DEFAULT_COLORS.len() || !h.colors.iter().all(|c| valid_color(c)) {
            return Err("颜色要写成 #rrggbb，共 3 种".into());
        }
        if !RETENTION_DAYS.contains(&h.retention_days) {
            return Err("标记保留时长只能是 7、30、90 天或永久保留".into());
        }
        let s = &self.split;
        if !(LEFT_PERCENT.0..=LEFT_PERCENT.1).contains(&s.left_percent) {
            return Err(format!(
                "左栏占比要在 {}%–{}% 之间",
                LEFT_PERCENT.0, LEFT_PERCENT.1
            ));
        }
        if !(MIN_WIDTH.0..=MIN_WIDTH.1).contains(&s.min_width) {
            return Err(format!(
                "分栏所需窗口宽度请输入 {}–{} 之间的整数",
                MIN_WIDTH.0, MIN_WIDTH.1
            ));
        }
        Ok(())
    }

    /// 文件内容 → 设置。读不懂或有任何非法字段就整份用默认值。
    pub fn parse(text: &str) -> Self {
        match serde_json::from_str::<Settings>(text) {
            Ok(settings) if settings.validate().is_ok() => settings,
            _ => Settings::default(),
        }
    }

    fn load(path: Option<&Path>) -> Self {
        path.and_then(|p| store::read_capped(p, MAX_FILE_BYTES))
            .map(|text| Self::parse(&text))
            .unwrap_or_default()
    }

    /// 拼进 JS 的字面量。字段都过了校验（只有布尔、数字和受限字符），JSON 本身就是合法的 JS 表达式。
    pub fn to_js(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".into())
    }
}

fn write_atomically(path: &Path, settings: &Settings) -> std::io::Result<()> {
    let text = serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?;
    store::write_atomically(path, &text)
}

pub struct SettingsState {
    current: Mutex<Settings>,
    path: Option<PathBuf>,
}

impl SettingsState {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let path = store::data_dir(app).map(|dir| dir.join("feature-settings.json"));
        Self {
            current: Mutex::new(Settings::load(path.as_deref())),
            path,
        }
    }

    pub fn current(&self) -> Settings {
        self.current.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn save(&self, next: Settings) -> Result<Settings, String> {
        next.validate()?;
        let path = self.path.as_deref().ok_or("找不到应用数据目录")?;
        let mut current = self.current.lock().map_err(|e| e.to_string())?;
        write_atomically(path, &next).map_err(|e| format!("设置保存失败：{e}"))?;
        *current = next.clone();
        Ok(next)
    }
}

/// 把当前设置推给粉笔页面（`page-settings.js` 的入口）。页面上没有这个入口（不是粉笔页面）时什么都不做。
pub fn apply_script(settings: &Settings) -> String {
    format!(
        "window.__fenbiApplySettings && window.__fenbiApplySettings({});",
        settings.to_js()
    )
}

/// 设置页面打开时读：(当前设置, 默认设置)。默认设置给「恢复默认」用。
#[tauri::command]
pub fn feature_settings(
    webview: Webview,
    state: tauri::State<'_, SettingsState>,
) -> Result<(Settings, Settings), String> {
    require_toolbar(webview.label())?;
    Ok((state.current(), Settings::default()))
}

/// 保存一份完整设置并立刻推给粉笔页面；返回存下的那份。不合法就原样拒绝、文件不动。
#[tauri::command]
pub fn save_feature_settings(
    webview: Webview,
    app: tauri::AppHandle,
    settings: Settings,
) -> Result<Settings, String> {
    require_toolbar(webview.label())?;
    let saved = app.state::<SettingsState>().save(settings)?;
    super::marks::on_settings_saved(&app);
    if let Some(content) = app.get_webview(CONTENT) {
        let _ = content.eval(apply_script(&saved));
    }
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_fixture_the_js_tests_use() {
        // JS 测试用 tests/fixtures/default-settings.json 当作「Rust 注入的默认设置」。两边必须一致。
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/default-settings.json"))
                .unwrap();
        assert_eq!(serde_json::to_value(Settings::default()).unwrap(), fixture);
        assert!(Settings::default().validate().is_ok());
    }

    #[test]
    fn a_saved_file_reads_back_the_same() {
        let dir = store::temp_dir("settings");
        let path = dir.join("feature-settings.json");
        let mut settings = Settings::default();
        settings.highlight.mode = "key".into();
        settings.highlight.colors[1] = "#123abc".into();
        settings.split.left_percent = 40;
        write_atomically(&path, &settings).unwrap();
        assert_eq!(Settings::load(Some(&path)), settings);
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            1,
            "临时文件要改名掉"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_or_broken_files_fall_back_to_defaults() {
        assert_eq!(Settings::load(None), Settings::default());
        assert_eq!(
            Settings::load(Some(Path::new("/definitely/not/here.json"))),
            Settings::default()
        );
        for text in [
            "",
            "not json",
            "[]",
            "{\"split\": 3}",
            "{\"highlight\": {\"enabled\": \"yes\"}}",
        ] {
            assert_eq!(Settings::parse(text), Settings::default(), "{text}");
        }
    }

    #[test]
    fn any_invalid_field_resets_the_whole_file() {
        // 合法字段（左栏 40%）也不保留：整份回落默认值。
        let invalid = [
            r##"{"split":{"leftPercent":40,"minWidth":100}}"##,
            r##"{"split":{"leftPercent":80}}"##,
            r##"{"split":{"leftPercent":40},"highlight":{"mode":"hover"}}"##,
            r##"{"split":{"leftPercent":40},"highlight":{"colors":["#fff","#000000","#111111"]}}"##,
            r##"{"split":{"leftPercent":40},"highlight":{"colors":["#ffffff"]}}"##,
            r##"{"split":{"leftPercent":40},"highlight":{"colors":["#FFFFFF","#000000","#111111"]}}"##,
            r##"{"split":{"leftPercent":40},"highlight":{"toggleKey":"KeyC"}}"##,
            r##"{"split":{"leftPercent":40},"highlight":{"toggleKey":"Escape"}}"##,
            r##"{"split":{"leftPercent":40},"highlight":{"toggleKey":"</script>"}}"##,
            r##"{"split":{"leftPercent":40},"highlight":{"retentionDays":14}}"##,
        ];
        for text in invalid {
            assert_eq!(Settings::parse(text), Settings::default(), "{text}");
        }
    }

    #[test]
    fn a_key_taken_by_the_toolbar_or_the_system_resets_the_whole_file() {
        // 和录入框同一份定义（shortcuts.js 的两张表）：这里核对解析出来的内容，免得 JSON 被改坏后悄悄变空。
        let mac = reserved_shortcuts(true);
        let win = reserved_shortcuts(false);
        for key in [
            "Meta+BracketLeft",
            "Meta+KeyR",
            "Shift+Meta+KeyB",
            "Meta+KeyC",
            "Meta+KeyV",
        ] {
            assert!(mac.iter().any(|k| k == key), "mac {key}");
        }
        for key in [
            "Alt+ArrowLeft",
            "Ctrl+KeyR",
            "Ctrl+Shift+KeyB",
            "Ctrl+KeyV",
            "Alt+F4",
        ] {
            assert!(win.iter().any(|k| k == key), "win {key}");
        }
        for (mac, key) in [
            (true, "Meta+KeyR"),
            (true, "Shift+Meta+KeyB"),
            (true, "Meta+KeyC"),
            (false, "Ctrl+KeyR"),
            (false, "Alt+F4"),
        ] {
            let mut settings = Settings::default();
            settings.split.left_percent = 40;
            settings.highlight.toggle_key = key.into();
            assert!(settings.validate_on(mac).is_err(), "{mac} {key}");
        }
        let mut fine = Settings::default();
        fine.highlight.toggle_key = "Meta+KeyR".into();
        assert!(
            fine.validate_on(false).is_ok(),
            "mac 的键在 Windows 上不算占用"
        );
        let text = format!(
            r#"{{"split":{{"leftPercent":40}},"highlight":{{"toggleKey":"{}"}}}}"#,
            if cfg!(target_os = "macos") {
                "Meta+KeyR"
            } else {
                "Ctrl+KeyR"
            }
        );
        assert_eq!(
            Settings::parse(&text),
            Settings::default(),
            "一项冲突整份回落"
        );
    }

    #[test]
    fn missing_fields_take_defaults_and_unknown_ones_are_ignored() {
        let settings = Settings::parse(r#"{"split":{"leftPercent":40},"later":1}"#);
        assert_eq!(settings.split.left_percent, 40);
        assert_eq!(settings.split.min_width, 1400);
        assert_eq!(settings.highlight, Highlight::default());
    }

    #[test]
    fn shortcuts_are_codes_with_ordered_modifiers() {
        for ok in [
            "KeyV",
            "Shift+KeyV",
            "Ctrl+Alt+Shift+Meta+KeyZ",
            "Alt+Digit3",
            "F1",
            "Meta+F12",
        ] {
            assert!(valid_shortcut(ok), "{ok}");
        }
        for bad in [
            "",
            "V",
            "KeyV+Shift",
            "Shift+Ctrl+KeyV",
            "Shift+Shift+KeyV",
            "Keyv",
            "KeyAB",
            "F0",
            "F13",
            "F01",
            "Digit10",
            "Escape",
            "Cmd+KeyV",
            "Shift+",
        ] {
            assert!(!valid_shortcut(bad), "{bad}");
        }
    }

    #[test]
    fn the_page_script_carries_settings_as_data() {
        let script = apply_script(&Settings::default());
        assert!(script.starts_with("window.__fenbiApplySettings && window.__fenbiApplySettings({"));
        assert!(script.contains("\"leftPercent\":50"));
    }

    #[test]
    fn the_website_is_granted_none_of_the_settings_commands() {
        let website = [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities/dev/loopback.json"),
        ];
        let toolbar = include_str!("../capabilities/toolbar.json");
        for permission in ["allow-feature-settings", "allow-save-feature-settings"] {
            assert!(toolbar.contains(permission), "{permission}");
            assert!(
                website.iter().all(|c| !c.contains(permission)),
                "{permission}"
            );
        }
        assert!(require_toolbar(CONTENT).is_err());
    }
}
