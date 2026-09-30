//! App-owned toolbar and content occupy separate child WebViews.
use std::sync::Mutex;
use tauri::{LogicalPosition, LogicalSize, Manager, Webview, Window};

pub const CONTENT: &str = "main"; // Preserve the existing webview identity and data store.
pub const TOOLBAR: &str = "toolbar";
pub const EXPANDED_HEIGHT: f64 = 36.0;
pub const COLLAPSED_HEIGHT: f64 = 24.0;

pub struct ToolbarState {
    view: Mutex<(u64, bool)>,
    target: String,
}

impl ToolbarState {
    pub fn new(app: &tauri::AppHandle, target: &str) -> Self {
        let collapsed = state_path(app)
            .and_then(|path| std::fs::read_to_string(path).ok())
            .is_some_and(|s| s.trim() == "collapsed");
        Self {
            view: Mutex::new((0, collapsed)),
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
) -> Result<(u64, bool), String> {
    require_toolbar(webview.label())?;
    Ok(*state.view.lock().map_err(|e| e.to_string())?)
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
            let mut value = state.view.lock().unwrap();
            value.0 += 1;
            value.1 = !value.1;
            value.1
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
    let script = action_script(&action, &state.target)?;
    let content = app.get_webview(CONTENT).ok_or("内容 WebView 不存在")?;
    content.eval(script).map_err(|e| e.to_string())?;
    content.set_focus().map_err(|e| e.to_string())
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

pub fn layout(window: &Window) -> tauri::Result<()> {
    let state = window.state::<ToolbarState>();
    let collapsed = state.view.lock().unwrap().1;
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    let (height, content_height) = heights(size.height, collapsed);
    for (label, y, h) in [(TOOLBAR, 0.0, height), (CONTENT, height, content_height)] {
        if let Some(view) = window.app_handle().get_webview(label) {
            view.set_bounds(tauri::Rect {
                position: LogicalPosition::new(0.0, y).into(),
                size: LogicalSize::new(size.width, h).into(),
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
