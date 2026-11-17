// A second process for the fileStore tests: `bun lock-child.ts <dir> <key> hold|kill|gate|for [arg]`.
// `hold` takes the lock, prints "locked" and keeps it for 60 s. `kill` takes the lock and dies by
// SIGKILL inside it, as a crashed holder does. `gate` takes the lock, prints "locked" and keeps it
// until the gate file `arg` exists. `for` takes the lock, prints "locked" and keeps it for `arg`
// ms. Each prints "released" once it let go. A lock that is refused prints "error <name>" and
// exits 2.
import { existsSync } from 'node:fs';
import { fileStore } from './file.ts';

const [dir, key, mode, arg] = process.argv.slice(2);
const MODES = ['hold', 'kill', 'gate', 'for'] as const;
const known = MODES.find((name) => name === mode);
if (!dir || !key || !known || ((known === 'gate' || known === 'for') && !arg)) throw new Error('usage: lock-child.ts <dir> <key> hold|kill|gate|for [arg]');
try {
	await fileStore(dir).lock(key, async () => {
		if (known === 'kill') process.kill(process.pid, 'SIGKILL');
		console.log('locked');
		if (known === 'hold') await Bun.sleep(60_000);
		if (known === 'for') await Bun.sleep(Number(arg));
		while (known === 'gate' && arg && !existsSync(arg)) await Bun.sleep(5);
	});
	console.log('released');
} catch (error) {
	console.log(`error ${error instanceof Error ? error.name : String(error)}`);
	process.exit(2);
}
