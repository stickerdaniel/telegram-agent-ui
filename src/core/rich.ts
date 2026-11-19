import type { InputRichBlock, RichText } from '@grammyjs/types';
import { arrayOf, type Check, isBool, isInt, isNat, isRecord, isString, oneOf, optional } from './check.ts';

type Fields = Record<string, unknown>;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isTrue = (value: unknown): value is true => value === true;
const isTelegramUser = (value: unknown): value is Fields =>
	isRecord(value) &&
	isInt(value.id) &&
	isBool(value.is_bot) &&
	isString(value.first_name) &&
	optional(isString)(value.last_name) &&
	optional(isString)(value.username) &&
	optional(isString)(value.language_code) &&
	optional(isTrue)(value.is_premium) &&
	optional(isTrue)(value.added_to_attachment_menu);
const isDateTimeFormat = (value: unknown): value is string => isString(value) && /^(r|w?[dD]?[tT]?)$/.test(value);

const WRAPS: Record<string, string | undefined> = {
	bold: undefined,
	italic: undefined,
	underline: undefined,
	strikethrough: undefined,
	spoiler: undefined,
	subscript: undefined,
	superscript: undefined,
	marked: undefined,
	code: undefined,
	url: 'url',
	email_address: 'email_address',
	phone_number: 'phone_number',
	bank_card_number: 'bank_card_number',
	mention: 'username',
	hashtag: 'hashtag',
	cashtag: 'cashtag',
	bot_command: 'bot_command',
	anchor_link: 'anchor_name',
	reference: 'name',
	reference_link: 'reference_name',
};
const ACTIONS: Record<string, Check<unknown>> = {
	url: isString,
	callback_data: isString,
	web_app: (value): value is unknown => isRecord(value) && isString(value.url),
	login_url: (value): value is unknown => isRecord(value) && isString(value.url),
	switch_inline_query: isString,
	switch_inline_query_current_chat: isString,
	switch_inline_query_chosen_chat: isRecord,
	copy_text: (value): value is unknown => isRecord(value) && isString(value.text),
	disabled: isRecord,
};

const isButton = (value: unknown): value is Fields =>
	isRecord(value) && isRichText(value.text) && optional(oneOf('danger', 'success', 'primary', 'link'))(value.style) && Object.entries(ACTIONS).some(([key, check]) => Object.hasOwn(value, key) && check(value[key]));

function richNode(node: Fields): boolean {
	const { type } = node;
	if (!isString(type)) return false;
	if (Object.hasOwn(WRAPS, type)) {
		const field = WRAPS[type];
		return isRichText(node.text) && (field === undefined || isString(node[field]));
	}
	switch (type) {
		case 'date_time':
			return isRichText(node.text) && isInt(node.unix_time) && isDateTimeFormat(node.date_time_format);
		case 'text_mention':
			return isRichText(node.text) && isTelegramUser(node.user);
		case 'custom_emoji':
			return isString(node.custom_emoji_id) && isString(node.alternative_text);
		case 'mathematical_expression':
			return isString(node.expression);
		case 'anchor':
			return isString(node.name);
		case 'button':
			return isButton(node.button);
		default:
			return false;
	}
}

export function isRichText(value: unknown): value is RichText {
	if (isString(value)) return true;
	if (Array.isArray(value)) return arrayOf(isRichText)(value);
	return isRecord(value) && richNode(value);
}

const isCaption = (value: unknown): value is Fields => isRecord(value) && isRichText(value.text) && optional(isRichText)(value.credit);
const isCell = (value: unknown): value is Fields =>
	isRecord(value) &&
	optional(isRichText)(value.text) &&
	optional(isTrue)(value.is_header) &&
	optional(isNat)(value.colspan) &&
	optional(isNat)(value.rowspan) &&
	oneOf('left', 'center', 'right')(value.align) &&
	oneOf('top', 'middle', 'bottom')(value.valign);
const isItem = (value: unknown): value is Fields =>
	isRecord(value) && isBlocks(value.blocks) && optional(isTrue)(value.has_checkbox) && optional(isTrue)(value.is_checked) && optional(isInt)(value.value) && optional(oneOf('a', 'A', 'i', 'I', '1'))(value.type);
const COMMON_ENTITIES = new Set(['mention', 'hashtag', 'cashtag', 'bot_command', 'url', 'email', 'phone_number', 'bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'blockquote', 'expandable_blockquote', 'code']);

function isEntity(value: unknown): value is Fields {
	if (!isRecord(value) || !isString(value.type) || !isNat(value.offset) || !isNat(value.length)) return false;
	switch (value.type) {
		case 'pre':
			return optional(isString)(value.language);
		case 'text_link':
			return isString(value.url);
		case 'text_mention':
			return isTelegramUser(value.user);
		case 'custom_emoji':
			return isString(value.custom_emoji_id);
		case 'date_time':
			return isInt(value.unix_time) && isDateTimeFormat(value.date_time_format);
		default:
			return COMMON_ENTITIES.has(value.type);
	}
}
const MEDIA: Record<string, Record<string, Check<unknown>>> = {
	animation: { show_caption_above_media: isBool, width: isNat, height: isNat, duration: isNat, has_spoiler: isBool },
	audio: { duration: isNat, performer: isString, title: isString },
	document: { disable_content_type_detection: isBool },
	photo: { show_caption_above_media: isBool, has_spoiler: isBool },
	video: { cover: isString, start_timestamp: isNat, show_caption_above_media: isBool, width: isNat, height: isNat, duration: isNat, supports_streaming: isBool, has_spoiler: isBool },
	voice_note: { duration: isNat },
};
function isMedia(value: unknown, variant: string): value is Fields {
	const fields = Object.hasOwn(MEDIA, variant) ? MEDIA[variant] : undefined;
	if (!fields || !isRecord(value) || value.type !== variant || !isString(value.media) || Object.hasOwn(value, 'thumbnail')) return false;
	if (!optional(isString)(value.caption) || !optional(oneOf('HTML', 'Markdown', 'MarkdownV2'))(value.parse_mode) || !optional(arrayOf(isEntity))(value.caption_entities)) return false;
	return Object.entries(fields).every(([field, check]) => optional(check)(value[field]));
}

function block(node: Fields): boolean {
	const { type } = node;
	switch (type) {
		case 'paragraph':
		case 'footer':
		case 'thinking':
			return isRichText(node.text);
		case 'expandable_blockquote':
		case 'pullquote':
			return isRichText(node.text) && optional(isRichText)(node.credit);
		case 'heading':
			return isRichText(node.text) && oneOf(1, 2, 3, 4, 5, 6)(node.size);
		case 'pre':
			return isRichText(node.text) && optional(isString)(node.language);
		case 'divider':
			return true;
		case 'mathematical_expression':
			return isString(node.expression);
		case 'anchor':
			return isString(node.name);
		case 'list':
			return Array.isArray(node.items) && node.items.every((item: unknown) => isItem(item));
		case 'blockquote':
			return isBlocks(node.blocks) && optional(isRichText)(node.credit);
		case 'collage':
		case 'slideshow':
			return isBlocks(node.blocks) && optional(isCaption)(node.caption);
		case 'table':
			return (
				Array.isArray(node.cells) &&
				node.cells.every((row: unknown) => Array.isArray(row) && row.every((cell: unknown) => isCell(cell))) &&
				optional(isTrue)(node.is_bordered) &&
				optional(isTrue)(node.is_striped) &&
				optional(isTrue)(node.is_compact) &&
				optional(isRichText)(node.caption)
			);
		case 'details':
			return isRichText(node.summary) && isBlocks(node.blocks) && optional(isTrue)(node.is_open);
		case 'map':
			return isRecord(node.location) && isNumber(node.location.latitude) && isNumber(node.location.longitude) && isNumber(node.zoom) && isNumber(node.width) && isNumber(node.height) && optional(isCaption)(node.caption);
		case 'buttons':
			return Array.isArray(node.buttons) && node.buttons.every((button: unknown) => isButton(button)) && optional(oneOf('left', 'center', 'right'))(node.align);
		default:
			return isString(type) && isMedia(node[type], type) && optional(isCaption)(node.caption);
	}
}

export const isRichBlock = (value: unknown): value is InputRichBlock<never> => isRecord(value) && block(value);

export function isBlocks(value: unknown): value is InputRichBlock<never>[] {
	return arrayOf(isRichBlock)(value);
}
