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

    for name in ["init.js", "init-debug.js", "toolbar/shortcuts.js"] {
        let src = Path::new(name);
        println!("cargo:rerun-if-changed={name}");
        let dest = dest_dir.join(Path::new(name).file_name().unwrap());
        if src.exists()
            && let Err(e) = std::fs::copy(src, &dest)
        {
            // 拷贝失败不该让构建挂掉，回退到内嵌版本即可
            println!("cargo:warning=拷贝 {name} 到 {} 失败: {e}", dest.display());
        }
    }

    // ── 授权按构建模式分开 ─────────────────────────────────────────────
    //
    // `capabilities/*.json` 是 release 也带的授权；`capabilities/dev/` 里的回环地址
    // （对着本地假站点验证用）和诊断命令只在 debug 构建编进去。tauri-build 默认
    // 递归读整个 capabilities/ 目录，所以 release 要显式收窄到顶层。
    println!("cargo:rerun-if-changed=capabilities");
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let capabilities = if profile == "release" {
        "./capabilities/*"
    } else {
        "./capabilities/**/*"
    };

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .capabilities_path_pattern(capabilities)
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "current_login_decision",
                "debug_request_logout",
                "toolbar_action",
                "toolbar_state",
                "toggle_toolbar",
            ])),
    )
    .expect("生成 Tauri 权限失败")
}
