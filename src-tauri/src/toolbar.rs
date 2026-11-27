//! App-owned toolbar and content occupy separate child WebViews.
use std::sync::Mutex;
use tauri::{Manager, Webview, Window};

pub const CONTENT: &str = "main"; // Preserve the existing webview identity and data store.
pub const TOOLBAR: &str = "toolbar";
pub const EXPANDED_HEIGHT: f64 = 36.0;
pub const COLLAPSED_HEIGHT: f64 = 24.0;

/// 工具栏页面要画的状态。`revision` 每变一次加一，页面靠它丢掉晚到的旧快照。
#[derive(Clone, Copy, Debug, PartialEq)]
struct View {
    revision: u64,
    collapsed: bool,
    /// 设置页面开着没有。只活在内存里，重启后是关着的。
    settings_open: bool,
}

impl View {
    /// 设置页面开着时，工具栏上只有齿轮能用。
    fn actions_enabled(&self) -> bool {
        !self.settings_open
    }

    /// 返回有没有真的切换。
    fn toggle_collapsed(&mut self) -> bool {
        if !self.actions_enabled() {
            return false;
        }
        self.revision += 1;
        self.collapsed = !self.collapsed;
        true
    }

    /// 返回有没有真的切换。收起时没有齿轮，所以收起时打不开设置页面。
    fn toggle_settings(&mut self) -> bool {
        if self.collapsed && !self.settings_open {
            return false;
        }
        self.revision += 1;
        self.settings_open = !self.settings_open;
        true
    }
}

pub struct ToolbarState {
    view: Mutex<View>,
    target: String,
}

impl ToolbarState {
    pub fn new(app: &tauri::AppHandle, target: &str) -> Self {
        let collapsed = state_path(app)
            .and_then(|path| std::fs::read_to_string(path).ok())
            .is_some_and(|s| s.trim() == "collapsed");
        Self {
            view: Mutex::new(View {
                revision: 0,
                collapsed,
                settings_open: false,
            }),
            target: target.into(),
        }
    }
}

fn state_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("toolbar-state"))
}

pub fn local_url_allowed(url: &tauri::Url) -> bool {
    ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")))
        && matches!(url.path(), "" | "/" | "/index.html")
}

fn require_toolbar(label: &str) -> Result<(), String> {
    if label == TOOLBAR {
        Ok(())
    } else {
        Err("仅本地工具栏可调用此命令".into())
    }
}

#[tauri::command]
pub fn toolbar_state(
    webview: Webview,
    state: tauri::State<'_, ToolbarState>,
    updates: tauri::State<'_, super::update::UpdateState>,
) -> Result<(u64, bool, bool, bool), String> {
    require_toolbar(webview.label())?;
    let view = *state.view.lock().map_err(|e| e.to_string())?;
    Ok((
        view.revision,
        view.collapsed,
        updates.has_update(),
        view.settings_open,
    ))
}

/// Runs the whole resize transaction on the UI thread, avoiding out-of-order bounds
/// when a shortcut and a button toggle arrive together. No website navigation here.
#[tauri::command]
pub async fn toggle_toolbar(webview: Webview, app: tauri::AppHandle) -> Result<(), String> {
    if !matches!(webview.label(), CONTENT | TOOLBAR) {
        return Err("未知的 WebView".into());
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<ToolbarState>();
        let collapsed = {
            let mut view = state.view.lock().unwrap();
            if !view.toggle_collapsed() {
                return;
            }
            view.collapsed
        };
        if let Some(path) = state_path(&handle) {
            let save = || -> std::io::Result<()> {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(path, if collapsed { "collapsed" } else { "expanded" })
            };
            if let Err(e) = save() {
                eprintln!("[fenbi-wrapper] toolbar state save: {e}");
            }
        }
        if let Some(window) = handle.get_window(super::WINDOW_LABEL)
            && let Err(e) = layout(&window)
        {
            eprintln!("[fenbi-wrapper] toolbar layout: {e}");
        }
        if let Some(view) = handle.get_webview(TOOLBAR) {
            let _ = view.eval("window.__fenbiRefreshToolbar && window.__fenbiRefreshToolbar();");
        }
        if let Some(view) = handle.get_webview(CONTENT) {
            let _ = view.set_focus();
        }
    })
    .map_err(|e| e.to_string())
}

/// Local toolbar only; site shortcuts keep operating their own history in init.js.
#[tauri::command]
pub async fn toolbar_action(
    webview: Webview,
    action: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    require_toolbar(webview.label())?;
    let state = app.state::<ToolbarState>();
    if !state
        .view
        .lock()
        .map_err(|e| e.to_string())?
        .actions_enabled()
    {
        return Ok(());
    }
    let script = action_script(&action, &state.target)?;
    let content = app.get_webview(CONTENT).ok_or("内容 WebView 不存在")?;
    content.eval(script).map_err(|e| e.to_string())?;
    content.set_focus().map_err(|e| e.to_string())
}

/// 开关设置页面。开着时工具栏 WebView 撑满窗口、拿走键盘焦点（Esc 由它收），
/// 粉笔页面挪到窗口之外；关掉时摆回原样、焦点还给粉笔页面。不碰粉笔页面的内容。
#[tauri::command]
pub async fn toggle_settings(webview: Webview, app: tauri::AppHandle) -> Result<(), String> {
    require_toolbar(webview.label())?;
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<ToolbarState>();
        let open = {
            let mut view = state.view.lock().unwrap();
            if !view.toggle_settings() {
                return;
            }
            view.settings_open
        };
        if let Some(window) = handle.get_window(super::WINDOW_LABEL)
            && let Err(e) = layout(&window)
        {
            eprintln!("[fenbi-wrapper] settings layout: {e}");
        }
        if let Some(view) = handle.get_webview(TOOLBAR) {
            let _ = view.eval("window.__fenbiRefreshToolbar && window.__fenbiRefreshToolbar();");
        }
        if let Some(view) = handle.get_webview(if open { TOOLBAR } else { CONTENT }) {
            let _ = view.set_focus();
        }
    })
    .map_err(|e| e.to_string())
}

fn action_script(action: &str, target: &str) -> Result<String, String> {
    match action {
        "back" => Ok("history.back()".into()),
        "forward" => Ok("history.forward()".into()),
        "reload" => Ok("location.reload()".into()),
        "catalog" => {
            let target = serde_json::to_string(target).map_err(|e| e.to_string())?;
            Ok(format!(
                "if (location.href !== {target}) location.assign({target})"
            ))
        }
        _ => Err("未知的工具栏操作".into()),
    }
}

fn heights(total: f64, collapsed: bool) -> (f64, f64) {
    let bar = if collapsed {
        COLLAPSED_HEIGHT
    } else {
        EXPANDED_HEIGHT
    }
    .min(total.max(0.0));
    (bar, (total - bar).max(0.0))
}

/// 两个 WebView 各自的 (y, 高度)：先工具栏，后粉笔页面。
/// 设置页面开着时工具栏 WebView 撑满窗口；粉笔页面大小不变、挪到窗口下边缘之外，
/// 所以它不重新排版，回来时和离开时一样。
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn frames(total: f64, view: View) -> ((f64, f64), (f64, f64)) {
    let (bar, content) = heights(total, view.collapsed);
    if view.settings_open {
        ((0.0, total), (total, content))
    } else {
        ((0.0, bar), (bar, content))
    }
}

/// macOS / Windows：两个子 WebView 是绝对定位的，直接给坐标和尺寸。
#[cfg(not(target_os = "linux"))]
pub fn layout(window: &Window) -> tauri::Result<()> {
    use tauri::{LogicalPosition, LogicalSize};
    let state = window.state::<ToolbarState>();
    let view = *state.view.lock().unwrap();
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    let (toolbar, content) = frames(size.height, view);
    for (label, (y, h)) in [(TOOLBAR, toolbar), (CONTENT, content)] {
        if let Some(view) = window.app_handle().get_webview(label) {
            view.set_bounds(tauri::Rect {
                position: LogicalPosition::new(0.0, y).into(),
                size: LogicalSize::new(size.width, h).into(),
            })?;
        }
    }
    Ok(())
}

/// Linux：tauri-runtime-wry 把子 WebView `pack_start(expand=true)` 进窗口的 GtkBox，
/// `set_bounds` 对 GtkBox 里的子控件是空操作，结果两个 WebView 各占一半窗口高度
/// （实测：700 高的窗口里内容区 innerHeight=350，上半截是工具栏页面的空白）。
/// 这里直接改 GTK packing：工具栏不扩展、固定高度；内容区 expand 吃掉剩余空间。
/// 宽度由 GtkBox 自己填满，不用管。
/// 设置页面开着时：GtkBox 里没法把控件挪到窗口之外，所以把粉笔页面的控件隐藏、
/// 让工具栏 expand 吃掉全部空间（这一段没有在 Linux 真机上验证过）。
#[cfg(target_os = "linux")]
pub fn layout(window: &Window) -> tauri::Result<()> {
    let state = window.state::<ToolbarState>();
    let view = *state.view.lock().unwrap();
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    let (height, _) = heights(size.height, view.collapsed);
    let open = view.settings_open;
    let bar_request = if open { -1 } else { height as i32 };
    for (label, expand, request, visible) in [
        (TOOLBAR, open, bar_request, true),
        (CONTENT, true, -1, !open),
    ] {
        if let Some(view) = window.app_handle().get_webview(label) {
            // 闭包在主线程执行；gtk 对象不是 Send，所以从控件自己往上找父容器，
            // 而不是在这里拿 window.default_vbox() 传进去。
            view.with_webview(move |platform| {
                use gtk::prelude::*;
                let widget = platform.inner();
                widget.set_size_request(-1, request);
                widget.set_visible(visible);
                if let Some(vbox) = widget.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) {
                    vbox.set_child_packing(&widget, expand, expand, 0, gtk::PackType::Start);
                }
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_toolbar_accepts_normalized_index_but_rejects_other_pages() {
        for url in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
        ] {
            assert!(local_url_allowed(&url.parse().unwrap()), "{url}");
        }
        for url in [
            "https://www.fenbi.com/",
            "tauri://localhost/other.html",
            "https://evil.example/index.html",
        ] {
            assert!(!local_url_allowed(&url.parse().unwrap()), "{url}");
        }
    }

    #[test]
    fn content_and_toolbar_fill_the_window_without_overlap() {
        for total in [0.0, 15.0, 640.0, 880.5] {
            for collapsed in [false, true] {
                let (bar, content) = heights(total, collapsed);
                assert!(bar >= 0.0 && content >= 0.0);
                assert_eq!(bar + content, total);
            }
        }
        assert_eq!(heights(880.0, false), (36.0, 844.0));
        assert_eq!(heights(880.0, true), (24.0, 856.0));
    }
    #[test]
    fn website_cannot_use_toolbar_navigation_commands() {
        assert!(require_toolbar(CONTENT).is_err());
        assert!(require_toolbar("other").is_err());
        assert!(require_toolbar(TOOLBAR).is_ok());
        assert!(action_script("eval", "https://www.fenbi.com").is_err());
    }
    fn view(collapsed: bool, settings_open: bool) -> View {
        View {
            revision: 0,
            collapsed,
            settings_open,
        }
    }
    #[test]
    fn settings_page_gives_the_whole_window_to_the_toolbar_webview() {
        // 关着：和原来一样，上下相接。
        assert_eq!(
            frames(880.0, view(false, false)),
            ((0.0, 36.0), (36.0, 844.0))
        );
        assert_eq!(
            frames(880.0, view(true, false)),
            ((0.0, 24.0), (24.0, 856.0))
        );
        // 开着：工具栏 WebView 占满窗口；粉笔页面在窗口下边缘之外，大小不变。
        let (toolbar, content) = frames(880.0, view(false, true));
        assert_eq!(toolbar, (0.0, 880.0));
        assert!(content.0 >= 880.0, "粉笔页面必须整个在窗口之外");
        assert_eq!(content.1, 844.0, "大小不变，页面才不会重新排版");
    }
    #[test]
    fn toolbar_actions_and_collapse_do_nothing_while_settings_page_is_open() {
        let mut open = view(false, true);
        assert!(!open.actions_enabled());
        assert!(!open.toggle_collapsed());
        assert_eq!(open, view(false, true), "收起被拒绝时状态和序号都不变");
        assert!(view(false, false).actions_enabled());
    }
    #[test]
    fn settings_page_opens_and_closes_and_bumps_the_revision() {
        let mut state = view(false, false);
        assert!(state.toggle_settings());
        assert!(state.settings_open);
        assert_eq!(state.revision, 1);
        assert!(state.toggle_settings());
        assert!(!state.settings_open);
        assert_eq!(state.revision, 2);
        // 收起时没有齿轮，不能打开。
        let mut collapsed = view(true, false);
        assert!(!collapsed.toggle_settings());
        assert_eq!(collapsed, view(true, false));
    }
    #[test]
    fn catalog_action_encodes_url_as_data_and_keeps_history() {
        let target = "https://www.fenbi.com/?q=\";alert(1)//";
        let script = action_script("catalog", target).unwrap();
        let literal = serde_json::to_string(target).unwrap();
        assert!(
            script.contains(&format!("location.assign({literal})")),
            "{script}"
        );
        assert!(
            script.contains(&format!("location.href !== {literal}")),
            "already at the catalog must be a no-op: {script}"
        );
        assert!(!script.contains("location.replace("), "{script}");
    }
}
