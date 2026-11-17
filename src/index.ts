// The pure core: types, builders and the functions a consumer composes into its own loop.
// It imports no Node API and makes no request.
export { choice, type ChoiceExtras, type Extras, message, text, yesNo } from './core/builders.ts';
export { classify } from './core/classify.ts';
export { mergeLabels } from './core/labels.ts';
export { parseQuestion } from './core/parse.ts';
export { locate, reduce } from './core/reduce.ts';
export { render, renderEdit } from './core/render.ts';
export {
	type Answer,
	type AnswerSpec,
	type Attachment,
	type Body,
	type Call,
	type CallClass,
	type CallResponse,
	defaultLabels,
	type Handled,
	type Json,
	type Labels,
	LockTimeout,
	type Option,
	type Question,
	type QuestionEvent,
	type Sent,
	ShapeError,
	type Spec,
	type Step,
	type Store,
	type Update,
	type User,
	type Warning,
} from './core/types.ts';
