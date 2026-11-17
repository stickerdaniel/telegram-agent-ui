// Labels are plain text of 1 to 200 characters, not all white space. `mergeLabels` checks them once when a
// consumer's labels meet the defaults; `render`, `renderEdit` and `reduce` check the labels
// they are given with `checkLabels` too, since a Labels value can also be built by hand.
import { arrayOf, isRecord, isString } from './check.ts';
import { defaultLabels, type Labels, ShapeError } from './types.ts';

export const LABEL_LENGTH = [1, 200] as const;

// 1 to 200 characters, at least one of them not white space: a body made of the label is never empty.
const fits = (text: unknown): text is string => isString(text) && text.length >= LABEL_LENGTH[0] && text.length <= LABEL_LENGTH[1] && text.trim() !== '';

/** Why `labels` are refused, or undefined: each text and each hint word has 1 to 200 characters, not all white space. */
export function labelIssue(labels: unknown): string | undefined {
	if (!isRecord(labels)) return 'labels are not an object';
	for (const key of Object.keys(defaultLabels) as (keyof Labels)[]) {
		const value = labels[key];
		if (key === 'hintWords') {
			if (!arrayOf(fits)(value)) return `every hint word needs ${LABEL_LENGTH[0]} to ${LABEL_LENGTH[1]} characters, not all white space`;
		} else if (!fits(value)) return `the label ${key} needs ${LABEL_LENGTH[0]} to ${LABEL_LENGTH[1]} characters of plain text, not all white space`;
	}
	return undefined;
}

/** Throws ShapeError for labels that break `labelIssue`. */
export function checkLabels(labels: Labels): Labels {
	const issue = labelIssue(labels);
	if (issue) throw new ShapeError(issue);
	return labels;
}

/**
 * A consumer's labels over the English defaults, checked once, with a hint word list of its
 * own. Throws ShapeError for a label outside 1 to 200 characters or of white space only.
 *
 *   const labels = mergeLabels({ yes: 'Ja', no: 'Nein', closed: 'Diese Frage ist geschlossen' });
 */
export function mergeLabels(labels: Partial<Labels> = {}): Labels {
	return checkLabels({ ...defaultLabels, ...labels, hintWords: [...(labels.hintWords ?? defaultLabels.hintWords)] });
}
