// The command table of section 5 for Node and Bun: every command with its input schema and
// its handler, the session it runs on, and the mapping of its result to output and exit code.
// The CLI reads it, and so will the MCP server.
export { type Config, parseConfig, paths } from './config.ts';
export { describeType, type InputOf, inputIssue, kebab, type Param, usage } from './params.ts';
export { EXIT, exitCode, type Failure, failureOf, printed, type RefusedCode, type Result } from './result.ts';
export { type Context, FAKE_SCENARIOS, openSession, type Session } from './session.ts';
export { type Command, commands, findCommand } from './table.ts';
