//! 功能设置（settings.rs）和划词标记（marks.rs）这两份数据文件：放在哪、怎么读、怎么原子写。
//!
//! - debug 构建（`pnpm dev`）和正式版用同一个 identifier、同一个应用数据目录，又允许同时开着；
//!   两份进程各自拿内存副本整份写回，会互相盖掉。所以 debug 构建的这两份文件放在 `dev/` 子目录，和正式版完全隔离。
//!   （同一版本内是单实例，不做跨进程锁。）
//! - 写入：同目录独占创建一个唯一名字的临时文件，写完改名。改名是原子的，读的一方要么看到旧文件，要么看到新文件；
//!   两次写入也不会抢同一个临时文件。
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

/// 数据文件所在目录：正式版是应用数据目录本身，debug 构建是它下面的 `dev/`。
pub fn data_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|base| scoped(base, cfg!(debug_assertions)))
}

fn scoped(base: PathBuf, debug: bool) -> PathBuf {
    if debug { base.join("dev") } else { base }
}

/// 读整个文件；读不到、或比 `max` 字节大（不是包装层写出来的）都当没有。
pub fn read_capped(path: &Path, max: usize) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > max {
        return None;
    }
    String::from_utf8(bytes).ok()
}

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 先写同目录下独占创建的临时文件（`.<文件名>.<进程号>.<序号>.tmp`），再改名成 `path`。
pub fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("没有上级目录"))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| std::io::Error::other("文件名不对"))?;
    std::fs::create_dir_all(parent)?;
    let (pending, mut file) = loop {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let pending = parent.join(format!(".{name}.{}.{seq}.tmp", std::process::id()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
        {
            Ok(file) => break (pending, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    };
    let written = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| {
            drop(file);
            std::fs::rename(&pending, path)
        });
    if written.is_err() {
        let _ = std::fs::remove_file(&pending);
    }
    written
}

#[cfg(test)]
pub(crate) fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fenbi-store-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_and_release_builds_never_share_a_data_file() {
        let base = PathBuf::from("/data/com.fenbi.wrapper");
        let release = scoped(base.clone(), false);
        let debug = scoped(base.clone(), true);
        assert_eq!(release, base);
        assert_ne!(debug, release);
        for file in ["feature-settings.json", "practice-marks.json"] {
            assert_ne!(debug.join(file), release.join(file));
            assert!(!debug.join(file).starts_with(release.join(file)), "{file}");
        }
    }

    #[test]
    fn temp_files_are_unique_siblings_and_leave_nothing_behind() {
        let dir = temp_dir("atomic");
        let path = dir.join("practice-marks.json");
        // 有人（另一份进程）留了一个看起来一样的临时文件：独占创建不会去写它。
        std::fs::create_dir_all(&dir).unwrap();
        let squatter = dir.join(format!(
            ".practice-marks.json.{}.{}.tmp",
            std::process::id(),
            TEMP_SEQ.load(Ordering::Relaxed)
        ));
        std::fs::write(&squatter, b"other").unwrap();

        write_atomically(&path, b"one").unwrap();
        write_atomically(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert_eq!(
            std::fs::read(&squatter).unwrap(),
            b"other",
            "别人的临时文件不动"
        );
        let mut left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec![
                squatter.file_name().unwrap().to_str().unwrap().to_string(),
                "practice-marks.json".to_string()
            ]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_rename_keeps_the_old_file_and_cleans_up() {
        let dir = temp_dir("rename-fails");
        // 目标是个非空目录：改名一定失败。
        let path = dir.join("practice-marks.json");
        std::fs::create_dir_all(path.join("blocker")).unwrap();
        assert!(write_atomically(&path, b"new").is_err());
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(left.len(), 1, "临时文件要删掉");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn oversized_files_read_as_missing() {
        let dir = temp_dir("capped");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.json");
        std::fs::write(&path, b"12345").unwrap();
        assert_eq!(read_capped(&path, 5).as_deref(), Some("12345"));
        assert_eq!(read_capped(&path, 4), None);
        assert_eq!(read_capped(&dir.join("missing"), 4), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
