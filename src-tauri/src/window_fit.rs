// 把窗口收进显示器工作区（#9）。
//
// window-state 插件按记录原样恢复尺寸，不看当前屏幕多大；默认尺寸 1180×880
// 在 1024×768 这种小屏上取消最大化后也会跑出屏幕。这里只做几何计算，
// 全部用物理像素，调用方负责读写真实窗口。

/// 物理像素矩形：左上角 + 尺寸。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 收进工作区后的结果：整窗左上角位置 + **内容区**尺寸（`set_size` 设的是内容区）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fitted {
    pub x: i32,
    pub y: i32,
    pub inner_width: u32,
    pub inner_height: u32,
}

/// `outer` 是整窗矩形（含边框标题栏），`decor` 是整窗减内容区的差值，
/// `min_inner` 是内容区最小尺寸。整窗比工作区大就缩小（不小于最小尺寸），
/// 越界就推回工作区；本来就在里面的原样返回。
pub fn fit_to_work_area(
    work: Rect,
    outer: Rect,
    decor: (u32, u32),
    min_inner: (u32, u32),
) -> Fitted {
    let (dw, dh) = decor;
    let width = outer.width.min(work.width).max(min_inner.0 + dw);
    let height = outer.height.min(work.height).max(min_inner.1 + dh);
    Fitted {
        x: clamp_axis(outer.x, width, work.x, work.width),
        y: clamp_axis(outer.y, height, work.y, work.height),
        inner_width: width - dw,
        inner_height: height - dh,
    }
}

/// 窗口状态插件上次存的记录：整窗位置 + 内容区尺寸 + 是否最大化。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Saved {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// 建窗后怎么摆：普通状态的位置尺寸（拿不到任何显示器时为空），以及要不要最大化。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub fitted: Option<Fitted>,
    pub maximize: bool,
}

/// 有记录就按记录摆，没有（首次启动）就用默认窗口并最大化；两种都先收进工作区。
/// 记录落在哪块显示器的工作区就收进哪块，哪块都不沾（外接屏拔了）就回主屏。
pub fn place(
    saved: Option<Saved>,
    default_outer: Rect,
    decor: (u32, u32),
    min_inner: (u32, u32),
    work_areas: &[Rect],
    primary: Option<Rect>,
) -> Placement {
    let desired = saved.map_or(default_outer, |s| Rect {
        x: s.x,
        y: s.y,
        width: s.width + decor.0,
        height: s.height + decor.1,
    });
    let area = work_areas
        .iter()
        .copied()
        .find(|a| overlaps(*a, desired))
        .or(primary)
        .or_else(|| work_areas.first().copied());
    Placement {
        fitted: area.map(|a| fit_to_work_area(a, desired, decor, min_inner)),
        maximize: saved.is_none_or(|s| s.maximized),
    }
}

fn overlaps(a: Rect, b: Rect) -> bool {
    let (a_right, a_bottom) = (a.x + a.width as i32, a.y + a.height as i32);
    let (b_right, b_bottom) = (b.x + b.width as i32, b.y + b.height as i32);
    a.x < b_right && b.x < a_right && a.y < b_bottom && b.y < a_bottom
}

/// 一条轴上把 [pos, pos+len) 推进 [start, start+span)；放不下时贴住起点，保证标题栏可见。
fn clamp_axis(pos: i32, len: u32, start: i32, span: u32) -> i32 {
    let max = start + span as i32 - len as i32;
    if max < start {
        start
    } else {
        pos.clamp(start, max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Windows 11 虚拟机实测：屏幕 1024×768，任务栏占掉底部 48，边框+标题栏 16×39
    const WORK: Rect = Rect {
        x: 0,
        y: 0,
        width: 1024,
        height: 720,
    };
    const DECOR: (u32, u32) = (16, 39);
    const MIN: (u32, u32) = (900, 640);

    fn outer(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn oversized_default_window_shrinks_into_the_work_area() {
        // 默认内容区 1180×880 → 整窗 1196×919，比整块屏幕都大
        let fitted = fit_to_work_area(WORK, outer(0, 0, 1196, 919), DECOR, MIN);
        assert_eq!(
            fitted,
            Fitted {
                x: 0,
                y: 0,
                inner_width: 1008,
                inner_height: 681
            }
        );
    }

    #[test]
    fn window_hanging_off_the_bottom_right_is_pushed_back() {
        // 实测复现：(100,80) 起 1000×700，右边超出屏幕、底边压在任务栏下
        let fitted = fit_to_work_area(WORK, outer(100, 80, 1000, 700), DECOR, MIN);
        assert_eq!(
            fitted,
            Fitted {
                x: 24,
                y: 20,
                inner_width: 984,
                inner_height: 661
            }
        );
    }

    #[test]
    fn window_left_on_a_disconnected_monitor_comes_back() {
        // 记录的位置在拔掉的外接屏上（主屏右边）
        let fitted = fit_to_work_area(WORK, outer(2500, 300, 950, 700), DECOR, MIN);
        assert_eq!(
            fitted,
            Fitted {
                x: 74,
                y: 20,
                inner_width: 934,
                inner_height: 661
            }
        );
    }

    #[test]
    fn window_already_inside_is_untouched() {
        let fitted = fit_to_work_area(WORK, outer(10, 10, 950, 690), DECOR, MIN);
        assert_eq!(
            fitted,
            Fitted {
                x: 10,
                y: 10,
                inner_width: 934,
                inner_height: 651
            }
        );
    }

    fn saved(x: i32, y: i32, width: u32, height: u32, maximized: bool) -> Saved {
        Saved {
            x,
            y,
            width,
            height,
            maximized,
        }
    }

    #[test]
    fn first_launch_fits_the_default_window_then_maximizes() {
        // 首次启动：取消最大化后回到的普通尺寸也必须在屏幕里
        let p = place(
            None,
            outer(0, 0, 1196, 919),
            DECOR,
            MIN,
            &[WORK],
            Some(WORK),
        );
        assert!(p.maximize);
        assert_eq!(
            p.fitted.map(|f| (f.inner_width, f.inner_height)),
            Some((1008, 681))
        );
    }

    #[test]
    fn record_on_an_unplugged_monitor_lands_on_the_primary_one() {
        // 外接屏在主屏右边，记录在外接屏上；现在只剩主屏
        let p = place(
            Some(saved(3000, 200, 1600, 1000, false)),
            outer(0, 0, 1196, 919),
            DECOR,
            MIN,
            &[WORK],
            Some(WORK),
        );
        assert!(!p.maximize);
        let f = p.fitted.unwrap();
        assert_eq!((f.x, f.y, f.inner_width, f.inner_height), (0, 0, 1008, 681));
    }

    #[test]
    fn record_on_the_second_monitor_stays_there() {
        let second = Rect {
            x: 1024,
            y: 0,
            width: 1920,
            height: 1040,
        };
        let p = place(
            Some(saved(1200, 100, 1000, 700, false)),
            outer(0, 0, 1196, 919),
            DECOR,
            MIN,
            &[WORK, second],
            Some(WORK),
        );
        let f = p.fitted.unwrap();
        assert_eq!(
            (f.x, f.y, f.inner_width, f.inner_height),
            (1200, 100, 1000, 700)
        );
    }

    #[test]
    fn maximized_record_is_maximized_again() {
        let p = place(
            Some(saved(4, 66, 1000, 700, true)),
            outer(0, 0, 1196, 919),
            DECOR,
            MIN,
            &[WORK],
            Some(WORK),
        );
        assert!(p.maximize);
    }

    #[test]
    fn min_size_wins_over_a_tiny_work_area_and_title_bar_stays_reachable() {
        // 工作区比最小窗口还小：保持最小尺寸，贴住左上角，标题栏不跑出屏幕
        let tiny = Rect {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
        };
        let fitted = fit_to_work_area(tiny, outer(50, 50, 1196, 919), DECOR, MIN);
        assert_eq!(
            fitted,
            Fitted {
                x: 0,
                y: 0,
                inner_width: 900,
                inner_height: 640
            }
        );
    }
}
