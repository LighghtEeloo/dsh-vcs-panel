# dsh-vcs-panel

English | [中文](README.zh.md)

> A read-only version control tab for DeepSeek Harness: working changes, file diffs, and commit history with a lane graph, for Git and Jujutsu repositories.

**v0.1.0**

## What you get

A `VCS` tab in the conversation view puts the working tree and the commit history on one timeline, and shows every changed file's diff in one reading flow. It answers “what changed?” and “how did we get here?” without opening a terminal or a full Git client.

- **One timeline.** The working tree (Git) or working-copy commit `@` (Jujutsu) is the first row; commits follow in topological order with a colored lane graph, refs, short ids, authors, and time.
- **One detail view.** Select a row and read every changed file's diff in order. The file list tracks the diff stream, and diffs load as they come into view.
- **Git and Jujutsu, in their own terms.** A repository's marker picks the backend. Git shows a working tree, staged/unstaged/untracked groups, branches, and ahead/behind; Jujutsu shows `@`, change ids, bookmarks, and one changes list per commit.
- **Built for large repositories.** Virtualized history, per-file requests, explicit caps, and clear truncation keep the panel responsive.
- **One entry at the end of a turn.** A turn that changed files ends with a single VCS icon instead of DSH's changed-files card; the icon opens this tab. The per-turn file list is gone on purpose, and the tab still shows the complete working tree. The icon follows DSH's per-turn change record (shell commands count, and subagent edits in the same working tree) or a successful file-tool edit in the turn.
- **One key to the changes.** `⌘⇧G` on macOS or `Ctrl+Shift+G` elsewhere toggles the VCS view from anywhere in a conversation; press it again to return to the view you left. Rebind it in **Settings → Shortcuts**; on the Web the default may compete with the browser's own shortcut.
- **Native to DSH.** Theme tokens, focus rings, reduced motion, and keyboard navigation follow the host; the panel remembers the repository, selection, and reading position for the session.
- **Read-only.** No staging, commit, checkout, merge, rebase, stash, fetch, pull, or push. Jujutsu's read-time snapshot is the only write the panel triggers, and the lock tooltip says so.
- **Eight UI languages.** Chinese, English, Japanese, Spanish, French, German, Russian, and Portuguese; dates, relative times, and counts follow DSH.

## Install

Requires DSH 0.2.2-rc.1 or later, with a Host that serves the Web Client (Desktop and Web both work).

```sh
dsh plugin --profile desktop add link:/path/to/dsh-vcs-panel
```

You can also install the directory with `plugin_manager`'s `install_bundle`, or with **Plugins** > **Add plugin** in the Web sidebar. Restart DSH after installing the plugin; the `VCS` tab appears after Chat and Trajectory.

Installing also hides DSH's per-turn changed-files card in Chat; the turn ends with the VCS icon instead. The change recorder, delivery cards, and native opens keep working. Uninstalling the bundle restores the card.

Jujutsu repositories need `jj` on the Host's `PATH`; without it the repository is still listed and reads report `vcs-missing`.

There is no plugin settings panel; the shortcut is configurable in **Settings → Shortcuts**. To remove the panel, disable or uninstall the plugin bundle in **Plugins**.

## Development

```sh
npm install          # esbuild, the only development dependency
npm run check        # node --test, then verify client.js is current
npm run build        # regenerate client.js from src/client/
npm pack --dry-run   # packaging check
```

`client.js` is generated; edit `src/client/` and rebuild. The Host side is plain ESM with no runtime dependencies. Jujutsu route tests run when `jj` is on `PATH` and are skipped otherwise. Install, upgrade, and uninstall checks use a fake `DSH_HOME`; do not point `dsh plugin` at the real profile during testing.

## Docs

Product design: `DESIGN.md`. Routes, data shapes, build, and limits: `IMPLEMENTATION.md`. Changes: `CHANGELOG.md`.

## License

MIT. Third-party notices are in `NOTICE` and `licenses/`.
