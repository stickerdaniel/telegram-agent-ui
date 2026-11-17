// Loaded with `bun --preload` by the CLI tests, not part of the package: the bin's listener beats
// and flushes every 200 ms and sends without pacing, so a test of 5 failed deliveries takes
// seconds instead of minutes. It sets the same values the in-process tests set.
// TAU_TEST_COMMAND_DEADLINE sets the deadline of an answer or message command in ms.
import { PACING } from '../chat/calls.ts';
import { COMMANDS } from '../commands/shell.ts';
import { LISTEN } from '../telegram/listen.ts';

PACING.interval = 0;
LISTEN.beat = 200;
LISTEN.pause = 100;
const deadline = Number(process.env.TAU_TEST_COMMAND_DEADLINE);
if (Number.isSafeInteger(deadline) && deadline > 0) COMMANDS.deadline = deadline;
