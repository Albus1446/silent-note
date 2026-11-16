# Claude Code for Zotero

Quietly send highlights, underlines, annotation comments and notes to [Claude Code](https://claude.com/claude-code). Answers come back as child notes tagged `claude`.

**Triggers**
- Type `@claude <instruction>` in an annotation comment (or at the start of a child note) — runs automatically ~4 s after you stop typing; the marker becomes `#claude` when done.
- Right-click an annotation in the reader → *Ask Claude Code*.
- Select text in the reader → *Ask Claude*.
- Right-click items in the library → *Ask Claude Code*.

Requires the `claude` CLI (logged in). Settings live under `extensions.claude-code.*` in the Config Editor.

Install the `.xpi` from the [latest release](https://github.com/Albus1446/silent-note/releases/latest); later versions auto-update.

Release: `./release.sh <version>`.
