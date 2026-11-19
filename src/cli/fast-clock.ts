import { PACING } from '../chat/calls.ts';
import { COMMANDS } from '../commands/shell.ts';
import { LISTEN } from '../telegram/listen.ts';
import { LANES } from '../telegram/updates.ts';

PACING.interval = 0;
LISTEN.beat = 200;
LISTEN.pause = 100;
LANES.retry.first = 100;
LANES.retry.most = 400;
const deadline = Number(process.env.TAU_TEST_COMMAND_DEADLINE);
if (Number.isSafeInteger(deadline) && deadline > 0) {
	COMMANDS.deadline = deadline;
	LANES.tap.deadline = deadline;
	LANES.other.deadline = deadline;
}
