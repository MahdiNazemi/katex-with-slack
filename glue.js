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

var delimitersA = [
	{left: "$$$", right: "$$$", display: true},
	{left: "$$",  right: "$$",  display: false},
	{left: "\\(", right: "\\)", display: false},
	{left: "\\[", right: "\\]", display: true}
];
var delimitersB = [
	{left: "$$$", right: "$$$", display: true},
	{left: "$$",  right: "$$",  display: true},
	{left: "$",   right: "$",   display: false},
	{left: "\\(", right: "\\)", display: false},
	{left: "\\[", right: "\\]", display: true}
];

var processedContent = new WeakMap();
var latexPattern = /\$|\\[(\[]/;

var cachedOptions = { delimiters: delimitersA };

function refreshOptions() {
	chrome.storage.sync.get({
		delimiterstyle: 'A'
	}, function(items) {
		if (items.delimiterstyle === 'B') {
			cachedOptions = { delimiters: delimitersB };
		} else {
			cachedOptions = { delimiters: delimitersA };
		}
	});
}

if (chrome.storage.onChanged) {
	chrome.storage.onChanged.addListener(function() {
		refreshOptions();
	});
}

refreshOptions();

// --- Truncation handling ---
//
// KaTeX replaces text nodes with <span> elements. When Slack collapses
// or expands truncated content it triggers React reconciliation, which
// fails on KaTeX-modified DOM.
//
// Block Kit "See more": delay rendering until expanded (aria-expanded="true").
//
// Attachment "Show more/less": render freely when expanded, but undo KaTeX
// just before "Show less" is clicked so React collapses a clean DOM.

// Timestamp of when each element was first seen. We wait 300ms before
// rendering to let Slack finish layout and add "See more" if needed.
// Using timestamps instead of a boolean flag because MutationObserver
// triggers processElement many times before the 300ms elapses.
var firstSeenAt = new WeakMap();
var RENDER_DELAY_MS = 300;

// Check if a non-expanded Block Kit truncation button exists in the element
function isTruncated(el) {
	if (!el || !el.querySelector) return false;
	var btn = el.querySelector('button[data-qa="block_kit_text_truncation"]');
	if (!btn) return false;
	return btn.getAttribute('aria-expanded') !== 'true';
}

// Surgically undo KaTeX rendering by replacing .katex spans with the
// original LaTeX text from the embedded <annotation> tag.
function undoKatexInElement(el) {
	var displays = el.querySelectorAll('.katex-display');
	for (var i = displays.length - 1; i >= 0; i--) {
		var ann = displays[i].querySelector('annotation[encoding="application/x-tex"]');
		if (ann) {
			var parent = displays[i].parentNode;
			if (parent) parent.replaceChild(
				document.createTextNode('\\[' + ann.textContent + '\\]'), displays[i]);
		}
	}
	var inlines = el.querySelectorAll('.katex');
	for (var i = inlines.length - 1; i >= 0; i--) {
		if (inlines[i].closest('.katex-display')) continue;
		var ann = inlines[i].querySelector('annotation[encoding="application/x-tex"]');
		if (ann) {
			var parent = inlines[i].parentNode;
			if (parent) parent.replaceChild(
				document.createTextNode('\\(' + ann.textContent + '\\)'), inlines[i]);
		}
	}
}

// Capture "Show less" clicks on attachments before Slack processes them.
// Undo KaTeX so React collapses a clean DOM, then MutationObserver fires
// and we re-render the collapsed (truncated) state normally.
document.addEventListener('click', function(e) {
	var btn = e.target && e.target.closest &&
	          e.target.closest('button.c-message_attachment__text_expander');
	if (!btn || btn.getAttribute('aria-expanded') !== 'true') return;
	var attachmentText = btn.closest('.c-message_attachment__text');
	if (attachmentText && attachmentText.querySelector('.katex')) {
		undoKatexInElement(attachmentText);
		processedContent.delete(attachmentText);
	}
}, true); // capture phase: runs before Slack's handler

function processElement(el, options) {
	var currentContent = el.textContent || "";

	if (currentContent.trim().length === 0) {
		return;
	}

	if (processedContent.get(el) === currentContent) {
		return;
	}

	if (!latexPattern.test(currentContent)) {
		processedContent.set(el, currentContent);
		return;
	}

	// Delay rendering on first encounter to let Slack finish its layout
	// and add a "See more" button if needed. Without this delay, we
	// render before the button exists, the content grows taller, Slack
	// truncates our modified DOM, and "See more" breaks React.
	// Using a timestamp ensures we actually wait the full delay even
	// when MutationObserver re-triggers processElement in between.
	var now = Date.now();
	if (!firstSeenAt.has(el)) {
		firstSeenAt.set(el, now);
		setTimeout(function() { scheduleRender(); }, RENDER_DELAY_MS);
		return;
	}
	if (now - firstSeenAt.get(el) < RENDER_DELAY_MS) {
		return; // Still waiting for Slack to finish layout
	}
	firstSeenAt.delete(el);

	// If Slack truncated this message, skip rendering. The user will
	// click "See more", Slack expands the content (new DOM or changed
	// content), MutationObserver fires, and we go through the delay
	// cycle again — this time the button will be gone or expanded.
	if (isTruncated(el)) {
		return;
	}

	// Also check parent message container for truncation
	var msgContainer = el.closest && el.closest('[data-qa="message_content"]');
	if (msgContainer && isTruncated(msgContainer)) {
		return;
	}

	try {
		renderMathInElement(el, options);
	} catch (e) {
		console.warn("LaTeX in Slack: render error", e);
	}

	processedContent.set(el, el.textContent || "");
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
		processAllMessages(cachedOptions);
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

window.setInterval(function() {
	refreshOptions();
	scheduleRender();
}, 3000);
