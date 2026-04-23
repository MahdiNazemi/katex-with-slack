// Classes in which to look for LaTeX in Slack messages.
var classesToRender = [
	"p-rich_text_block",
	"p-rich_text_section",
	"c-message__message_blocks",
	"c-message__message_blocks--rich_text",
	"c-message__body",
	"c-message",
	"c-message__content",
	"c-message__content--feature_sonic_inputs",
	"c-message_kit__text",
	"c-message_kit__blocks",
	// Forwarded/shared messages
	"c-message_attachment__text"
];

// Supported delimiters. Single $ is intentionally excluded to avoid
// false positives on shell variables, prices and prose.
var delimiters = [
	{left: "$$$", right: "$$$", display: true},
	{left: "$$",  right: "$$",  display: false},
	{left: "\\(", right: "\\)", display: false},
	{left: "\\[", right: "\\]", display: true}
];

var renderOptions = { delimiters: delimiters };

var processedContent = new WeakMap();
// Match $$ (two or more dollars), \( or \[ — no single-$ false positives.
var latexPattern = /\$\$|\\\(|\\\[/;

// --- Shadow DOM rendering for Block Kit truncatable blocks ---
//
// Problem: KaTeX's renderMathInElement splits React-managed text nodes into
// fragments. React's fiber holds stateNode refs to the original text nodes.
// When Slack reconciles a "See more/See less" toggle, React calls removeChild
// on stale refs → NotFoundError. All monkey-patch approaches cause duplicate
// content (Martijn Hols, React #11538: "makes things worse, not better").
//
// Solution for c-message_attachment__text (Block Kit): Shadow DOM.
// Attach a shadow root to the inner text span (span[dir="auto"]) — NOT to the
// whole c-message_attachment__text which also contains the "See more" button.
// The shadow root renders KaTeX from a clone of the light DOM. React reconciles
// the light DOM (untouched), "See more/See less" works cleanly, and the shadow
// DOM updates whenever the light DOM changes.
//
// For all other element classes (p-rich_text_block etc.), renderMathInElement
// is used directly — those don't have the same See more/See less React conflict.

// Extension-internal URL for katex.css, to inject into each shadow root.
var katexCssUrl = null;
try {
	if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
		katexCssUrl = chrome.runtime.getURL('katex.css');
	}
} catch (e) {}

// WeakMap: textSpan → {shadow, cssInjected}
var shadowRoots = new WeakMap();

// Find the text-content span inside a c-message_attachment__text element.
// Each Block Kit section block has exactly one c-message_attachment__text with
// exactly one span[dir="auto"] text container. Multi-block messages have
// multiple c-message_attachment__text siblings, each processed independently
// by processAllMessages — there is no case of multiple text spans per attachment.
// The "See more" button is a sibling span OUTSIDE span[dir="auto"], so it stays
// in the light DOM and remains fully interactive after we shadow the text span.
function findTextSpan(el) {
	// Block Kit plain text: .p-plain_text_element > span[dir]
	// Block Kit mrkdwn: .p-mrkdwn_element > span[dir]
	return el.querySelector('span[dir="auto"]') ||
	       el.querySelector('span[dir]') ||
	       null;
}

// Get or create shadow root for the text span.
// Returns {shadow, fresh} where fresh=true means just created.
function getShadowRoot(textSpan) {
	if (shadowRoots.has(textSpan)) {
		return {shadow: shadowRoots.get(textSpan).shadow, fresh: false};
	}
	var shadow;
	try {
		shadow = textSpan.attachShadow({mode: 'open'});
	} catch (e) {
		// attachShadow throws when a shadow root already exists (e.g. extension
		// reloaded mid-session). Reclaim the existing open root rather than
		// falling through to direct DOM rendering, which triggers React errors.
		shadow = textSpan.shadowRoot;
		if (!shadow) return null;
	}
	shadowRoots.set(textSpan, {shadow: shadow});
	return {shadow: shadow, fresh: true};
}

// Inject KaTeX CSS and all external Slack stylesheets into a shadow root (once).
// <link> elements fetch from the browser cache (already loaded for the main document)
// and are not subject to CORS restrictions for CSS, so cross-origin Slack sheets
// (a.slack-edge.com) apply correctly inside shadow DOM. The onload callbacks call
// scheduleRender() so rendering only happens after every sheet is parsed and active.
function ensureKatexCSS(shadow) {
	if (shadow.querySelector('[data-katex-css]')) return;

	function injectLink(href) {
		var link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = href;
		link.setAttribute('data-katex-css', '1');
		link.addEventListener('load', function() { scheduleRender(); });
		shadow.appendChild(link);
	}

	if (katexCssUrl) injectLink(katexCssUrl);

	Array.from(document.styleSheets).forEach(function(sheet) {
		if (sheet.href) injectLink(sheet.href);
	});
}

// Returns true once every injected stylesheet <link> has been parsed.
// link.sheet is null until the browser has loaded and parsed the sheet.
function cssReady(shadow) {
	var links = shadow.querySelectorAll('link[data-katex-css]');
	if (!links.length) return true;
	for (var i = 0; i < links.length; i++) {
		if (!links[i].sheet) return false;
	}
	return true;
}

// Show the light DOM through a <slot> (used when not rendering math,
// e.g. truncated state). The slot is the ONLY content (except CSS link).
function showLightDOMSlot(shadow) {
	// Remove any rendered content
	Array.from(shadow.childNodes).forEach(function(n) {
		if (n.nodeType === 1 && n.getAttribute && n.getAttribute('data-katex-css')) return;
		if (n.tagName && n.tagName.toLowerCase() === 'slot') return;
		shadow.removeChild(n);
	});
	// Ensure slot exists so light DOM content shows through
	if (!shadow.querySelector('slot')) {
		shadow.appendChild(document.createElement('slot'));
	}
}

// Render KaTeX into the shadow root from a clone of the light DOM.
// Removes any slot (hides light DOM) and shows rendered content instead.
function renderIntoShadow(textSpan, shadow, options) {
	ensureKatexCSS(shadow);

	// Wait until all injected stylesheets are parsed. onload callbacks above
	// call scheduleRender(), which will re-invoke this function once ready.
	if (!cssReady(shadow)) return false;

	var clone = textSpan.cloneNode(true);

	// Wrap clone in ancestor divs (display:contents) that mirror the real DOM
	// hierarchy so that Slack CSS selectors depending on ancestor class names
	// (e.g. .p-mrkdwn_element .c-emoji img) match inside the shadow root.
	var ancestors = [];
	var p = textSpan.parentElement;
	for (var i = 0; i < 10 && p && p !== document.body; i++) {
		if (p.className) ancestors.push(p.className);
		p = p.parentElement;
	}
	var container = clone;
	for (var j = 0; j < ancestors.length; j++) {
		var wrap = document.createElement('div');
		wrap.className = ancestors[j];
		wrap.style.cssText = 'display:contents';
		wrap.appendChild(container);
		container = wrap;
	}

	try {
		renderMathInElement(clone, options);
	} catch (e) {
		console.warn('LaTeX in Slack: shadow render error', e);
		showLightDOMSlot(shadow);
		return false;
	}

	// Remove slot and old rendered content (keep CSS links)
	Array.from(shadow.childNodes).forEach(function(n) {
		if (n.nodeType === 1 && n.getAttribute && n.getAttribute('data-katex-css')) return;
		shadow.removeChild(n);
	});

	shadow.appendChild(container);
	return true;
}

// --- Truncation handling ---
//
// "See more" delay: wait 300ms on first encounter to let Slack finish layout
// and add "See more" buttons before we render, preventing the taller rendered
// content from triggering truncation on a React-modified DOM.

var firstSeenAt = new WeakMap();
var RENDER_DELAY_MS = 300;

// Return true if ANY block_kit truncation button in el is still collapsed.
function isTruncated(el) {
	if (!el || !el.querySelectorAll) return false;
	var btns = el.querySelectorAll('button[data-qa="block_kit_text_truncation"]');
	for (var i = 0; i < btns.length; i++) {
		if (btns[i].getAttribute('aria-expanded') !== 'true') return true;
	}
	return false;
}

function processElement(el, options) {
	var currentContent = el.textContent || '';

	if (currentContent.trim().length === 0) return;
	if (processedContent.get(el) === currentContent) return;

	var isAttachment = el.classList && el.classList.contains('c-message_attachment__text');
	var textSpan = isAttachment ? findTextSpan(el) : null;

	if (!latexPattern.test(currentContent)) {
		processedContent.set(el, currentContent);
		// If an attachment block had math rendered in its shadow DOM but the
		// current content (e.g. collapsed truncated text) contains no LaTeX,
		// clear the shadow so the raw light DOM shows through the slot.
		if (isAttachment && textSpan && shadowRoots.has(textSpan)) {
			var existingShadow = shadowRoots.get(textSpan).shadow;
			if (existingShadow.querySelector('.katex')) {
				showLightDOMSlot(existingShadow);
			}
		}
		return;
	}

	if (isAttachment && textSpan) {
		// Shadow DOM path: never modify React's light DOM
		var sr = getShadowRoot(textSpan);
		if (!sr) {
			// Shadow DOM not supported — fall through to direct rendering
		} else {
			if (sr.fresh) {
				// Shadow root just created. Show light DOM via slot while we wait
				// 300ms for Slack to evaluate layout and add "See more" if needed.
				// Without this delay we might render before the button appears,
				// growing the content and causing React DOM conflicts.
				showLightDOMSlot(sr.shadow);
				shadowRoots.get(textSpan).seenAt = Date.now();
				firstSeenAt.delete(el); // prevent stale entry leaking into non-attachment path
				setTimeout(function() { scheduleRender(); }, RENDER_DELAY_MS);
				return;
			}

			// Enforce the 300ms delay even after fresh: MutationObserver can
			// re-enter before the timeout fires with sr.fresh===false. Check the
			// timestamp stored on the shadow entry to gate the first render.
			var seenAt = shadowRoots.get(textSpan).seenAt;
			if (seenAt && (Date.now() - seenAt) < RENDER_DELAY_MS) return;
			if (seenAt) shadowRoots.get(textSpan).seenAt = null; // clear once passed

			// Shadow exists and delay has passed — respond immediately.
			// Collapse/re-expand cycles don't need a delay since the button state
			// is already established.
			if (isTruncated(el)) {
				// Truncated: show raw light DOM through slot.
				// Store current (collapsed) content so the next expand triggers a
				// fresh render (expanded content will differ → processedContent miss).
				showLightDOMSlot(sr.shadow);
				processedContent.set(el, currentContent);
				return;
			}
			// Not truncated: render KaTeX into shadow DOM.
			if (renderIntoShadow(textSpan, sr.shadow, options)) {
				processedContent.set(el, currentContent);
			}
			return;
		}
	}

	// Non-attachment elements: use the 300ms delay to guard against layout races.
	var now = Date.now();
	if (!firstSeenAt.has(el)) {
		firstSeenAt.set(el, now);
		setTimeout(function() { scheduleRender(); }, RENDER_DELAY_MS);
		return;
	}
	if (now - firstSeenAt.get(el) < RENDER_DELAY_MS) return;
	firstSeenAt.delete(el);

	// Direct rendering path (non-attachment elements, or shadow DOM unavailable).
	// Skip c-message_attachment__text children — those are handled via shadow DOM
	// above and must not be rendered again by a parent container's walk.
	if (isTruncated(el)) return;

	var directOptions = options;
	if (!isAttachment) {
		directOptions = Object.assign({}, options, {
			ignoredClasses: (options.ignoredClasses || []).concat(['c-message_attachment__text'])
		});
	}

	try {
		renderMathInElement(el, directOptions);
	} catch (e) {
		console.warn('LaTeX in Slack: render error', e);
	}
	processedContent.set(el, el.textContent || '');
}

function processAllMessages(options) {
	for (var j = 0; j < classesToRender.length; j++) {
		var messages = document.getElementsByClassName(classesToRender[j]);
		for (var i = 0; i < messages.length; i++) {
			processElement(messages.item(i), options);
		}
	}
}

// --- Rendering triggers ---

var renderScheduled = false;
function scheduleRender() {
	if (renderScheduled) return;
	renderScheduled = true;
	requestAnimationFrame(function() {
		renderScheduled = false;
		processAllMessages(renderOptions);
	});
}

var observer = new MutationObserver(function() {
	scheduleRender();
});

function startObserving() {
	var target = document.body || document.documentElement;
	if (!target) {
		setTimeout(startObserving, 100);
		return;
	}
	observer.observe(target, {
		childList: true,
		subtree: true,
		characterData: true
	});
	scheduleRender();
}

startObserving();

window.setInterval(scheduleRender, 3000);
