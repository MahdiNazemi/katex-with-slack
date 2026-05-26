# AGENTS.md

Guidance for AI agents maintaining this Chrome/Firefox extension, which
renders KaTeX-formatted math inside Slack messages.

## Layout

```
manifest.json     Manifest V3, content script for *.slack.com
katex.js          Vendored KaTeX runtime
auto-render.js    Vendored KaTeX auto-render extension
katex.css         Vendored KaTeX styles (loaded into the page and into shadow roots)
glue.js           The extension's logic — everything below lives here
fonts/            KaTeX fonts (web_accessible_resources)
icon{32,48,128}.png
```

Touch only `glue.js` and `manifest.json` for behavior changes. Update the
vendored KaTeX files together (they are version-locked).

## Architecture

The extension runs `renderMathInElement` against Slack's message DOM, with
extra plumbing to avoid two problems:

1. **React reconciliation conflicts.** KaTeX splits and replaces text nodes;
   React holds `stateNode` refs to the originals and throws `NotFoundError`
   on the next reconcile (e.g. when Slack toggles "Show more / Show less").
   Mitigation: for Block Kit's `c-message_attachment__text`, render into a
   shadow root attached to the inner `span[dir="auto"]`. React reconciles the
   light DOM and never sees KaTeX's mutations. Non-attachment elements (rich
   text in normal chat) get direct in-place rendering — they are not affected
   by the same React conflict.

2. **Cross-origin CSS in shadow DOM.** `adoptedStyleSheets` rejects
   cross-origin sheets. Instead, the shadow root holds a `<link
   rel="stylesheet">` for `katex.css` plus one per same-page Slack stylesheet
   (`document.styleSheets`). Browsers serve these from the page cache without
   CORS restrictions. `cssReady()` waits for every link's `.sheet` to
   populate before invoking KaTeX, and each `<link>`'s `onload` schedules a
   re-render so KaTeX runs once styles are ready.

### Ancestor wrappers (display:contents)

The shadow root contains a clone of the text span wrapped in a chain of
`<div class="<ancestor-class>" style="display:contents">` mirroring the real
DOM hierarchy. Slack selectors like `.p-mrkdwn_element .c-emoji img` match
inside the shadow root, so styling matches the light DOM (emoji sized 22×22,
inline alignment correct, etc.). Without the chain, Slack rules anchored to
ancestor classes would not apply.

### Newline handling

Slack's Block Kit `plain_text` renders message-body newlines as `<br>`
elements. KaTeX's auto-render concatenates only sibling text nodes (see
`auto-render.js` `renderElem`), so `\[ … \]` split as `text/<br>/text/<br>/
text` never matches a delimiter pair. Before invoking KaTeX, replace each
`<br>` in the clone with a `\n` text node and call `normalize()`. The
outermost wrapper carries `white-space: pre-wrap` so the substituted `\n`
still renders as a visible line break for surrounding prose.

### Truncation detection

Slack's truncation button (`button[data-qa="block_kit_text_truncation"]`)
does not always carry `aria-expanded`. `isTruncated()` reads the attribute
when present and otherwise matches the button's label against
`TRUNCATED_LABELS` (currently `['Show more']`). Keep the label list narrow
and only add entries observed in the live DOM; broad matches risk false
positives.

When truncated, the shadow root shows a `<slot>` (raw light DOM passes
through) and KaTeX is not invoked. KaTeX is only rendered in the expanded
state, then `processedContent.set(el, currentContent)` records the result so
the next mutation event with the same content is a no-op.

### Rendering schedule

A single `requestAnimationFrame` coalesces re-renders. `MutationObserver`
fires `scheduleRender` on any subtree change, and a 3-second interval is a
final safety net. `RENDER_DELAY_MS = 300` defers the first render on each
element so Slack has time to add its truncation button before KaTeX inflates
the height (otherwise our taller rendered content can race Slack's
truncation decision and end up in an inconsistent state).

### Shadow root reclaim

After an extension reload, the per-tab `shadowRoots` WeakMap is empty but
DOM nodes retain their shadow roots. `getShadowRoot()` catches the
`attachShadow` failure and reads `textSpan.shadowRoot` (mode `'open'` makes
it readable) so the existing root is reused rather than falling through to
the direct render path on a React-managed span.

## Delimiters

```
$$$ … $$$   display math
$$  … $$    inline
\( … \)     inline
\[ … \]     display
```

Single `$` is intentionally excluded — it false-matches shell variables,
prices, and prose. `latexPattern` is the pre-filter that gates any element
from entering the render path.

## Commands

There is no build step. The repo is a Manifest V3 extension that loads as-is.

```bash
# Load unpacked (Chrome): visit chrome://extensions, enable Developer mode,
#   click "Load unpacked", select the repo directory.
# Load temporary (Firefox): visit about:debugging#/runtime/this-firefox,
#   click "Load Temporary Add-on", select manifest.json.

# Package for distribution (zip everything except VCS and dev files):
zip -r ../katex-with-slack.zip . -x '.git/*' '.gitignore' 'AGENTS.md' 'CLAUDE.md'

# Firefox xpi (zip with .xpi extension):
zip -r ../katex-with-slack.xpi . -x '.git/*' '.gitignore' 'AGENTS.md' 'CLAUDE.md'
```

After any edit to `glue.js` or `manifest.json`, reload the unpacked
extension at `chrome://extensions` (or re-add the temporary add-on in
Firefox) and refresh Slack tabs.

## Testing

There is no offline test harness. Verification is done in a real browser
against a real Slack workspace:

1. Load the extension unpacked at `chrome://extensions` (Chrome) or
   `about:debugging` (Firefox).
2. Open a Slack thread containing the cases to exercise: inline math, block
   math (single-line and multi-line), bold/italic in mrkdwn alongside
   inline math, and a message tall enough to trigger "Show more / Show
   less".
3. After any edit to `glue.js`, reload the extension and refresh Slack.
4. For DOM-level inspection, drive the page through Playwright and
   `browser_evaluate` against `document.querySelectorAll(...)`. Read shadow
   roots via `span[dir="auto"].shadowRoot` — `querySelectorAll` on the light
   DOM does not penetrate.

What cannot be tested without a real browser + Slack:
- Layout-driven truncation (Slack measures height; JSDOM has no layout)
- React reconciliation conflicts (the bug only manifests with Slack's
  fibers alive)
- Cross-origin stylesheet `.sheet` population in shadow roots

A JSDOM/Vitest harness can cover the regex pre-filter, the `<br>` → `\n`
substitution, ancestor wrap, slot-vs-render toggling, and shadow-root
reclaim. It cannot verify visual correctness or React-side behavior.

## Conventions

- Conventional Commits (`fix(glue): …`, `feat(glue): …`, `refactor(glue): …`).
  Keep the subject ≤ 72 characters; commit body wrapped at 72.
- No emojis anywhere in code, comments, or commits.
- Comments capture the durable invariant in present tense — what is always
  true, not what changed or why a past incident motivated the line. If
  removing a comment would not confuse a future reader, drop it.
- Never reference current tasks, callers, or session history in code or
  comments. Those live in the PR description and decay against the
  codebase over time.
- Surgical scope: behavior changes touch `glue.js` and the manifest version
  only. No reformatting passes, no speculative refactors.
- Light DOM is React's; never mutate it. All extension output goes into a
  shadow root (for attachments) or replaces only text nodes that KaTeX
  itself consumed (for direct render).

## Bumping the version

Bump `manifest.json` `version` for every shipped change that affects
behavior. Patch-level (`1.0.x`) is the default; reserve minor/major bumps
for user-visible feature shifts.
