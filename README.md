# dsh-vcs-panel

English | [中文](README.zh.md)

Version control in the DeepSeek Harness right Sidebar. Adds a `VCS` tab to inspect working changes, syntax-highlighted diffs, and commit history with a lane graph, for both **Git** and **Jujutsu** repositories—and to act on Git branches in one place: check out, rename, delete, merge into the current branch, rebase the current branch onto another, push a branch, or sync with its upstream.

## Features

- **In the Sidebar.** The panel lives in a `VCS` tab beside files and terminals, with a card on the Sidebar guide. The Turn banner and the shortcut open the same tab.
- **Timeline & lane graph.** Working changes (`Working tree` in Git, `@` in Jujutsu) sit above topological commit history with branches, bookmarks, tags, and scope toggle (`HEAD` / `@` or all commits). Supports multi-repository workspaces.
- **Inline change tree.** Browse changed files as a collapsible list, or expand any file to read its diff in place with sticky headers, unified or split view, and line wrapping.
- **Git & Jujutsu native.** Shows staged and unstaged groups (`?` for untracked items) and ahead/behind in Git; shows `@`, change IDs, and bookmarks in Jujutsu.
- **Turn banner & shortcut.** File-changing turns end with a compact VCS banner showing that turn's branch (or `@`), changed-file count, and `+` / `−` line totals in place of Chat's changed-files card. Open the Sidebar tab from anywhere with `⌘⇧G` / `Ctrl+Shift+G`, and press it again to slide back to the conversation.
- **One-click sync.** The button beside the Git branch shows ahead/behind counts; clicking it fetches the upstream, then fast-forwards or pushes. A diverged branch, a fast-forward that would overwrite local edits, or a branch without an upstream is left untouched with a note on what to do next.
- **Branch switching.** The branch name opens the repository's local branches; picking one checks it out. Only local branches are listed—no implicit remote-tracking branches—and Git refuses when local changes would be overwritten, so nothing is stashed, discarded, or forced.
- **Branch actions.** Right-click the current branch, any branch in the list, or a branch badge in the history timeline (or press `Shift+F10` on the branch control) for checkout, rename, delete, merge into the current branch, rebase the current branch onto it, and push. The checked-out branch offers rename and push only. Rename, delete, merge, and rebase state what will happen before they run; an unmerged delete needs a second, explicit confirmation; a conflicting merge or rebase is aborted and leaves the branch unchanged. Push sends exactly the named branch to its configured upstream and never forces.
- **Writes stay explicit.** Sync and the branch actions are the only writes: the panel never stages, commits, force-pushes, discards changes, or creates branches (Jujutsu only snapshots the working copy on read). Follows DSH themes and all 8 UI languages, and loads large histories and diffs on demand.

## Keyboard

| Keys | Action |
| --- | --- |
| `⌘⇧G` / `Ctrl+Shift+G` | Open the `VCS` tab in the right Sidebar, or collapse the Sidebar when it is showing (rebind in **Settings → Shortcuts**) |
| `↑` `↓` or `j` `k` | Move through one vertical list of tree rows and hunk headers of open diffs |
| `←` `→` or `h` `l` | Enter the change tree or an open file; `←` / `h` closes an open file first, then returns to the timeline |
| `Enter`, `Space`, `Esc` | Fold/expand the focused row; `Esc` returns to the timeline |
| `↑` `↓`, `Home` `End` | Move inside the open branch menu or branch actions menu; `Esc` closes it |
| Right-click, `Shift+F10` | Open branch actions for the current branch, a branch in the list, or a branch badge in the history timeline |
| `Enter`, `Esc` | Confirm or cancel a branch action dialog |
| `[` / `]` | Move to the previous / next tree row, skipping hunk headers |

## Install

Requires **DSH 0.2.2-rc.3+** (Desktop or Web) with the right-Sidebar tab and navigation APIs, and `git` or `jj` on `PATH`.

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
