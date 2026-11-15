# The Diff Is the Workspace

### Framing and user experience in Zed's Git diff UI

*Research manuscript. Subject: Zed 1.28.1 (stable, 11 November 2026), examined on macOS on 15 November 2026.*

---

## Abstract

Zed's Git diff interface is not organized around a viewer. It is organized around a single, surprisingly literal idea: **the diff is a document you can work in**. A project diff in Zed is an editable multibuffer that contains every changed file at once; its deleted lines are ordinary text, its file boundaries are foldable excerpt headers, and its hunks carry staging state rather than living in a separate staging view. This framing determines almost everything a user sees: where diffs are opened, how files are ordered, why staged and unstaged changes share one surface, why hunk-level actions float beside the code, and why the file list is an index rather than the main event. A second framing follows from it: review is a handoff, either to the commit or to an AI agent. A third, still unstable, framing is review as conversation, which exists in Zed's source behind a disabled feature flag and remains largely undocumented in the stable release. This manuscript describes those surfaces, reconstructs the interaction model from documentation, source, and hands-on observation, and assesses what the framing buys and what it costs. It closes with implications for read-only version-control panels, where the useful lesson is continuity of reading, not the action surface.

---

## 1. Scope and method

This study treats "framing" in the ordinary product-design sense: the object the interface asks a person to believe they are manipulating, the unit of work, and the place where state lives. A diff can be framed as a report, a comparison, a review artifact, a patch stream, or a document. Zed chooses the last, and the interesting part is how consistently the rest of the interface follows.

The evidence comes from four places. First, Zed's public documentation and release notes, including the Git, multibuffers, Agent Panel and settings pages, and the stable release notes through 1.28.1 [1][2][3][4]. Second, Zed's own writing about the feature, especially the March 2025 launch post and the February 2026 split-diff post [5][6]. Third, the source code checked out at tag v1.28.1, particularly the git_ui, editor, buffer_diff, multi_buffer, agent_ui and feature_flags crates, plus the default macOS keymap [7]. Fourth, hands-on observation: Zed 1.28.1 was launched with an isolated user-data directory against a small synthetic repository that contained a partially staged file, an unstaged modification, an untracked file, a feature-branch commit, and a commit whose parent differed. The Project Diff, branch diff and commit view were opened, captured, and compared. The Agent Panel review flow was not exercised because no model provider was configured; the inline review-comment flow was not exercised because its feature flag was disabled in the stable build examined.

The local observation is reported as observation, not as general proof. A single repository, one window size, and one stable build cannot establish how the interface behaves across large changesets, remote projects or every theme. Where a claim comes from source or docs rather than from seeing the interface, it is marked as such.

---

## 2. One word, many objects: the surface inventory

Zed uses the word "diff" for a family of tabs whose comparison bases and editability differ. The first thing a new user has to learn is not how to read a diff but which diff they are in.

| Surface | What it shows | Comparison | Editable |
|---|---|---|---|
| Git Panel | Working tree and index as a file list, plus a History tab | No diff body; per-file stats | Commit message editor only |
| Project Diff ("Uncommitted Changes") | Every changed file in one multibuffer | HEAD against the working tree, with staged state overlaid | Yes |
| Staged Changes / Unstaged Changes | Dedicated multibuffers for one side of the index | HEAD against the index, or the index against the working tree | Staged view read-only; unstaged view editable |
| Branch Diff ("Changes since …") | Every change on the branch, committed and uncommitted | Merge base with a chosen base branch against the working tree | Yes |
| Commit view | One commit's changes, with commit metadata | First parent against the commit | No |
| File diff | A single changed file | Usually HEAD or index, depending on entry | Yes, for the working-copy side |
| Agent diff ("Review Changes") | All edits made by an agent thread | The agent's edits against the pre-edit state | Yes, with keep/reject |
| CLI multi-diff ("Diff (N files)") | Arbitrary file or directory pairs from zed --diff | The two supplied paths | Yes, but no staging controls |

The differences matter more than the common label. Project Diff, branch diff and commit view all look like one continuous editor with file headers, but among those three only the first two accept edits, and only the Project Diff has staging controls. Staged Changes is read-only even though it exposes unstage actions. Commit view suppresses hunk controls by design [8]. The CLI multi-diff deliberately hides staging because it compares arbitrary paths, not repository state [7].

Zed's answer to this plurality is tabs named by scope. Opening a project diff creates a tab called "Uncommitted Changes"; opening a branch comparison creates "Changes since main"; opening a commit creates a tab whose title begins with the short SHA and the commit subject. This is a good instinct: it treats the comparison base as part of the document's identity rather than as a hidden mode. The weakness is that the tab titles do not say what can be edited or staged. A user still has to know that "Uncommitted Changes" is editable and "651ed43 — feat: …" is not.

The Git Panel is the primary entry point and the index. It has two tabs, Changes and History [13], with section headers for tracked and untracked files (or staged and unstaged, if the optional grouping is enabled), per-file checkboxes, diff stats, and a view-options menu. The bottom of the panel is a commit editor with an expand control, a generate-message button, co-author support, and a split commit button. The top of the Changes tab offers "View Diff", which is the ordinary route into the Project Diff [1][7][9].

The important inversion is that the file list is not where reading happens. In most Git clients the list is the primary navigation and each file opens its own diff. In Zed the list is a table of contents for a single document. That inversion is the first consequence of the document framing.

---

## 3. Framing I: the diff is a document

Zed's documentation states the idea directly: "All of the changes displayed in the Project Diff behave exactly the same as any other multibuffer: they are all editable excerpts of files" [1][32]. The launch post explains the engineering behind that sentence. Deleted text is no longer an external block inserted between lines; it is part of the editor's coordinate system, selectable, copyable and searchable [5]. The buffer you edit in a project diff is the actual file, not a shadow copy. Saving in the multibuffer saves the files.

This is a stronger claim than "you can edit while reviewing". It means the reviewing surface and the editing surface are the same object. There is no accept step, no temporary patch overlay, and no mode switch from reading to fixing. A reviewer who notices a typo can fix it in place, then stage the surrounding hunk without leaving the tab. The launch post leans into this: "because Zed is a text editor, you can also make last minute changes to your files as you go" [5].

The visible anatomy follows from the same decision. In the Project Diff observed for this study, each file appeared as a foldable header with an icon, a filename and parent path, an added/deleted count, an "Open File" affordance on hover, and a stage checkbox whose indeterminate state showed that the file was partially staged. The body showed each small fixture file whole—unchanged lines surrounded the hunks—rather than as a compressed patch: line numbers ran on both sides, deleted lines sat on the left and added lines on the right, and changed words inside modified lines were highlighted more strongly than the line background. Inline blame appeared on the focused line, tying the current line to the commit that introduced it. The whole surface was one scroll: app.js, then README.md, then the untracked notes file, with sticky file headers as the only division.

The default expansion is deliberate. The implementation calls set_all_diff_hunks_expanded when the multibuffer is created [7], and Zed later added an explicit "editor: toggle all diff hunks" action to collapse or expand the whole document [10]. The effect is a reading experience closer to reviewing a file than to reading a patch stream: context is present, line numbers are stable, and the cursor can cross file boundaries without opening anything.

Split view, which became the default in v0.224 in February 2026, is the most visible expression of this framing [6]. It is not implemented as a separate viewer widget. It is two multibuffers, one for the base text and one for the working copy, with a block map inserting checkerboard spacers so that corresponding lines stay aligned while typing. Side-by-side comparison had been a long-running request before it shipped [31]. The Zed team describes the alignment problem in exactly the terms the framing predicts: the diff is one editable surface, so "a single misalignment can cascade through the entire diff" [6]. The solution preserves the document metaphor rather than abandoning it for a read-only comparison mode. The same preference is configurable globally as diff_view_style, with split as the default and an automatic fallback to unified below a minimum width [3][6].

The document framing has a cost that is easy to miss: because the document is the working tree, it is also mutable by the world. Another process, a git command, a formatter, or the user's own edit can change it underneath the reader. In this study, after the fixture repository was rewritten on disk while a Project Diff remained open, the open tab continued to show the earlier version; it showed the current version after the editor was restarted, and I did not isolate which event would have refreshed it in place. That is not necessarily a defect; it is the normal consequence of treating an editable buffer as the source of truth rather than a generated report. But it means a diff tab is a workspace, not a snapshot, and its refresh semantics have to be understood as buffer semantics.

---

## 4. Framing II: staging is hunk state, not a place

The conventional Git client separates staged and unstaged changes into two lists or two views. Zed deliberately does not. The launch post calls the result a "diff-of-diffs": Zed computes the diff between the working tree and HEAD and the diff between the index and HEAD, then interleaves both kinds of hunk in one view. The reason given is interaction, not aesthetics: "staging a hunk causes it to move, and so your focus is lost" [5].

The visual encoding is subtle and, once understood, coherent. With the default setting, staged hunks are faded and outlined at the hunk boundary, while unstaged hunks are filled. Zed's settings reference describes the two options plainly: "Show the staged hunks faded out and with a border" or "Show unstaged hunks faded out and with a border" [3]. In the observed Project Diff, a staged change to one function appeared as a pale, bordered green block, while an unstaged change lower in the same file appeared as a solid green block. The file's stage checkbox was indeterminate. Nothing moved when the staging state changed; only the hunk's treatment and the checkbox changed.

The unit of staging is a contiguous hunk, not a line. Zed's own roadmap post said in 2025 that "the smallest unit of staging is a contiguous group of lines" [5], and that remains true in 1.28.1: the actions are stage, unstage and restore for whole hunks or files, not for individual lines [1][7]. The interface compensates with selection. The Project Diff toolbar shows Stage and Unstage when no selection is active and Toggle Staged when a selection exists; the same logic appears in the hunk controls, which expose Stage, Unstage or Restore plus next/previous hunk navigation for the active hunk [7]. Keyboard users get stage-and-next and unstage-and-next so that a review can proceed hunk by hunk without returning to the mouse [1][7].

This framing is the most opinionated thing Zed does, and it produces both the interface's best and worst moments. The best moment is continuity: reading, staging and editing all happen at one cursor, in one scroll, with no list jumping. The worst moment is legibility. A first-time user sees a colored block and a small checkbox; the difference between "staged" and "unstaged" is conveyed by fill versus outline, a convention that is not self-describing and is easy to miss in a busy file. Zed has partially responded to this. In July 2026 it added dedicated Staged Changes and Unstaged Changes multibuffers [11], and it now offers an optional Staged/Unstaged grouping in the Git Panel [12]. Both are additional views on the same model, not replacements for it. The default Project Diff still interleaves.

The second layer of state is the comparison base. Zed supports at least four bases in practice: HEAD for uncommitted work, the index for staged state, a merge base for branch review, and a parent commit for commit view. The first two are usually implicit. The branch case is explicit: the branch diff toolbar shows a base label such as "Base: main" with a picker, and the base can be changed in place [10]. In August 2026 Zed added the git.diff_base setting, which makes editor gutters, file-status colors and the git: diff action agree on either HEAD or the default branch's merge base; in September it added a git: toggle diff base action [14][15]. This is a sign that the original framing had a hole: "the diff" was not one object but a family of comparisons, and users needed a way to say which one they meant without opening a different tab.

---

## 5. Framing III: review is a handoff

The second half of Zed's review UX is not about reading a diff at all. It is about moving a diff to an actor.

For agent-generated edits, the Agent Panel opens a Review Changes multibuffer. The documentation describes it as "a special multi-buffer tab with all changes" where a person can "accept or reject each individual change hunk, or the whole set of changes made by the agent" [2]. The hunk controls are the same visual family as the Git ones, but the verbs change to Keep and Reject, with Keep All and Reject All at the top and an undo for Reject All added in early 2026 [2][16]. The keyboard map mirrors the Git staging map closely (cmd-y to keep, cmd-alt-z to reject on macOS) [7]. An optional single-file review mode shows the same keep/reject controls inline in the file and, in the docs' words, "temporarily overrides the buffer's git diff while review is active" [2].

For committed work, the branch diff adds a "Review Diff" button that sends the whole diff to the last-used agent with a prewritten prompt [17][18]. The PR description is refreshingly blunt about the tradeoff: it "automatically submits a (pre-written and generic) prompt to the last agents you were using in the agent panel with the whole content of your diff" [18]. A commenter immediately asked for a configurable rule, the way commit-message prompts are configurable. That exchange captures the state of the art: the handoff is convenient, but it is a batch verb, not a conversation. The diff is turned into a prompt and sent; the reviewer's specific concern is not attached to a line.

There is a third design in Zed's tree that has not reached stable users: line-level review comments inside the diff itself. The relevant pieces are visible in the v1.28.1 source. An Editor can mark a hunk and open a review overlay; the overlay is rendered as a block below the selected lines with an avatar, a prompt field, a line-range label, and a comment list; the Project Diff toolbar can show a "Send Review to Agent (N)" button when comments exist; the branch diff has a toolbar variant that shows the review action without staging controls [7]. The feature has a history: a gutter "Add Review" button landed in January 2026 behind a flag; a follow-up implemented local comment storage, expandable comment sections, inline edit/delete, avatars and batch sending, still behind the flag; another follow-up enabled comments in branch diffs [19][20][21]. In v1.28.1 the flag is off by default for everyone, including staff, and it did not appear in the stable build examined [22]. External contributors have tried to complete the circuit by turning comments into structured feedback cards for agent threads, but those PRs are not part of the stable surface [23].

This is the most revealing unfinished edge in the interface. Zed has already built the hard parts of a conversational review: a diff you can annotate, comments tied to hunks, and a button that batches them. What is missing is the public product decision to expose it, document it, and decide where comments live after they are sent. Meanwhile, Zed's separate Delta product is pursuing line-anchored review in a different setting [24][30]. In the editor, review is still either a binary accept/reject or a whole-diff handoff. The document framing has not yet been extended to the conversation framing.

---

## 6. Anatomy of the reading surface

The surfaces share a grammar, and the grammar is worth describing precisely because it is the part other tools can learn from.

The toolbar's content depends on the surface. Project Diff carries a total diff stat, previous/next hunk arrows, Stage and Unstage (or Toggle Staged), Stage All and Unstage All, and Commit, plus the send-review button when review comments exist. Branch diff replaces the staging controls with a base-branch picker and a Review Diff button. Commit view has no staging controls and uses its own metadata header: author avatar, name, date, email, a "Commit SHA" button, the commit subject, and a diff stat. The Git Panel's Changes tab is headed by "View Diff" with the total stat and a split Stage All/Unstage All control [7].

File headers are the quiet workhorse. They are excerpt headers in a multibuffer, so they can be folded, and the entire file can be collapsed to a single row; alt-clicking a chevron folds or unfolds all files; the header shows the filename, its parent path, a status-colored icon, a strikethrough for deleted files, an added/deleted count, a dirty or conflict indicator, an Open File button on hover, and, in the Project Diff, a stage checkbox injected by the Git panel add-on [7]. The header is sticky while its file is on screen, so the reader always knows which file owns the next hunk.

Hunk controls are the smallest unit of action. In the implementation, they are laid out on the active hunk's start row, where "active" means the row under the mouse or the row containing the newest cursor. They float at the right edge of the text area and contain Stage, Unstage or Restore plus next/previous hunk buttons; pending operations are drawn at partial opacity [7]. In the observed split Project Diff, the hunk controls were not visible until the hunk was active, which keeps the reading surface quiet but also hides the fact that the code is actionable. This is a recurring pattern in Zed's diff design: the interface is calm until the cursor or mouse arrives, then a small, dense control cluster appears.

Split view deserves its own note because it changes the reading experience more than any other visual decision. Since v0.224 it is the default. The left side is a second multibuffer made from the base file, not a synthetic text dump; the right side is the real file. Checkerboard spacers pad the shorter side, and the block map keeps the alignment stable through edits. Zed frames this as an engineering problem about the multibuffer, but from the user's side it is a framing decision: the old and new versions are two views of one document rather than two documents side by side [6].

The visual language is consistent across surfaces: added lines green, deleted lines red, modified words more saturated than the line background, line numbers colored in version-control colors, and a status bar that carries the usual editor information. The diff surface is still an editor: it has a cursor, selections, search, breadcrumbs, inline blame, and mouse-wheel font zoom as of 1.28.1 [4]. A user who knows the editor already knows most of the diff.

---

## 7. Evolution and trajectory

Zed's Git UI has changed fast enough that its current shape is best understood as the residue of a sequence of decisions rather than a single design.

| Date | Version | Change |
|---|---|---|
| 12 March 2025 | v0.177 | Native Git: Git Panel, editable Project Diff, hunk staging, "diff-of-diffs" [5] |
| 8–15 January 2026 | pre-0.22x | Diff review gutter button; local review comments; comments in branch diffs, all behind a flag [19][20][21] |
| 11 February 2026 | — | Agent single-file review default changed to off [25] |
| 18 February 2026 | v0.224 | Split diff becomes the default; branch diff Review Diff button follows [6][18] |
| 20 May 2026 | v1.3.5 | Git Panel History tab; theme keys for diff hunk colors [26] |
| 27 May 2026 | v1.4.2 | Base-branch picker in branch diff; toggle all diff hunks; show/hide Stage/Restore buttons [10] |
| 15 July 2026 | v1.11.3 | Dedicated Staged Changes and Unstaged Changes multibuffers; diff stats in uncommitted view [11] |
| 23 July 2026 | v1.12.0 | Optional Staged/Unstaged grouping; Restore buttons in unstaged diff [12] |
| 12 August 2026 | v1.15.0 | git.diff_base setting; gutter width [14] |
| 2 September 2026 | v1.18.0 | git: toggle diff base action [15] |
| 30 September 2026 | v1.22.0 | Unified/split toggle for CLI diffs [27] |
| 14 October 2026 | v1.24.2 | Side-by-side view for directory diffs opened with zed --diff [28] |
| 11 November 2026 | v1.28.1 | Current stable; Git Graph refs column, drag from Git Panel, diff zoom [4] |

Three trajectories are visible. The first is from one diff to many scopes: project, staged, unstaged, branch, commit, agent, file, and arbitrary path. The second is from a single unified view to split as the default, with an explicit preference and an automatic fallback for narrow panes. The third is from panel-centric staging toward a document-centric review surface, with the Git Panel increasingly acting as an index, a commit composer, and a history browser rather than the place where changes are read.

The trajectory also shows where the design has been patched. Dedicated staged and unstaged views, the optional staging grouping, and the ability to choose a branch base all exist because the single interleaved surface is powerful but not sufficient for every mental model. Zed's maintainers are willing to add views, but they keep the document as the center. That is a coherent strategy, and it is also why the surface inventory keeps growing.

---

## 8. Assessment: what the framing buys, and where it strains

The document framing is a real product idea, not a visual style. It buys four things.

First, it removes a mode change. Reviewing, fixing, staging and committing happen in one tab and, for keyboard users, at one cursor. That is a meaningful difference from clients where a diff is a read-only viewer and staging is a checkbox in another pane.

Second, it preserves focus during staging. Because hunks do not move to a different section when staged, stage-and-next can walk a file while the reader stays in place. Zed's maintainers explicitly designed for this [5]. It is the strongest argument for the interleaved view, and it is the kind of argument that only becomes obvious after using both models.

Third, it makes cross-file reading cheap. A project diff is one scroll, one search context, one selection model. Moving the cursor from one file to the next does not require opening and closing tabs; opening the source file is a separate, deliberate action. For a review that spans a directory, this is faster than a file-by-file viewer.

Fourth, it gives the agent review the same body. Keep/reject hunks use the same multibuffer, the same hunk controls and a similar keyboard map as Git staging. A user who learns one learns the other. This is good reuse at the level of interaction grammar, not just code.

The strains are equally clear.

The first is legibility. Staged versus unstaged is encoded primarily by fill versus outline, a convention that is not explained in the surface itself and that disappears in a busy file or a color-vision-deficient theme. Partial staging is an indeterminate checkbox and a bordered hunk; full staging is a checked box. In the observed interface the distinction was visible but not self-evident. Zed added dedicated views and an optional grouping to compensate, which helps discoverability but also adds more places for the model to live.

The second is scale by monotony. A single document with every changed file is excellent for a focused change and tiring for a large one. The community complaint is blunt and worth taking seriously: "one giant editor with every change in it is just harder for me to grok than showing each file one by one; so it was tiring to review the big changes produced by LLMs" [29]. The file headers, folding and hunk navigation are the mitigations; they do not change the fact that the default reading unit is the whole changeset.

The third is scope confusion. "Uncommitted Changes", "Changes since main", "Staged Changes", "Unstaged Changes", a commit SHA, a single file, an agent's edits, and a CLI pair are all "diffs". The tab title carries the scope, but not the editability, the base, or the action set. A user can learn the differences, but the interface does not teach them at the point of use. Split versus unified is a global preference; in-place toggles exist in some surfaces (solo diffs, commit-history diffs, CLI diffs), but the Project Diff toolbar I observed did not expose one, so the reliable control remains the setting.

The fourth is the proximity of destruction. Restore lives in the same floating cluster as Stage, and a hunk can be discarded from the reading surface. Zed has confirmation flows for file-level restore and has fixed real staging bugs over time, but the design puts a destructive verb one click away from a reading gesture. The calm-until-hover pattern makes this worse: the controls appear exactly when the user is moving the mouse to read.

The fifth is the unfinished review conversation. Local comments, comment badges, the send-to-agent button and the branch-diff review toolbar are all implemented, but the stable build examined keeps the comment flag off and the documentation does not describe the flow [19][20][21][22]. The shipped review path is binary keep/reject or a whole-diff handoff. The DEV Community survey of agent-review interfaces concluded that Zed's editor docs do not describe line comments for the agent, while Zed is developing exactly that in Delta [24]. That gap is not a small missing feature; it is the difference between "review the patch" and "tell the author what is wrong".

The sixth is documentation drift. The Git docs page describes File History and the main staging workflows but does not cover the Git Graph, the History tab, the dedicated staged/unstaged views, or the review-comment machinery. Release notes carry much of the real product history. For a feature this opinionated, the absence of a short "which diff am I looking at?" page is a usability cost.

None of these strains invalidates the framing. They are the normal cost of choosing a strong metaphor. The interesting question is which costs Zed is willing to keep paying. The dedicated views and base picker suggest it will keep adding escape hatches while preserving the document as the default.

---

## 9. Implications for a read-only VCS panel

The immediate context for this study is a read-only version-control panel for DeepSeek Harness, which puts a working-tree node and a commit timeline in one view and reads every changed file's diff in one stream. Zed is a write-capable editor and the panel is deliberately not; most of Zed's action surface therefore does not transfer. The reading lessons do.

First, continuity of reading is the thing worth copying. Zed's best decision is not the staging buttons; it is that a reviewer never has to leave the document to see the next file or the next hunk. A read-only panel can preserve that with one scroll, sticky file headers, a file index that tracks the reading position, and hunk-level navigation keys. The panel's existing one-timeline, one-detail design is closer to Zed than to a file-by-file client, and that is a good thing.

Second, label the comparison base at the point of reading. Zed's branch diff puts "Base: main" in the toolbar and names the tab after the scope. A read-only panel has the same problem in a different form: working tree versus HEAD, staged versus index, a commit versus its first parent. The header should say which comparison produced the body, not leave it to a mental model.

Third, keep the file list as an index, not a destination. Zed's file headers and scroll position do the navigation work; the Git Panel is a table of contents. A read-only panel can borrow the header grammar: filename, parent path, status, added/deleted counts, fold control, and a clear current-file indicator as the stream moves.

Fourth, staging state still matters even when the panel cannot stage. A read-only view of the working tree should show which hunks are staged, because that is part of "what changed" and it affects what a commit would contain. Zed's hollow/filled convention is a useful idea, but a read-only panel should not rely on color and outline alone. A textual or iconic cue, or an explicit legend, is safer. The optional Staged/Unstaged grouping is the more legible alternative; Zed's own addition of that grouping is evidence that the pure interleaved view is not always enough.

Fifth, do not put actions in the reading surface unless they are safe. A read-only panel's calm reading surface is a feature. If a future write path adds staging or discarding, it should be a separate, explicit mode or a contextual toolbar with confirmation, not a floating cluster that appears under the pointer.

Sixth, review handoff is a legitimate future feature, but it is a write path. Zed's Review Diff button, comment overlay and Send Review to Agent button all assume an agent thread, authentication, and a durable place for comments. The DSH panel's read-only contract would need a separate design for that, with the same care the project already gives to CSRF, path containment and backend capability declarations. The lesson from Zed is that the handoff is most useful when the diff is already a good reading surface; the handoff is not a substitute for reading.

Seventh, beware surface proliferation. Zed now exposes at least eight diff surfaces, each with its own tab and name. A read-only panel can avoid that by keeping one detail structure and varying only the header and the comparison base, which is what the current design already does. Zed's trajectory is a warning as much as a model: every new scope added a new surface and a new set of controls. A smaller product can keep the number of surfaces down.

Finally, performance is part of the framing. Zed's editable document is only credible because it stays responsive; the team spent significant effort on multibuffers, split alignment, lazy buffer loads and word-diff performance [6][7]. A read-only panel with per-file requests and explicit caps is a different architecture, but the user expectation is the same: one continuous reading flow should not stutter when a file enters the viewport. Zed validates the goal even where the mechanism differs.

---

## 10. Conclusion

Zed's Git diff UI is best understood as a bet that the diff should be a document rather than a viewer. The bet explains the editable project multibuffer, the all-files-in-one-document default, the interleaved staged and unstaged hunks, the floating hunk controls, the split view built from two multibuffers, and the way the file list recedes into an index. It also explains the interface's characteristic strengths: continuity, focus preservation, cross-file reading, and a shared grammar between Git review and agent review.

The bet has costs. Staging state is legible only after a small act of learning; a single giant document can be tiring on large changesets; the many scopes share a word but not a behavior; destructive verbs sit close to reading gestures; and the conversational layer of review, though largely built, is still behind a flag and outside the documentation. Zed's response has been to add escape hatches, not to abandon the document: dedicated staged and unstaged views, an optional grouping, a configurable diff base, a base picker, and a split toggle. That is the signature of a design that is confident about its center and still negotiating its edges.

For a read-only VCS panel, the transferable idea is not the staging UI. It is the reduction of mode changes: one surface, one cursor, one scroll from "what changed" to "how it changed" to "what it means". Zed shows that this is achievable and worth the engineering. It also shows where the idea needs guardrails, especially around legibility, scope naming, scale, and the line between reading and acting.

---

## Appendix A: Evidence and limitations

**Local observation.** Zed 1.28.1 stable was launched on macOS with an isolated user-data directory and a synthetic Git repository. The repository contained a partially staged src/app.js (one staged hunk and one unstaged hunk after a second edit), a modified README.md, an untracked notes.txt, a feature branch with a commit, and a first commit. The observed states were:

- Git Panel on the Changes tab: tracked/untracked groups, per-file stats, indeterminate checkbox for the partially staged file, commit editor, branch footer.
- Project Diff ("Uncommitted Changes"): split view, all changed files in one document, unchanged lines around the hunks, file headers with stage checkboxes and diff stats, inline blame, word-level highlighting, staged hunk rendered as a bordered/pale block, unstaged hunk as a filled block, +7/−3 total.
- Branch Diff ("Changes since main"): base label "Base: main", Review Diff button, committed and uncommitted files in one document, +10/−3 total.
- Commit view: author header, short SHA and subject, read-only diff of the commit against its parent, +5/−1 total.
- A Project Diff left open while the repository was rewritten on disk continued to show the earlier content; it displayed the current version after the editor was restarted, and the exact trigger was not isolated. That observation is reported in Section 3 as a caution about buffer semantics, not as a general claim about refresh behavior.

No model provider was configured, so the Agent Panel review flow and the whole-diff Review Diff handoff were not exercised locally. The inline review-comment flow was not exercised because the diff-review feature flag was off in the stable build examined. Claims about those flows come from documentation, source and PRs, and are marked accordingly.

**Source review.** The v1.28.1 tag was checked out with a sparse checkout of the crates relevant to Git and diffs: git_ui, git_ui_core, buffer_diff, streaming_diff, editor, multi_buffer, project (git_store), settings_content, feature_flags, agent_ui, and the default keymaps. The claims about toolbar composition, hunk rendering, file headers, review overlays, capabilities and keybindings are drawn from that source [7].

**Limitations.** The study is macOS-only, one window size, one repository shape, one stable build. It does not measure readability or task performance, and it does not test large changesets, remote projects, merge conflicts or multiple repositories in one workspace. The release timeline relies on public release notes and blog posts; version numbers before 1.0 are not always aligned with the current site's pagination. Community comments are treated as impressions, not evidence about prevalence.

---

## Appendix B: Sources

1. Zed documentation, Git. https://zed.dev/docs/git
2. Zed documentation, Agent Panel, "Reviewing Changes". https://zed.dev/docs/ai/agent-panel
3. Zed documentation, all settings, especially diff_view_style, minimum_split_diff_width, word_diff_enabled, hunk_style, diff_base. https://zed.dev/docs/reference/all-settings
4. Zed stable release notes, 1.28.1, 11 November 2026. https://zed.dev/releases/stable/1.28.1
5. Zed blog, "Native Git support in Zed", 12 March 2025. https://zed.dev/blog/git
6. Zed blog, "Split Diffs are Here", 18 February 2026. https://zed.dev/blog/split-diffs
7. Zed source at tag v1.28.1: crates/git_ui/src/project_diff.rs, branch_diff.rs, diff_multibuffer.rs; crates/editor/src/git.rs, element.rs, split.rs; crates/buffer_diff/src/buffer_diff.rs; crates/feature_flags/src/flags.rs; assets/keymaps/default-macos.json. https://github.com/zed-industries/zed/tree/v1.28.1
8. Zed release notes, v1.7.2, 17 June 2026: "Fixed a bug where diff hunk controls were being displayed in the non-editable commit view multibuffer." https://zed.dev/releases/stable?page=5
9. Zed documentation, Git, "Git Panel" and "Staging Workflow". https://zed.dev/docs/git
10. Zed release notes, v1.4.2, 27 May 2026: base branch picker, toggle all diff hunks, show_stage_restore_buttons. https://zed.dev/releases/stable?page=6
11. Zed release notes, v1.11.3, 15 July 2026: dedicated Staged and Unstaged Changes views. https://zed.dev/releases/stable?page=4
12. Zed release notes, v1.12.0, 23 July 2026: Staged/Unstaged grouping; Restore buttons. https://zed.dev/releases/stable?page=4
13. Zed release notes, v1.3.5, 20 May 2026: Git Panel History tab. https://zed.dev/releases/stable?page=6
14. Zed release notes, v1.15.0, 12 August 2026: git.diff_base setting. https://zed.dev/releases/stable/1.15.0
15. Zed release notes, v1.18.0, 2 September 2026: git: toggle diff base action. https://zed.dev/releases/stable?page=3
16. Zed release notes, v0.226.0-pre: Review Diff button; undo reject all. https://newreleases.io/project/github/zed-industries/zed/release/v0.226.0-pre
17. Zed PR #49513, "git_ui: Add 'Review Branch' with agent feature", merged February 2026. https://github.com/zed-industries/zed/pull/49513
18. Same PR, description of the pre-written generic prompt and the request for configurable review rules. https://github.com/zed-industries/zed/pull/49513
19. Zed PR #46326, "Add diff review button in git diff views", January 2026: feature flag and gutter button. https://github.com/zed-industries/zed/pull/46326
20. Zed PR #46669, "Enable diff review comments", January 2026: local storage, comments section, inline edit/delete, Send Review to Agent. https://github.com/zed-industries/zed/pull/46669
21. Zed PR #46951, "Enable review comments in branch diff view", January 2026. https://github.com/zed-industries/zed/pull/46951
22. crates/feature_flags/src/flags.rs at v1.28.1: DiffReviewFeatureFlag is disabled for staff by default; store.rs restricts overrides to staff. https://github.com/zed-industries/zed/blob/v1.28.1/crates/feature_flags/src/flags.rs
23. Zed PR #62419, "Send Git diff review feedback to agent threads", open as of this study; and closed predecessor #61924. https://github.com/zed-industries/zed/pull/62419
24. DEV Community, "Every editor now reviews your agent's code. Where do your comments go?", 2026. https://dev.to/urion/every-editor-now-reviews-your-agents-code-where-do-your-comments-go-34fc
25. Zed PR #48619 (agent.single_file_review default change), February 2026. https://github.com/zed-industries/zed/pull/48619
26. Zed release notes, v1.3.5 and v1.4.2, May 2026: History tab, theme keys for diff hunk colors. https://zed.dev/releases/stable?page=6
27. Zed release notes, v1.22.0, 30 September 2026: unified/split toggle for CLI diffs. https://zed.dev/releases/stable?page=2
28. Zed release notes, v1.24.2, 14 October 2026: side-by-side directory diffs from zed --diff. https://zed.dev/releases/stable?page=1
29. Hacker News comment by "presentation" on Zed 1.0, 30 April 2026. https://news.ycombinator.com/item?id=47960850
30. Zed blog, "Introducing Delta", 12 August 2026, and "Delta Public Beta", 16 September 2026. https://zed.dev/blog/introducing-delta and https://zed.dev/blog/delta-public-beta
31. Zed discussion #26057, "Git diff Split view", and discussion #26770, side-by-side Git view request. https://github.com/zed-industries/zed/discussions/26057
32. Zed documentation, Multibuffers. https://zed.dev/docs/multibuffers

*All URLs accessed 15 November 2026. Local observations were made in Zed 1.28.1 on macOS; the scratch repository and isolated profile were removed after the study.*
