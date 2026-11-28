# 界面设计 skill 按项目安装

包装层自己画的界面（设置页面等）用三个外部 skill 辅助：`impeccable` 做设计评审和打磨，`modern-web-guidance` 查现代 web 写法，`hallmark` 只在点名时查「AI 味」。三个都装在本仓库里，不装到用户全局。

装在项目里的理由：本项目的口味钉死在 `DESIGN.md`（克制、安静、像系统自带的设置、只做浅色）。这三个 skill 的默认倾向更适合品牌化的落地页，与本项目相反。装在项目里，`AGENTS.md` 才能在同一处写明「冲突时听 DESIGN.md」，这条约束跟着仓库走，不依赖某台机器的全局配置。

skill 的内容不进仓库，`.gitignore` 掉 `.claude/skills/` 和 `.agents/`，只提交 `skills-lock.json`（记着三个 skill 的来源仓库和 commit）。新机器或新 worktree 里跑 `npx skills install` 还原。

## 没选的做法

- **装到全局 `~/.claude/skills`**：全局那份对所有项目生效，没地方写本项目「听 DESIGN.md」这条约束。
- **把 skill 内容提交进仓库**：本仓库是公开仓库，三个 skill 加起来约 13 MB（主题素材、下载二进制的启动器、269 份指引文档），每次升级都是一大坨与本项目无关的 diff。
- **连 `skills-lock.json` 都不提交**：换机器后没有记录，不知道装过哪三个、什么版本。
- **用 `hallmark` 的主题化建站流程**：它的 50 个主题是给品牌化落地页用的材质，与 `DESIGN.md` 的口味相反。只保留 `/hallmark audit <path>`。
