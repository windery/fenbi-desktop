# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files in `docs/issues/`, committed to git.

## Conventions

- One piece of work per file: `docs/issues/<中文标题>.md`. The file name is the issue title.
- The line after the title is `状态：`. Its value is one of the triage roles in `triage-labels.md` (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), or `进行中`, or `已完成`. A short note in parentheses may follow, for example `状态：ready-for-agent（未开工，第 1 块待做）`.
- An issue holds what is true now: the goal, the decisions made, the chunks and which are done, the files to read.
- Comments and conversation history append to the bottom of the file under a `## 记录` heading.
- **List open issues**: the files directly under `docs/issues/`.
- **Close an issue**: set `状态：已完成` and move the file to `docs/issues/closed/`.

## GitHub Issues are the inbox for user feedback

Users report problems at <https://github.com/windery/fenbi-desktop/issues>. Read them with `gh issue view <number> --json number,title,body,comments`.

- When the maintainer decides to act on a report, create a file in `docs/issues/` with a `来源：GitHub 议题 #N` line under the status line. The work is tracked in that file.
- Replying to, labelling or closing a GitHub issue is an outward action. Do it only when the maintainer approves it.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a new file under `docs/issues/`.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the title directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `docs/issues/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `docs/issues/<effort>/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `docs/issues/<effort>/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer to the map's Decisions-so-far in `map.md`.
