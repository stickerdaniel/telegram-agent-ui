#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';

const dir = process.env.WRANGLER_STANDIN_DIR ?? '.';
const args = process.argv.slice(2);
const option = (name: string) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};
const config = option('--config');
const secrets = option('--secrets-file');
appendFileSync(
	join(dir, 'calls.jsonl'),
	`${JSON.stringify({
		args,
		account: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
		botToken: process.env.TELEGRAM_BOT_TOKEN !== undefined,
		...(config ? { config: readFileSync(config, 'utf8') } : {}),
		...(secrets ? { secrets: JSON.parse(readFileSync(secrets, 'utf8')) } : {}),
	})}\n`,
);

const state = join(dir, 'namespaces.json');
type Namespace = { id: string; title: string; supports_url_encoding: boolean };
const namespaces: Namespace[] = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : [];
const fail = (message: string) => {
	process.stderr.write(`\n✘ [ERROR] ${message}\n\n`);
	process.exit(1);
};
const banner = '\n ⛅️ wrangler 4.164.0\n───────────────────\n';
const step = args.slice(0, 3).join(' ');

if (step === 'kv namespace list') {
	if (process.env.WRANGLER_STANDIN_FAIL === 'list') fail('Not logged in. Run `wrangler login` first.');
	process.stdout.write(`${JSON.stringify(namespaces, null, '  ')}\n`);
} else if (step === 'kv namespace create') {
	const title = args[3] ?? '';
	if (process.env.WRANGLER_STANDIN_FAIL === 'create') fail('A request to the Cloudflare API failed.');
	if (namespaces.some((namespace) => namespace.title === title)) fail(`A KV namespace with the title "${title}" already exists.\n\nYou can list existing namespaces with their IDs by running:\n  wrangler kv namespace list\n\nOr choose a different namespace name.`);
	const id = `${namespaces.length + 1}`.padStart(32, '0');
	namespaces.push({ id, title, supports_url_encoding: true });
	writeFileSync(state, JSON.stringify(namespaces));
	const binding = title.replace(/[\s-]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
	process.stdout.write(
		`${banner}Resource location: remote \n\n🌀 Creating namespace with title "${title}"\n✨ Success!\nTo access your new KV Namespace in your Worker, add the following snippet to your configuration file:\n[[kv_namespaces]]\nbinding = "${binding}"\nid = "${id}"\n`,
	);
} else if (args[0] === 'deploy' && config) {
	if (process.env.WRANGLER_STANDIN_FAIL === 'deploy') {
		process.stdout.write(`${banner}Total Upload: 61.32 KiB / gzip: 15.20 KiB\n`);
		fail('A request to the Cloudflare API (/accounts/x/workers/scripts/x) failed.');
	}
	const toml = parse(readFileSync(config, 'utf8'));
	const name = String(toml.name);
	const routes = Array.isArray(toml.routes) ? toml.routes.map(String) : [];
	const targets = [...(toml.workers_dev === true ? [`https://${name}.dana.workers.dev`] : []), ...routes];
	process.stdout.write(
		`${banner}Total Upload: 61.32 KiB / gzip: 15.20 KiB\nUploaded ${name} (2.31 sec)\nDeployed ${name} triggers (0.42 sec)\n${targets.map((target) => `  ${target}\n`).join('')}Current Version ID: 3c1f0d4e-8a3b-4b8e-9d1f-2a7c5e6b9f10\n`,
	);
} else {
	fail(`the stand-in has no answer for wrangler ${args.join(' ')}`);
}
