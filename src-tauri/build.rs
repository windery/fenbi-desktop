use std::path::Path;

fn main() {
    // ── 开发期的脚本热加载 ─────────────────────────────────────────────
    //
    // `init.js` / `init-debug.js` 原本用 `include_str!` 编译进二进制，
    // 于是每改一行脚本都要重跑一次 release 编译（LTO 下一分半）。
    //
    // 这里把它们拷贝一份到 target 下，debug 构建改成运行时从磁盘读，
    // 调脚本就只花"退出 + 重开"的时间，不用重编译。
    // release 构建仍然用 include_str! 内嵌，保证产物自包含。
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR 未设置");
    let dest_dir = Path::new(&out_dir)
        .ancestors()
        .nth(3)
        .expect("无法定位 target 目录")
        .to_path_buf();

    for name in ["init.js", "init-debug.js"] {
        let src = Path::new(name);
        println!("cargo:rerun-if-changed={name}");
        let dest = dest_dir.join(name);
        if src.exists() {
            if let Err(e) = std::fs::copy(src, &dest) {
                // 拷贝失败不该让构建挂掉，回退到内嵌版本即可
                println!("cargo:warning=拷贝 {name} 到 {} 失败: {e}", dest.display());
            }
        }
    }

    tauri_build::build()
}
