export const NAVIGATION_KEY = `function navigationKey(event) {
	if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
	var target = event.composedPath()[0];
	if (target && (target.isContentEditable || (target.closest && target.closest('input, textarea, select, video, audio')))) return;
	return event.key;
}`;

export const PAGE_BRIDGE = `(function () {
'use strict';
${NAVIGATION_KEY}
var root = document.scrollingElement;
var last = new WeakMap();
var placed = false;
var main = null;
var press = null;
var held = false;
var INTERACTIVE = 'a[href], area[href], button, input, select, textarea, label, summary, video, audio, iframe, [contenteditable]:not([contenteditable="false"]), [tabindex], [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="textbox"], [role="searchbox"], [role="treeitem"]';
function post(message) { parent.postMessage(message, '*'); }
function spread(down, event) { return Math.max(Math.hypot(event.screenX - down.x, event.screenY - down.y), Math.hypot(event.clientX - down.cx, event.clientY - down.cy)); }
function shown(node) {
	if (node.scrollHeight <= node.clientHeight || !/auto|scroll/.test(getComputedStyle(node).overflowY)) return 0;
	if (node.checkVisibility ? !node.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : getComputedStyle(node).visibility !== 'visible') return 0;
	var box = node.getBoundingClientRect();
	var width = Math.min(box.right, innerWidth) - Math.max(box.left, 0);
	var height = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
	return width * 2 < innerWidth || height * 2 < innerHeight ? 0 : width * height;
}
function edge(event) {
	var target = event.composedPath()[0];
	if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return false;
	if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) || target.selectionStart === null || target.selectionStart !== target.selectionEnd) return false;
	var forward = (event.key === 'ArrowRight') === (getComputedStyle(target).direction !== 'rtl');
	return forward ? target.selectionEnd === target.value.length : target.selectionStart === 0;
}
function rootScrolls() {
	if (root.scrollHeight <= root.clientHeight) return false;
	var own = getComputedStyle(root).overflowY;
	var body = root.querySelector(':scope > body');
	var value = own === 'visible' && body ? getComputedStyle(body).overflowY : own;
	return value !== 'hidden' && value !== 'clip';
}
function mainScroller() {
	if (rootScrolls()) return root;
	if (!main || !main.isConnected || !shown(main)) {
		var best = 0;
		main = null;
		Array.prototype.forEach.call(document.querySelectorAll('*'), function (node) {
			var area = shown(node);
			if (area > best) { best = area; main = node; }
		});
	}
	return main;
}
function report() {
	var scroller = mainScroller();
	if (!placed || !scroller) return;
	var max = scroller.scrollHeight - scroller.clientHeight;
	post({ type: 'view-position', ratio: Math.min(Math.max(scroller.scrollTop, 0), max) / max });
}
document.addEventListener('keydown', function (event) {
	var key = navigationKey(event);
	if (key) post({ type: 'view-key', key: key });
	else if (event.key === 'Escape') post({ type: 'view-escape' });
	else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
		if (!held) document.addEventListener('wheel', free, blocking);
		held = true;
		post({ type: 'view-stay' });
	}
	if (key || edge(event)) event.preventDefault();
});
var options = { capture: true, passive: true };
var blocking = { capture: true, passive: false };
function free() {
	if (!held) return;
	held = false;
	document.removeEventListener('wheel', free, blocking);
	post({ type: 'view-free' });
}
document.addEventListener('touchstart', free, options);
document.addEventListener('pointerdown', function (event) {
	free();
	press = event.isPrimary && event.button === 0 && getSelection().isCollapsed ? { id: event.pointerId, x: event.screenX, y: event.screenY, cx: event.clientX, cy: event.clientY, at: event.timeStamp, far: 0 } : null;
}, options);
document.addEventListener('pointermove', function (event) {
	if (press && event.pointerId === press.id) press.far = Math.max(press.far, spread(press, event));
}, options);
document.addEventListener('pointercancel', function () { press = null; }, options);
document.addEventListener('pointerup', function (event) {
	var down = press;
	press = null;
	if (!down || event.pointerId !== down.id || event.timeStamp - down.at > 500 || Math.max(down.far, spread(down, event)) > 10) return;
	var key = event.clientX < innerWidth / 4 ? 'ArrowLeft' : event.clientX >= innerWidth * 3 / 4 ? 'ArrowRight' : undefined;
	var path = event.composedPath();
	if (!key || !(path[0] instanceof Element) || !getSelection().isCollapsed || getComputedStyle(path[0]).cursor === 'pointer') return;
	if (path.some(function (node) { return node instanceof Element && node.matches(INTERACTIVE); })) return;
	post({ type: 'view-tap', key: key });
}, options);
window.addEventListener('message', function (event) {
	var data = event.data;
	if (event.source !== parent || !data || data.type !== 'view-position' || !(data.ratio >= 0 && data.ratio <= 1)) return;
	placed = true;
	var scroller = mainScroller();
	if (!scroller) return;
	scroller.scrollTo({ top: data.ratio * (scroller.scrollHeight - scroller.clientHeight), behavior: 'instant' });
	last.set(scroller, scroller.scrollTop);
});
document.addEventListener('scroll', function (event) {
	var scroller = event.target === document ? root : event.target;
	if (scroller !== mainScroller()) return;
	var max = scroller.scrollHeight - scroller.clientHeight;
	var y = Math.min(Math.max(scroller.scrollTop, 0), max);
	if (y === last.get(scroller)) return;
	last.set(scroller, y);
	report();
}, options);
addEventListener('resize', report);
document.addEventListener('toggle', report, true);
new ResizeObserver(report).observe(document.documentElement);
})();`;

export const PAGE_BRIDGE_HASH = 'sha256-7oem/eTDd7ml89ffEYaaUNTgPFnDlphNFh/0uO4YF+A=';
