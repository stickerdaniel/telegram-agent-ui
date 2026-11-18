// What a command returns and how it ends: one JSON object, and an exit code from the table of
// section 5. A failure is `{ error, code?, message, ref?, id? }`. Every refusal names its code.
import { LockTimeout, type Outcome, ShapeError, TokenRefused } from '../core/types.ts';
import type { Stopped } from '../telegram/listen.ts';

/**
 * The codes of a refusal: those of `createChat`, plus those of pairing, of an edit by ref, of
 * `mcp init`, of `view deploy`, and of the view host: `view-host` for a request it refused,
 * `unknown-view` for a view it does not hold.
 */
export type RefusedCode = Extract<Outcome, { kind: 'refused' }>['code'] | 'webhook' | 'conflict' | 'not-paired' | 'unconfirmed-message' | 'client-config' | 'wrangler' | 'view-host' | 'unknown-view';

export type Failure =
	| { error: 'refused'; code: RefusedCode; message: string; ref?: string }
	| { error: 'usage'; message: string }
	| { error: 'no-listener'; message: string }
	| { error: 'uncertain'; message: string; ref?: string; id?: string }
	| { error: 'stopped'; code: Exclude<Stopped['reason'], 'signal'>; message: string }
	| { error: 'no-config'; message: string }
	| { error: 'no-view-host'; message: string };

/** A command's end: its output, or its failure. */
export type Result = { ok: true; output: Record<string, unknown> } | { ok: false; failure: Failure };

/** The exit code of each failure, see section 5. Success is 0. */
export const EXIT = { refused: 1, usage: 2, 'no-listener': 3, uncertain: 4, stopped: 5, 'no-config': 6, 'no-view-host': 7 } as const satisfies Record<Failure['error'], number>;

export const done = (output: Record<string, unknown>): Result => ({ ok: true, output });
export const failed = (failure: Failure): Result => ({ ok: false, failure });

/** A failure thrown from deep inside a command, such as a missing config. */
export class Failed extends Error {
	override name = 'Failed';
	constructor(readonly failure: Failure) {
		super(failure.message);
	}
}

/** The exit code of a result. */
export const exitCode = (result: Result) => (result.ok ? 0 : EXIT[result.failure.error]);

/** What a command prints: its output, or the failure. */
export const printed = (result: Result): Record<string, unknown> => (result.ok ? result.output : result.failure);

/**
 * A thrown error as a failure. A rejected token is a config to fix, a shape error and a lock
 * held elsewhere refuse, and anything else may have happened after a request went out.
 */
export function failureOf(error: unknown): Failure {
	if (error instanceof Failed) return error.failure;
	if (error instanceof TokenRefused) return { error: 'no-config', message: `${error.message}. Run init with a new token` };
	if (error instanceof ShapeError) return { error: 'refused', code: 'shape', message: error.message };
	if (error instanceof LockTimeout) return { error: 'refused', code: 'busy', message: `${error.message}. Nothing changed, try again` };
	const message = error instanceof Error ? error.message : String(error);
	return { error: 'uncertain', message: `${message}. A request may have gone out: run info to see the stored state` };
}

/**
 * An outcome of `createChat` as a result: `ok` and `dry` through `output`, a refusal with its
 * code (`no-listener`, a rejected token and `view-host` have exit codes of their own), and
 * `uncertain` and `partial` as uncertain with the way out.
 */
export function fromOutcome(outcome: Outcome, output: (outcome: Extract<Outcome, { kind: 'ok' | 'dry' }>) => Record<string, unknown>): Result {
	switch (outcome.kind) {
		case 'ok':
		case 'dry':
			return done(output(outcome));
		case 'refused':
			if (outcome.code === 'no-listener') return failed({ error: 'no-listener', message: `${outcome.reason}. Nothing was sent: start telegram-agent-ui listen` });
			if (outcome.code === 'token') return failed({ error: 'no-config', message: `the server refused the bot token: ${outcome.reason}. Run init with a new token` });
			if (outcome.code === 'view-host') return failed({ error: 'no-view-host', message: `${outcome.reason}. Nothing was sent` });
			return failed({ error: 'refused', code: outcome.code, message: outcome.reason });
		case 'uncertain':
			return failed({ error: 'uncertain', message: outcome.reason, ...(outcome.ref !== undefined ? { ref: outcome.ref } : {}) });
		case 'partial':
			return failed({
				error: 'uncertain',
				message: `the body arrived as message ${outcome.sent.message}, files step ${outcome.failed.step} did not (${outcome.failed.class}: ${outcome.failed.reason}): send the missing files as a new message`,
				...(outcome.ref !== undefined ? { ref: outcome.ref } : {}),
			});
	}
}
