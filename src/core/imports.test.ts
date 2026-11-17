// The pure core runs on any runtime with the Fetch API: its source imports only its own files
// and the types of @grammyjs/types, and names no Node global.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const sources = [...readdirSync(join(root, 'core')).map((name) => `core/${name}`), 'index.ts', 'store/memory.ts'].filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'));

/** Every module a source names, with whether the statement imports types only. */
function imports(source: string): { specifier: string; typeOnly: boolean }[] {
	const found: { specifier: string; typeOnly: boolean }[] = [];
	// `import x from 'm'`, `import type { X } from "m"`, `export * from 'm'`, `import 'm'`, `import("m")`, `require('m')`.
	const statements = /^\s*(import|export)\b(\s+type\b)?[^;]*?\bfrom\s*(['"])([^'"]+)\3/gms;
	const bare = [/^\s*import\s*(['"])([^'"]+)\1/gm, /\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1/g];
	for (const match of source.matchAll(statements)) found.push({ specifier: match[4] ?? '', typeOnly: match[1] === 'import' && match[2] !== undefined });
	for (const pattern of bare) for (const match of source.matchAll(pattern)) found.push({ specifier: match[2] ?? '', typeOnly: false });
	return found;
}

const allowed = ({ specifier, typeOnly }: { specifier: string; typeOnly: boolean }) => specifier.startsWith('./') || specifier.startsWith('../core/') || (specifier === '@grammyjs/types' && typeOnly);

test('the matcher finds every form of import', () => {
	const sample = [
		`import { a } from './a.ts';`,
		`import type { B } from "@grammyjs/types";`,
		`import fs from "node:fs";`,
		`import 'node:process';`,
		`import "node:crypto";`,
		`export * from 'node:path';`,
		`const x = await import("node:os");`,
		`const y = require('node:util');`,
	].join('\n');
	expect(imports(sample)).toEqual([
		{ specifier: './a.ts', typeOnly: false },
		{ specifier: '@grammyjs/types', typeOnly: true },
		{ specifier: 'node:fs', typeOnly: false },
		{ specifier: 'node:path', typeOnly: false },
		{ specifier: 'node:process', typeOnly: false },
		{ specifier: 'node:crypto', typeOnly: false },
		{ specifier: 'node:os', typeOnly: false },
		{ specifier: 'node:util', typeOnly: false },
	]);
	expect(imports(sample).filter(allowed).map((found) => found.specifier)).toEqual(['./a.ts', '@grammyjs/types']);
});

test('the core and memoryStore import nothing but their own files and grammY types', () => {
	expect(sources.length).toBeGreaterThan(8);
	for (const path of sources) {
		const source = readFileSync(join(root, path), 'utf8');
		expect(imports(source).filter((found) => !allowed(found)).map((found) => `${path}: ${found.specifier}`)).toEqual([]);
		expect(source).not.toMatch(/\b(?:process\.|Buffer\b|__dirname|import\.meta\.(?:dir|path))/);
	}
});
