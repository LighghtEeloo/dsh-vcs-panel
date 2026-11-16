# dsh-vcs-panel

English | [中文](README.zh.md)

Read-only version control inside DeepSeek Harness conversations. Adds a `VCS` tab to inspect working changes, syntax-highlighted diffs, and commit history with a lane graph—for both **Git** and **Jujutsu** repositories.

## Features

- **Timeline & lane graph.** Working changes (`Working tree` in Git, `@` in Jujutsu) sit above topological commit history with branches, bookmarks, tags, and scope toggle (`HEAD` / `@` or all commits). Supports multi-repository workspaces.
- **Inline change tree.** Browse changed files as a collapsible list, or expand any file to read its diff in place with sticky headers, unified or split view, and line wrapping.
- **Git & Jujutsu native.** Shows staged and unstaged groups (`?` for untracked items) and ahead/behind in Git; shows `@`, change IDs, and bookmarks in Jujutsu.
- **Turn banner & shortcut.** File-changing turns end with a compact VCS banner showing that turn's branch (or `@`), changed-file count, and `+` / `−` line totals in place of Chat's changed-files card. Toggle `VCS` from anywhere with `⌘⇧G` / `Ctrl+Shift+G`.
- **Strictly read-only.** Reads repository state only; never stages, commits, fetches, or rewrites history (Jujutsu only snapshots the working copy on read). Follows DSH themes and all 8 UI languages, and loads large histories and diffs on demand.

## Keyboard

| Keys | Action |
| --- | --- |
| `⌘⇧G` / `Ctrl+Shift+G` | Toggle `VCS` view and return to previous view (rebind in **Settings → Shortcuts**) |
| `↑` `↓` or `j` `k` | Move across commits or files |
| `←` `→` or `h` `l`, `Enter`, `Space` | Enter change tree, fold/expand rows, or return to timeline (`Esc` also returns) |
| `[` / `]` | Jump to previous / next diff hunk |

## Install

Requires **DSH 0.2.2-rc.1+** (Desktop or Web) and `git` or `jj` on `PATH`.

- **In DSH:** Open **Plugins → Add plugin**, select this directory, and restart DSH.
- **Via CLI:**
  ```sh
  dsh plugin --profile desktop add link:/path/to/dsh-vcs-panel
  ```
  Restart DSH after adding. Disable or uninstall in **Plugins** at any time (restores Chat's default changed-files card).

## Development

```sh
npm install          # install esbuild
npm run build        # build client.js from src/client/
npm run check        # run node --test and verify client.js is current
npm pack --dry-run   # verify package contents
```

Edit `src/client/` and run `npm run build` to update generated `client.js`. Run `dsh plugin` lifecycle checks against a temporary `DSH_HOME` to keep your real profile untouched.

Design: [`DESIGN.md`](DESIGN.md) · Implementation & limits: [`IMPLEMENTATION.md`](IMPLEMENTATION.md) · Changelog: [`CHANGELOG.md`](CHANGELOG.md) · License: MIT ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE))
