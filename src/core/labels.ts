import { arrayOf, isRecord, isString } from './check.ts';
import { defaultLabels, type Labels, ShapeError } from './types.ts';

export const LABEL_LENGTH = [1, 200] as const;

const fits = (text: unknown): text is string => isString(text) && text.length >= LABEL_LENGTH[0] && text.length <= LABEL_LENGTH[1] && text.trim() !== '';

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

export function parseLabels(value: unknown): Partial<Labels> | undefined {
	if (!isRecord(value) || Object.keys(value).some((key) => !(key in defaultLabels))) return undefined;
	if (labelIssue({ ...defaultLabels, ...value }) !== undefined) return undefined;
	const labels: Partial<Labels> = {};
	for (const key of Object.keys(defaultLabels) as (keyof Labels)[]) {
		const label = value[key];
		if (key === 'hintWords') {
			if (arrayOf(isString)(label)) labels.hintWords = [...label];
		} else if (isString(label)) labels[key] = label;
	}
	return labels;
}

export function checkLabels(labels: Labels): Labels {
	const issue = labelIssue(labels);
	if (issue) throw new ShapeError(issue);
	return labels;
}

export function mergeLabels(labels: Partial<Labels> = {}): Labels {
	return checkLabels({ ...defaultLabels, ...labels, hintWords: [...(labels.hintWords ?? defaultLabels.hintWords)] });
}
