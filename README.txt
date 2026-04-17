LaTeX in Slack
==============

Renders LaTeX math formulas in Slack using the KaTeX library.
Forked from https://github.com/sophiehuiberts/katex-with-slack


Installation
------------

Clone or download this repository, then load the folder as an unpacked
extension in your browser:

Firefox:
  1. Go to about:debugging#/runtime/this-firefox
  2. Click "Load Temporary Add-on..."
  3. Select manifest.json from this folder
  Note: temporary add-ons are removed when Firefox restarts.
  For a permanent install, submit to addons.mozilla.org.

Chrome:
  1. Go to chrome://extensions
  2. Enable "Developer mode" (top right toggle)
  3. Click "Load unpacked"
  4. Select this folder

After loading, open Slack in a new tab (or hard-refresh an existing one).


Delimiters
----------

  Inline math:  \( .. \)  or  $$ .. $$
  Display math: \[ .. \]  or  $$$ .. $$$

Single $ is not supported as a delimiter to avoid false positives on
shell variables, prices and other prose containing dollar signs.

Newlines in formulas: use \newline (double backslash \\ is ignored).
Shorthands: \N, \R, \Z for \mathbb{N}, \mathbb{R}, \mathbb{Z}.
More: https://github.com/KaTeX/KaTeX/blob/main/src/macros.js


Troubleshooting
---------------

1. Slack uses _ for italics and * for boldface. This can interfere with
   LaTeX subscripts when typing messages directly in Slack. Workarounds:
   a) Escape with double backslash: $$\bar\chi^{\\*}\\_W$$
   b) Add spaces: $$\bar\chi^ *  _ W$$

2. Messages sent via the Slack API with a "See more" button: the
   extension delays rendering until the message is fully expanded
   to avoid conflicts with Slack's React reconciliation.


Licence
-------

MIT licence. See LICENSE file.

katex.js, katex.css, auto-render.js, and the fonts directory are from
the KaTeX project: https://github.com/KaTeX/KaTeX/releases

This plugin is not associated with the KaTeX project
nor with Slack or Slack Technologies, Inc.
