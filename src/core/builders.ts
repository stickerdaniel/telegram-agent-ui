// Builders return plain specs, so a spec stays JSON whether a builder made it or not.
import { type Body, defaultLabels, type Labels, type Option, type Spec } from './types.ts';

/** What every message may carry besides its body and answer. */
export type Extras = Omit<Spec, 'body' | 'answer'>;
export type ChoiceExtras = Extras & { layout?: 'rows' | 'row'; once?: boolean };

/** A message that asks nothing: `message({ markdown: 'Build passed.' })`. */
export function message(body: Body, extras: Extras = {}): Spec {
	return { body, ...extras };
}

/** A question answered by a tap on one of 2 to 8 options. */
export function choice(body: Body, options: Option[], extras: ChoiceExtras = {}): Spec & { answer: { type: 'choice' } } {
	const { layout, once, ...rest } = extras;
	return { body, ...rest, answer: { type: 'choice', options, ...(layout ? { layout } : {}), ...(once !== undefined ? { once } : {}) } };
}

/** A choice of `labels.yes` and `labels.no` in one row, with the values `yes` and `no`. */
export function yesNo(body: Body, extras: Omit<ChoiceExtras, 'layout'> & { labels?: Pick<Labels, 'yes' | 'no'> } = {}): Spec & { answer: { type: 'choice' } } {
	const { labels = defaultLabels, ...rest } = extras;
	return choice(
		body,
		[
			{ label: labels.yes, value: 'yes' },
			{ label: labels.no, value: 'no' },
		],
		{ ...rest, layout: 'row' },
	);
}

/** A question answered by a reply. */
export function text(body: Body, extras: Extras & { once?: boolean } = {}): Spec & { answer: { type: 'text' } } {
	const { once, ...rest } = extras;
	return { body, ...rest, answer: { type: 'text', ...(once !== undefined ? { once } : {}) } };
}
