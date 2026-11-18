// The command table of section 5 for Node and Bun: every command with its input schema and
// its handler, the session it runs on, and the mapping of its result to output and exit code.
// The CLI and the MCP server of `./mcp` both read it.
export { type Config, type Env, parseConfig, paths } from './config.ts';
export { MCP_CLIENTS, type McpClient, mcpInit, mcpTarget } from './mcp-init.ts';
export { describeType, type InputOf, inputIssue, kebab, type Param, usage } from './params.ts';
export { EXIT, exitCode, type Failure, failureOf, printed, type RefusedCode, type Result } from './result.ts';
export { type Context, FAKE_SCENARIOS, openSession, readBodyFile, rootsOf, type Session } from './session.ts';
export { type Command, commands, findCommand } from './table.ts';
