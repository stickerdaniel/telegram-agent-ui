import { type Body, defaultLabels, type Labels, type Option, type Spec } from './types.ts';

export type Extras = Omit<Spec, 'body' | 'answer'>;
export type ChoiceExtras = Extras & { layout?: 'rows' | 'row'; once?: boolean; in?: 'chat' | 'view' };

export function message(body: Body, extras: Extras = {}): Spec {
	return { body, ...extras };
}

export function choice(body: Body, options: Option[], extras: ChoiceExtras = {}): Spec & { answer: { type: 'choice' } } {
	const { layout, once, in: where, ...rest } = extras;
	return { body, ...rest, answer: { type: 'choice', options, ...(layout ? { layout } : {}), ...(once !== undefined ? { once } : {}), ...(where !== undefined ? { in: where } : {}) } };
}

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

export function text(body: Body, extras: Extras & { once?: boolean } = {}): Spec & { answer: { type: 'text' } } {
	const { once, ...rest } = extras;
	return { body, ...rest, answer: { type: 'text', ...(once !== undefined ? { once } : {}) } };
}
