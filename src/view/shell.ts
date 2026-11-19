import type { Labels } from '../core/types.ts';
import { MEDIA_URL_LIFE, PLACEHOLDER_SVG } from './media.ts';
import type { CssVars } from './theme.ts';

export const LATE_KEY = { window: 10_000, pause: 1_000 } as const;
export const CHOSEN_CLOSE = 1_500;

const VARIABLES: readonly [name: string, telegram: string | undefined, light: string, dark: string][] = [
	['background', 'bg-color', 'oklch(1 0 0)', 'oklch(0.145 0 0)'],
	['foreground', 'text-color', 'oklch(0.145 0 0)', 'oklch(0.985 0 0)'],
	['card', 'section-bg-color', 'oklch(1 0 0)', 'oklch(0.205 0 0)'],
	['card-foreground', 'text-color', 'oklch(0.145 0 0)', 'oklch(0.985 0 0)'],
	['popover', 'section-bg-color', 'oklch(1 0 0)', 'oklch(0.205 0 0)'],
	['popover-foreground', 'text-color', 'oklch(0.145 0 0)', 'oklch(0.985 0 0)'],
	['primary', 'button-color', 'oklch(0.205 0 0)', 'oklch(0.922 0 0)'],
	['primary-foreground', 'button-text-color', 'oklch(0.985 0 0)', 'oklch(0.205 0 0)'],
	['secondary', 'secondary-bg-color', 'oklch(0.97 0 0)', 'oklch(0.269 0 0)'],
	['secondary-foreground', 'text-color', 'oklch(0.205 0 0)', 'oklch(0.985 0 0)'],
	['muted', 'secondary-bg-color', 'oklch(0.97 0 0)', 'oklch(0.269 0 0)'],
	['muted-foreground', 'hint-color', 'oklch(0.556 0 0)', 'oklch(0.708 0 0)'],
	['accent', 'secondary-bg-color', 'oklch(0.97 0 0)', 'oklch(0.269 0 0)'],
	['accent-foreground', 'accent-text-color', 'oklch(0.205 0 0)', 'oklch(0.985 0 0)'],
	['destructive', 'destructive-text-color', 'oklch(0.577 0.245 27.325)', 'oklch(0.704 0.191 22.216)'],
	['border', 'section-separator-color', 'oklch(0.922 0 0)', 'oklch(1 0 0 / 10%)'],
	['input', 'section-separator-color', 'oklch(0.922 0 0)', 'oklch(1 0 0 / 15%)'],
	['ring', 'link-color', 'oklch(0.708 0 0)', 'oklch(0.556 0 0)'],
	['radius', undefined, '0.625rem', '0.625rem'],
	['chart-1', undefined, 'oklch(0.646 0.222 41.116)', 'oklch(0.488 0.243 264.376)'],
	['chart-2', undefined, 'oklch(0.6 0.118 184.704)', 'oklch(0.696 0.17 162.48)'],
	['chart-3', undefined, 'oklch(0.398 0.07 227.392)', 'oklch(0.769 0.188 70.08)'],
	['chart-4', undefined, 'oklch(0.828 0.189 84.429)', 'oklch(0.627 0.265 303.9)'],
	['chart-5', undefined, 'oklch(0.769 0.188 70.08)', 'oklch(0.645 0.246 16.439)'],
];

const THEME_VARIABLES = VARIABLES.map(([name]) => name);

const declarations = (scheme: 'light' | 'dark') =>
	VARIABLES.map(([name, telegram, light, dark]) => {
		const fixed = scheme === 'light' ? light : dark;
		return `--${name}: ${telegram ? `var(--tg-theme-${telegram}, ${fixed})` : fixed};`;
	}).join(' ');

const STYLE = `
:root { ${declarations('light')} color-scheme: light; }
:root.dark { ${declarations('dark')} color-scheme: dark; }
html, body { margin: 0; height: 100%; }
body { background: var(--background); color: var(--foreground); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
#view { display: flex; flex-direction: column; height: 100%; }
.title { flex: none; margin: 12px 16px 0; font-size: 18px; line-height: 1.3; }
.context { flex: 0 1 auto; max-height: 35vh; overflow-y: auto; margin: 10px 12px 0; padding: 10px 14px; border-radius: var(--radius); background: var(--muted); color: var(--foreground); overflow-wrap: anywhere; }
.context > :first-child { margin-top: 0; }
.context > :last-child { margin-bottom: 0; }
#tabs { flex: none; display: flex; gap: 8px; padding: 12px; overflow-x: auto; scrollbar-width: none; }
#tabs::-webkit-scrollbar { display: none; }
#tabs button { flex: none; min-height: 40px; padding: 0 16px; border: 0; border-radius: 20px; background: var(--secondary); color: var(--secondary-foreground); font: 500 15px/1 system-ui, -apple-system, sans-serif; cursor: pointer; }
#tabs button[aria-selected="true"] { background: var(--primary); color: var(--primary-foreground); }
#tabs button:focus-visible, .link:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
#panels { flex: 1; min-height: 0; display: flex; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x mandatory; overscroll-behavior-x: contain; scrollbar-width: none; }
#panels::-webkit-scrollbar { display: none; }
.panel { flex: 0 0 100%; min-width: 0; box-sizing: border-box; overflow-y: auto; scroll-snap-align: start; scroll-snap-stop: always; padding: 0 16px 16px; }
.panel.page { display: flex; padding: 0; overflow: hidden; }
.panel.page iframe { flex: 1; width: 100%; height: 100%; border: 0; background: var(--background); }
.markdown { overflow-wrap: anywhere; }
.markdown img { max-width: 100%; height: auto; border-radius: calc(var(--radius) - 2px); }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; }
.markdown pre { padding: 12px; overflow-x: auto; border-radius: var(--radius); background: var(--muted); }
.markdown :not(pre) > code { padding: 1px 5px; border-radius: 4px; background: var(--muted); }
.markdown blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--muted-foreground); }
.wide { overflow-x: auto; }
.markdown table { border-collapse: collapse; }
.markdown th, .markdown td { padding: 6px 10px; border: 1px solid var(--border); text-align: left; }
.markdown hr { border: 0; border-top: 1px solid var(--border); }
.link { color: var(--ring); text-decoration: underline; cursor: pointer; }
.muted { color: var(--muted-foreground); }
.diff { display: grid; grid-template-columns: minmax(100%, max-content); margin: 12px -16px 0; overflow-x: auto; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
.diff > div { padding: 0 16px; }
.add { background: color-mix(in srgb, var(--chart-2) 18%, transparent); }
.del { background: color-mix(in srgb, var(--destructive) 18%, transparent); }
.hunk { color: var(--muted-foreground); background: var(--muted); }
.meta { font-weight: 600; }
.gallery { display: grid; gap: 20px; padding-top: 4px; }
.gallery figure { margin: 0; }
.gallery img, .gallery video { display: block; width: 100%; height: auto; max-height: 70vh; object-fit: contain; border-radius: var(--radius); background: var(--muted); }
.gallery figcaption { margin-top: 6px; color: var(--muted-foreground); font-size: 14px; overflow-wrap: anywhere; }
.hint { flex: none; margin: 0; padding: 8px 16px 12px; color: var(--muted-foreground); font-size: 13px; text-align: center; }
.hint[hidden] { display: none; }
.state { margin: auto; padding: 24px; color: var(--muted-foreground); text-align: center; }
`;

export const SHELL_LIB = String.raw`
var RETRY = { window: ${LATE_KEY.window}, pause: ${LATE_KEY.pause} };
var LIFE = ${MEDIA_URL_LIFE};
var CLOSE_DELAY = ${CHOSEN_CLOSE};
var PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(${JSON.stringify(PLACEHOLDER_SVG)});

// Fetches url and asks again every RETRY.pause ms while the answer is 404, until RETRY.window ms
// have passed since the first ask. A storage may show a new key late; the last answer counts.
async function fetchRetry(url, init, io) {
	var start = io.now();
	for (;;) {
		var response = await io.fetch(url, init);
		if (response.status !== 404 || io.now() - start + RETRY.pause > RETRY.window) return response;
		await io.sleep(RETRY.pause);
	}
}

// Asks for the view again every RETRY.pause ms until an answer carries a context, for up to
// RETRY.window ms: a view opened from a question may show before that question's context does.
// Resolves to that answer, whose context comes with the binding of a question answered in the
// view, or to null once the window passed.
async function fetchContext(url, init, io) {
	var start = io.now();
	for (;;) {
		if (io.now() - start + RETRY.pause > RETRY.window) return null;
		await io.sleep(RETRY.pause);
		try {
			var response = await io.fetch(url, init);
			if (response.ok) {
				var answer = await response.json();
				if (answer.context) return answer;
			}
		} catch (error) {}
	}
}

// The option of a binding whose tab has this label, else null.
function boundOption(binding, label) {
	var options = binding && Array.isArray(binding.options) ? binding.options : [];
	for (var i = 0; i < options.length; i++) if (options[i] && options[i].tab === label) return options[i];
	return null;
}

// Random bytes as base64url without padding: 16 bytes make the 22 characters of a choice id.
function choiceId(bytes) {
	var text = '';
	for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The policy of a page, as the meta element in front of its markup states it.
function pagePolicy(origin) {
	return "default-src 'none'; style-src 'unsafe-inline'; img-src data: " + origin + '; media-src ' + origin + '; font-src data:';
}

// What a page's srcdoc starts with: the doctype, the page policy, a viewport and the resolved
// theme as a :root block, with a base rule for the body.
function pagePrefix(origin, vars, dark) {
	var lines = Object.keys(vars).map(function (name) { return '--' + name + ': ' + vars[name] + ';'; }).join(' ');
	return '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + pagePolicy(origin) + '"><meta name="viewport" content="width=device-width, initial-scale=1">' +
		'<style>:root { ' + lines + ' color-scheme: ' + (dark ? 'dark' : 'light') + '; } body { margin: 16px; background: var(--background); color: var(--foreground); font: 16px/1.5 system-ui, -apple-system, sans-serif; }</style>';
}

// A CSS value that cannot end a declaration, a rule or the style block, else null.
function safeCss(value) {
	var text = String(value).trim();
	return text !== '' && !/[;{}<>\\]|\/\*/.test(text) ? text : null;
}

// The theme blocks that apply in this colour scheme: theme, then light or dark, the later winning.
function themeBlocks(theme, dark) {
	var vars = {};
	[theme && theme.theme, theme && (dark ? theme.dark : theme.light)].forEach(function (block) {
		if (!block || typeof block !== 'object') return;
		Object.keys(block).forEach(function (name) {
			var value = safeCss(block[name]);
			if (/^[a-z0-9-]{1,64}$/.test(name) && value !== null) vars[name] = value;
		});
	});
	return vars;
}

// The value of each variable by read(name), without the empty and the unsafe ones.
function resolveVars(names, read) {
	var vars = {};
	names.forEach(function (name) {
		var value = safeCss(read(name));
		if (value !== null) vars[name] = value;
	});
	return vars;
}

// The media indexes a text refers to as media:<index>.
function mediaIndexes(text) {
	var found = [];
	String(text).replace(/\bmedia:(\d{1,2})(?!\d)/g, function (whole, index) {
		if (found.indexOf(Number(index)) < 0) found.push(Number(index));
		return whole;
	});
	return found;
}

// The text with each media:<index> replaced by urls[index], or by the placeholder when that is
// empty. An index without an entry stays as written.
function resolveMedia(text, urls) {
	return String(text).replace(/\bmedia:(\d{1,2})(?!\d)/g, function (whole, index) {
		var url = urls[Number(index)];
		return url === undefined ? whole : url || PLACEHOLDER;
	});
}

// The elements the shell draws typed content with. Any other tag draws nothing.
var TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'div', 'span', 'a', 'img'];

// The media indexes of a Markdown tab's map from image destination to index, each once.
function mapIndexes(map) {
	var found = [];
	Object.keys(map || {}).forEach(function (key) {
		var index = map[key];
		if (typeof index === 'number' && found.indexOf(index) < 0) found.push(index);
	});
	return found;
}

// The address an image of typed content loads: for a destination that the tab's map names, the
// probed URL of its media index, or the placeholder when its probe found it missing. Undefined
// for any other destination, which shows its alt text. images is { urls, map }, or nothing.
function imageSource(src, images) {
	var key = String(src || '');
	var map = images && images.map;
	var index = map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
	var url = typeof index === 'number' ? images.urls[index] : undefined;
	return url === undefined ? undefined : url || PLACEHOLDER;
}

// A link the shell may open: an http or https URL, or t.me without a scheme. Null for any other.
function safeLink(href) {
	var text = String(href).trim();
	if (/^t\.me\//i.test(text)) text = 'https://' + text;
	var url;
	try {
		url = new URL(text);
	} catch (error) {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	return { href: url.href, telegram: url.hostname === 't.me' };
}

// [label](target) at text[i], with nested brackets and parentheses, or null.
function linkAt(text, i) {
	var depth = 0;
	var j = i;
	for (; j < text.length; j++) {
		var c = text.charAt(j);
		if (c === '\\') { j++; continue; }
		if (c === '[') depth++;
		else if (c === ']' && --depth === 0) break;
	}
	if (j >= text.length || text.charAt(j + 1) !== '(') return null;
	var parens = 1;
	var k = j + 2;
	for (; k < text.length; k++) {
		var d = text.charAt(k);
		if (d === '\\') { k++; continue; }
		if (d === '\n') return null;
		if (d === '(') parens++;
		else if (d === ')' && --parens === 0) break;
	}
	if (k >= text.length) return null;
	var target = text.slice(j + 2, k).trim().replace(/^<(.*)>$/, '$1').split(/\s+/)[0] || '';
	return { label: text.slice(i + 1, j), href: target, end: k + 1 };
}

// *em*, _em_, **strong**, __strong__ or ~~del~~ at text[i], or null.
function emphasisAt(text, i) {
	var mark = text.charAt(i);
	var double = text.charAt(i + 1) === mark;
	if (mark === '~' && !double) return null;
	var delimiter = double ? mark + mark : mark;
	var open = i + delimiter.length;
	if (open >= text.length || /\s/.test(text.charAt(open))) return null;
	if (mark === '_' && i > 0 && /[A-Za-z0-9]/.test(text.charAt(i - 1))) return null;
	var close = open;
	for (;;) {
		close = text.indexOf(delimiter, close + 1);
		if (close === -1) return null;
		if (/\s/.test(text.charAt(close - 1))) continue;
		if (mark === '_' && /[A-Za-z0-9]/.test(text.charAt(close + delimiter.length))) continue;
		if (!double && text.charAt(close + 1) === mark) { close++; continue; }
		break;
	}
	return { tag: mark === '~' ? 'del' : double ? 'strong' : 'em', inner: text.slice(open, close), end: close + delimiter.length };
}

// Inline Markdown as nodes: a string is a text node, { t, c } an element. Raw HTML stays text.
function markdownInline(text) {
	var out = [];
	var buffer = '';
	var i = 0;
	function push(node) {
		if (buffer) { out.push(buffer); buffer = ''; }
		out.push(node);
	}
	while (i < text.length) {
		var ch = text.charAt(i);
		var rest = text.slice(i);
		var found;
		if (ch === '\\' && i + 1 < text.length) {
			var next = text.charAt(i + 1);
			if (next === '\n') { push({ t: 'br' }); i += 2; continue; }
			if (/[!-\/:-@\[-\x60{-~]/.test(next)) { buffer += next; i += 2; continue; }
		}
		if (ch === '\n') {
			if (/ {2,}$/.test(buffer)) { buffer = buffer.replace(/ +$/, ''); push({ t: 'br' }); }
			else buffer += '\n';
			i++;
			continue;
		}
		if (ch === '\x60') {
			var run = /^\x60+/.exec(rest)[0];
			var end = text.indexOf(run, i + run.length);
			if (end > -1) {
				push({ t: 'code', c: [text.slice(i + run.length, end).replace(/^ (.+) $/, '$1')] });
				i = end + run.length;
				continue;
			}
			buffer += run;
			i += run.length;
			continue;
		}
		if (ch === '<' && (found = /^<((?:https?:\/\/|t\.me\/)[^\s<>]+)>/.exec(rest))) {
			var auto = safeLink(found[1]);
			if (auto) { push({ t: 'a', href: auto.href, telegram: auto.telegram, c: [found[1]] }); i += found[0].length; continue; }
		}
		if (ch === '!' && text.charAt(i + 1) === '[' && (found = linkAt(text, i + 1))) {
			push({ t: 'img', src: found.href, alt: found.label });
			i = found.end;
			continue;
		}
		if (ch === '[' && (found = linkAt(text, i))) {
			var link = safeLink(found.href);
			push(link ? { t: 'a', href: link.href, telegram: link.telegram, c: markdownInline(found.label) } : { t: 'span', c: markdownInline(found.label) });
			i = found.end;
			continue;
		}
		if ((ch === '*' || ch === '_' || ch === '~') && (found = emphasisAt(text, i))) {
			push({ t: found.tag, c: markdownInline(found.inner) });
			i = found.end;
			continue;
		}
		buffer += ch;
		i++;
	}
	if (buffer) out.push(buffer);
	return out;
}

var ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])\s+(.*)$/;
var RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
var FENCE = /^ {0,3}(\x60{3,}|~{3,})/;
var HEADING = /^ {0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/;
var QUOTE = /^ {0,3}>/;
var SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function blank(line) { return /^\s*$/.test(line); }
function tableAt(lines, i) { return i + 1 < lines.length && lines[i].indexOf('|') > -1 && lines[i + 1].indexOf('|') > -1 && SEPARATOR.test(lines[i + 1]); }
function startsBlock(lines, i) { var line = lines[i]; return FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || RULE.test(line) || ITEM.test(line) || tableAt(lines, i); }
// The cells of a table row; an escaped pipe stays in its cell.
function cells(line) {
	var text = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	var out = [''];
	for (var i = 0; i < text.length; i++) {
		if (text.charAt(i) === '\\' && text.charAt(i + 1) === '|') { out[out.length - 1] += '|'; i++; }
		else if (text.charAt(i) === '|') out.push('');
		else out[out.length - 1] += text.charAt(i);
	}
	return out.map(function (cell) { return cell.trim(); });
}

// Block Markdown as nodes: headings, fenced code, quotes, lists, tables, rules and paragraphs.
function markdownBlocks(source) {
	var lines = String(source).replace(/\r\n?/g, '\n').split('\n').map(function (line) {
		return line.replace(/^\t+/, function (tabs) { return '    '.repeat(tabs.length); });
	});
	var out = [];
	var i = 0;
	var found;
	while (i < lines.length) {
		var line = lines[i];
		if (blank(line)) { i++; continue; }
		if ((found = FENCE.exec(line))) {
			var close = new RegExp('^ {0,3}' + (found[1].charAt(0) === '~' ? '~' : '\\x60') + '{' + found[1].length + ',}\\s*$');
			var code = [];
			i++;
			while (i < lines.length && !close.test(lines[i])) code.push(lines[i++]);
			i++;
			out.push({ t: 'pre', c: [{ t: 'code', c: [code.join('\n')] }] });
			continue;
		}
		if ((found = HEADING.exec(line))) {
			out.push({ t: 'h' + found[1].length, c: markdownInline(found[2]) });
			i++;
			continue;
		}
		if (RULE.test(line)) { out.push({ t: 'hr' }); i++; continue; }
		if (QUOTE.test(line)) {
			var quoted = [];
			while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(/^ {0,3}> ?/, ''));
			out.push({ t: 'blockquote', c: markdownBlocks(quoted.join('\n')) });
			continue;
		}
		if ((found = ITEM.exec(line))) {
			var ordered = found[3] !== undefined;
			var list = { t: ordered ? 'ol' : 'ul', c: [] };
			if (ordered && Number(found[3]) !== 1) list.start = Number(found[3]);
			while (i < lines.length && (found = ITEM.exec(lines[i])) && (found[3] !== undefined) === ordered) {
				var indent = found[1].length + found[2].length + 1;
				var body = [found[4]];
				i++;
				while (i < lines.length) {
					if (blank(lines[i])) {
						var j = i;
						while (j < lines.length && blank(lines[j])) j++;
						if (j < lines.length && /^ {2,}\S/.test(lines[j])) { while (i < j) { body.push(''); i++; } continue; }
						if (j < lines.length && (found = ITEM.exec(lines[j])) && (found[3] !== undefined) === ordered) i = j;
						break;
					}
					if (/^ {2,}\S/.test(lines[i])) { body.push(lines[i++].replace(new RegExp('^ {0,' + indent + '}'), '')); continue; }
					if (startsBlock(lines, i)) break;
					body.push(lines[i++]);
				}
				var inner = markdownBlocks(body.join('\n'));
				list.c.push({ t: 'li', c: inner.length === 1 && inner[0].t === 'p' ? inner[0].c : inner });
				if (i < lines.length && blank(lines[i])) break;
			}
			out.push(list);
			continue;
		}
		if (tableAt(lines, i)) {
			var head = cells(line);
			var rows = [];
			i += 2;
			while (i < lines.length && !blank(lines[i]) && lines[i].indexOf('|') > -1) rows.push(cells(lines[i++]));
			var cell = function (tag) { return function (text) { return { t: tag, c: markdownInline(text) }; }; };
			out.push({ t: 'div', k: 'wide', c: [{ t: 'table', c: [
				{ t: 'thead', c: [{ t: 'tr', c: head.map(cell('th')) }] },
				{ t: 'tbody', c: rows.map(function (row) { return { t: 'tr', c: row.map(cell('td')) }; }) },
			] }] });
			continue;
		}
		var paragraph = [line];
		i++;
		while (i < lines.length && !blank(lines[i]) && !startsBlock(lines, i)) paragraph.push(lines[i++]);
		out.push({ t: 'p', c: markdownInline(paragraph.join('\n')) });
	}
	return out;
}

// A unified diff as one line node each, classed as meta, hunk, add, del or ctx.
function diffLines(text) {
	return String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(function (line) {
		var kind = /^(diff |index |\+\+\+ |--- |new file|deleted file|similarity |rename )/.test(line) ? 'meta' : /^@@/.test(line) ? 'hunk' : line.charAt(0) === '+' ? 'add' : line.charAt(0) === '-' ? 'del' : 'ctx';
		return { t: 'div', k: kind, c: [line === '' ? ' ' : line] };
	});
}

// The items of a gallery tab, in order, as { kind, src, caption }: a video with its probed URL,
// an image with its probed URL, and the placeholder image for an item whose probe found it
// missing or whose index has no URL. urls holds the probed URL of each media index, '' for one
// found missing.
function galleryItems(gallery, urls) {
	return (Array.isArray(gallery) ? gallery : []).filter(function (item) {
		return item && typeof item.media === 'number';
	}).map(function (item) {
		var url = urls[item.media];
		var video = /^video\//.test(String(item.type));
		return { kind: url && video ? 'video' : 'image', src: url || PLACEHOLDER, caption: typeof item.caption === 'string' ? item.caption : '' };
	});
}

// The words of a rich text value: a string, a list, or an object with text.
function richText(value) {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(richText).join('');
	if (value && typeof value === 'object') return richText(value.text);
	return '';
}

// A blocks body as one paragraph of plain text per block, depth first.
function blocksText(blocks) {
	var out = [];
	(Array.isArray(blocks) ? blocks : []).forEach(function (block) {
		if (!block || typeof block !== 'object') return;
		var parts = [];
		if (block.summary) parts.push(richText(block.summary));
		if (block.text) parts.push(richText(block.text));
		if (Array.isArray(block.cells)) block.cells.forEach(function (row) {
			parts.push((Array.isArray(row) ? row : []).map(function (cell) { return cell ? richText(cell.text) : ''; }).join(' | '));
		});
		if (parts.length > 0) out.push({ t: 'p', c: [parts.join('\n')] });
		out = out.concat(blocksText(block.blocks));
		(Array.isArray(block.items) ? block.items : []).forEach(function (item) { if (item) out = out.concat(blocksText(item.blocks)); });
	});
	return out;
}

// A question's body as nodes: Markdown drawn, HTML and blocks as plain text. htmlText turns HTML into its text.
function contextNodes(body, htmlText) {
	if (!body || typeof body !== 'object') return [];
	if (typeof body.markdown === 'string') return markdownBlocks(body.markdown);
	if (typeof body.html === 'string') return [{ t: 'p', c: [htmlText(body.html)] }];
	return blocksText(body.blocks);
}
`;

const SHELL_MAIN = String.raw`
var app = window.Telegram && window.Telegram.WebApp;
var root = document.documentElement;
var view = document.getElementById('view');
var VARS = ${JSON.stringify(THEME_VARIABLES)};
var CLASSES = ['wide', 'diff', 'add', 'del', 'hunk', 'meta', 'ctx', 'markdown', 'context', 'muted'];

function data(id) {
	try {
		return JSON.parse(document.getElementById(id).textContent) || {};
	} catch (error) {
		return {};
	}
}
var labels = data('labels');
var theme = data('theme');
var query = new URLSearchParams(location.search);
var viewId = query.get('v');
var ref = query.get('q');
var wanted = query.get('t');
var initData = app ? app.initData : '';
// The SDK has read the launch data from the fragment, and keeps it in sessionStorage.
history.replaceState(null, '', location.pathname + location.search);

var expiresAt = Date.now() + LIFE;
var expired = false;
var timer = 0;
var themed = [];
var frames = [];
var probes = {};
// The tabs and the open one, the binding of the question once visible, and the state of a choice:
// sending while the host has not answered, done once it stored one, and the option and choice id
// of the last tap, which a second tap on the same option sends again.
var tabs = [];
var current = 0;
var binding = null;
var sending = false;
var done = false;
var pending = null;
var hint = null;
var main = app && app.MainButton;

function element(tag, className, text) {
	var node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}
function state(text) {
	view.replaceChildren(element('p', 'state', text));
}
// The line below the content: a hint, a late question, or what became of a choice. Empty hides it.
function say(text) {
	if (!hint) return;
	hint.textContent = text;
	hint.hidden = !text;
}
// Calls one method of the main button, if the client has it and the method.
function invoke(button, method, value) {
	try {
		if (button && typeof button[method] === 'function') button[method](value);
	} catch (error) {}
}
// The option bound to the open tab, while a choice can still be made.
function chosenOption() {
	if (!binding || binding.closed || done || expired || !tabs[current]) return null;
	return boundOption(binding, tabs[current].label);
}
function bottom() {
	var option = chosenOption();
	if (!option) {
		invoke(main, 'hide');
		return;
	}
	invoke(main, 'setText', labels.choose + ' ' + option.label);
	invoke(main, sending ? 'disable' : 'enable');
	invoke(main, 'show');
}
// Posts the choice of option with the launch data. A 2xx means the host stored it: the shell
// says so and closes. Old launch data ends the choice until the view opens again, and a closed
// question ends it too; any other failure keeps the view open for another tap.
function choose(option) {
	if (sending) return;
	if (!pending || pending.index !== option.index) pending = { index: option.index, id: choiceId(crypto.getRandomValues(new Uint8Array(16))) };
	sending = true;
	bottom();
	var url = '/api/answer?v=' + encodeURIComponent(viewId) + '&q=' + encodeURIComponent(ref) + '&n=' + option.index + '&c=' + pending.id;
	io.fetch(url, { method: 'POST', headers: { Authorization: 'tma ' + initData } }).then(function (response) {
		sending = false;
		if (response.ok) {
			pending = null;
			done = true;
			say(labels.chosen);
			bottom();
			setTimeout(function () { app.close(); }, CLOSE_DELAY);
			return;
		}
		if (response.status === 401 || response.status === 410) binding = null;
		say(response.status === 401 ? labels.viewExpired : response.status === 410 ? labels.closed : labels.viewError);
		bottom();
	}, function () {
		sending = false;
		say(labels.viewError);
		bottom();
	});
}
function check() {
	if (expired || Date.now() < expiresAt) return;
	expired = true;
	frames = [];
	state(labels.viewExpired);
	bottom();
}
function arm() {
	clearTimeout(timer);
	timer = setTimeout(check, Math.max(0, expiresAt - Date.now()));
}

function dark() {
	return !!app && app.colorScheme === 'dark';
}
function applyTheme() {
	root.classList.toggle('dark', dark());
	themed.forEach(function (name) { root.style.removeProperty('--' + name); });
	var vars = themeBlocks(theme, dark());
	themed = Object.keys(vars);
	themed.forEach(function (name) { root.style.setProperty('--' + name, vars[name]); });
}
function resolved() {
	var style = getComputedStyle(root);
	return resolveVars(VARS.concat(themed), function (name) { return style.getPropertyValue('--' + name); });
}
function drawFrame(entry) {
	entry.frame.srcdoc = pagePrefix(location.origin, resolved(), dark()) + entry.page;
}

function openLink(node) {
	if (!app) return;
	if (node.telegram) app.openTelegramLink(node.href);
	else app.openLink(node.href);
}
function htmlText(html) {
	return new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
}
// A node of the Markdown, diff and context functions as DOM: text nodes and a fixed set of
// elements. A link is a span that opens through Telegram, so the shell never navigates. An image
// shows only a destination of the tab's media map, as its probed URL or the placeholder; any other
// shows its alt text. images is { urls, map } for a Markdown tab, and nothing for a context.
function build(node, images) {
	if (typeof node === 'string') return document.createTextNode(node);
	if (TAGS.indexOf(node.t) < 0) return document.createTextNode('');
	if (node.t === 'img') {
		var source = imageSource(node.src, images);
		if (source === undefined) return element('span', 'muted', node.alt || '');
		var image = document.createElement('img');
		image.addEventListener('error', function () { if (image.src !== PLACEHOLDER) image.src = PLACEHOLDER; });
		image.src = source;
		image.alt = node.alt || '';
		return image;
	}
	var made = document.createElement(node.t === 'a' ? 'span' : node.t);
	if (node.k && CLASSES.indexOf(node.k) > -1) made.className = node.k;
	if (node.t === 'a') {
		made.className = 'link';
		made.setAttribute('role', 'link');
		made.tabIndex = 0;
		var open = function (event) { event.preventDefault(); openLink(node); };
		made.addEventListener('click', open);
		made.addEventListener('keydown', function (event) { if (event.key === 'Enter') open(event); });
	}
	if (node.t === 'ol' && node.start) made.start = node.start;
	(node.c || []).forEach(function (child) { made.append(build(child, images)); });
	return made;
}

var io = {
	fetch: function (url, init) { return fetch(url, init); },
	sleep: function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); },
	now: function () { return Date.now(); },
};
// The URL of each media index a text names, once its first byte arrived, or '' when it did not.
// The host waits up to 10 s for a media object its view committed, on this request and on every
// later load of it, so one ask covers a late key; an object that stays missing comes back as the
// placeholder image, which counts as missing here.
function probeAll(indexes, media) {
	return Promise.all(indexes.map(function (index) {
		if (typeof media[index] !== 'string') return undefined;
		probes[index] = probes[index] || io.fetch(media[index], { headers: { Range: 'bytes=0-0' } }).then(
			function (response) { return response.ok && response.headers.get('Content-Type') !== 'image/svg+xml' ? media[index] : ''; },
			function () { return ''; }
		);
		return probes[index];
	})).then(function (found) {
		var urls = [];
		indexes.forEach(function (index, position) { if (found[position] !== undefined) urls[index] = found[position]; });
		return urls;
	});
}

// The image of a gallery item at src, which falls back to the placeholder when its load fails.
function galleryImage(src, caption) {
	var image = document.createElement('img');
	image.addEventListener('error', function () { if (image.src !== PLACEHOLDER) image.src = PLACEHOLDER; });
	image.alt = caption;
	image.src = src;
	return image;
}

// A gallery as one figure per item: a video plays inline with the native controls and loads its
// metadata alone until played, an image falls back to the placeholder when its load fails, and a
// caption is a text node. A video whose load fails, such as an object that went missing after
// its probe, for which the host answers the placeholder image, becomes the placeholder image in
// its figure, above its caption.
function drawGallery(items) {
	var list = element('div', 'gallery');
	items.forEach(function (item) {
		var figure = element('figure');
		var shown;
		if (item.kind === 'video') {
			var video = document.createElement('video');
			video.setAttribute('controls', '');
			video.setAttribute('playsinline', '');
			video.setAttribute('preload', 'metadata');
			video.addEventListener('error', function () { if (video.isConnected) video.replaceWith(galleryImage(PLACEHOLDER, item.caption)); });
			video.src = item.src;
			shown = video;
		} else {
			shown = galleryImage(item.src, item.caption);
		}
		figure.append(shown);
		if (item.caption) figure.append(element('figcaption', '', item.caption));
		list.append(figure);
	});
	return list;
}

function fill(panel, content, media) {
	if (typeof content.diff === 'string') {
		panel.append(build({ t: 'div', k: 'diff', c: diffLines(content.diff) }));
		return;
	}
	if (Array.isArray(content.gallery)) {
		var indexes = [];
		content.gallery.forEach(function (item) { if (item && typeof item.media === 'number' && indexes.indexOf(item.media) < 0) indexes.push(item.media); });
		probeAll(indexes, media).then(function (urls) {
			if (!expired) panel.append(drawGallery(galleryItems(content.gallery, urls)));
		});
		return;
	}
	var text = typeof content.markdown === 'string' ? content.markdown : typeof content.page === 'string' ? content.page : null;
	if (text === null) {
		panel.append(element('p', 'state', labels.viewError));
		return;
	}
	// A page names its media as media:<index> in its text; a Markdown tab keeps its source and maps
	// each image destination to its index.
	var page = typeof content.page === 'string';
	var map = !page && content.media && typeof content.media === 'object' ? content.media : {};
	probeAll(page ? mediaIndexes(text) : mapIndexes(map), media).then(function (urls) {
		if (expired) return;
		if (page) {
			var frame = document.createElement('iframe');
			frame.setAttribute('sandbox', '');
			var entry = { frame: frame, page: resolveMedia(content.page, urls) };
			frames.push(entry);
			drawFrame(entry);
			panel.classList.add('page');
			panel.append(frame);
		} else {
			panel.append(build({ t: 'div', k: 'markdown', c: markdownBlocks(content.markdown) }, { urls: urls, map: map }));
		}
	});
}

function draw(answer) {
	if (expired) return;
	if (answer.expiresAt < expiresAt) { expiresAt = answer.expiresAt; arm(); }
	tabs = answer.view.tabs;
	binding = answer.choice || null;
	var parts = [];
	if (answer.view.title) {
		document.title = answer.view.title;
		parts.push(element('h1', 'title', answer.view.title));
	}
	var drawContext = function (context) { return build({ t: 'div', k: 'context', c: contextNodes(context, htmlText) }); };
	if (answer.context) {
		parts.push(drawContext(answer.context));
	} else if (ref) {
		// The view of a question that shows no context yet: its slot fills once the context shows,
		// with the binding that comes with it. Until then the main button stays hidden.
		var slot = element('div');
		slot.hidden = true;
		parts.push(slot);
		fetchContext(viewUrl, viewInit, io).then(function (late) {
			if (expired || !slot.isConnected) return;
			if (!late) return say(labels.viewLate);
			slot.replaceWith(drawContext(late.context));
			binding = late.choice || null;
			if (binding) say(binding.closed ? labels.closed : '');
			bottom();
		});
	}
	var buttons = [];
	current = Math.max(0, tabs.findIndex(function (tab) { return tab.label === wanted; }));
	var strip = element('div');
	strip.id = 'panels';
	function mark(index) {
		buttons.forEach(function (button, position) { button.setAttribute('aria-selected', String(position === index)); });
		if (buttons[index]) buttons[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
		bottom();
	}
	function select(index) {
		if (index < 0 || index >= tabs.length) return;
		strip.scrollTo({ left: index * strip.clientWidth, behavior: 'smooth' });
	}
	if (tabs.length > 1) {
		var row = element('nav');
		row.id = 'tabs';
		row.setAttribute('role', 'tablist');
		tabs.forEach(function (tab, index) {
			var button = element('button', '', tab.label);
			button.type = 'button';
			button.setAttribute('role', 'tab');
			button.addEventListener('click', function () { select(index); });
			buttons.push(button);
			row.append(button);
		});
		parts.push(row);
	}
	tabs.forEach(function (tab) {
		var panel = element('section', 'panel');
		strip.append(panel);
		fill(panel, tab.content, answer.media);
	});
	// A question answered in the view needs no hint: its bottom button names the pick, and a
	// closed one says that it is closed.
	hint = element('p', 'hint');
	parts.push(strip, hint);
	say(binding ? (binding.closed ? labels.closed : '') : labels.viewHint);
	view.replaceChildren.apply(view, parts);
	strip.scrollLeft = current * strip.clientWidth;
	mark(current);
	// A swipe scrolls the strip from panel to panel; content that scrolls sideways scrolls first.
	strip.addEventListener('scroll', function () {
		var index = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth));
		if (index !== current) { current = index; mark(index); }
	}, { passive: true });
	document.addEventListener('keydown', function (event) {
		if (event.key === 'ArrowRight') select(current + 1);
		else if (event.key === 'ArrowLeft') select(current - 1);
	});
	window.addEventListener('resize', function () { strip.scrollLeft = current * strip.clientWidth; });
}

applyTheme();
arm();
document.addEventListener('visibilitychange', check);
if (app) {
	try { app.ready(); app.expand(); } catch (error) {}
	try { app.disableVerticalSwipes(); } catch (error) {}
	invoke(main, 'onClick', function () {
		var option = chosenOption();
		if (option) choose(option);
	});
	bottom();
	app.onEvent('themeChanged', function () { applyTheme(); frames.forEach(drawFrame); });
	app.onEvent('activated', check);
}
var viewUrl = '/api/view?v=' + encodeURIComponent(viewId || '') + (ref ? '&q=' + encodeURIComponent(ref) : '');
var viewInit = { headers: { Authorization: 'tma ' + initData } };
if (!initData || !viewId) {
	state(labels.viewError);
} else {
	fetchRetry(viewUrl, viewInit, io).then(function (response) {
		if (expired) return undefined;
		if (response.status === 404) return state(labels.viewGone);
		if (response.status === 401) return state(labels.viewExpired);
		if (!response.ok) return state(labels.viewError);
		return response.json().then(draw);
	}).catch(function () {
		if (!expired) state(labels.viewError);
	});
}
`;

export const SHELL_SCRIPT = `\n(function () {\n'use strict';\n${SHELL_LIB}${SHELL_MAIN}})();\n`;

let hashed: Promise<string> | undefined;
export function shellScriptHash(): Promise<string> {
	hashed ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(SHELL_SCRIPT)).then((digest) => `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`);
	return hashed;
}

export const shellPolicy = (origin: string, hash: string) =>
	`default-src 'none'; script-src '${hash}' https://telegram.org; style-src 'unsafe-inline'; img-src data: ${origin}; media-src ${origin}; font-src data:; connect-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'`;

const dataBlock = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');

export function shellPage(options: { labels: Labels; theme?: CssVars | undefined }): string {
	const { labels } = options;
	const shown = {
		viewHint: labels.viewHint,
		viewGone: labels.viewGone,
		viewExpired: labels.viewExpired,
		viewError: labels.viewError,
		viewLate: labels.viewLate,
		choose: labels.choose,
		chosen: labels.chosen,
		closed: labels.closed,
	};
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title></title>
<style>${STYLE}</style>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body>
<main id="view"></main>
<script type="application/json" id="labels">${dataBlock(shown)}</script>
<script type="application/json" id="theme">${dataBlock(options.theme ?? {})}</script>
<script>${SHELL_SCRIPT}</script>
</body>
</html>
`;
}
