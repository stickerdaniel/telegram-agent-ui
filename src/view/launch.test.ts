import { expect, test } from 'bun:test';
import { BOT, launchKey, USER } from './fixtures.ts';
import { verifyLaunchData } from './launch.ts';

const { hex, launch } = await launchKey();
const now = Date.now();
const seconds = Math.floor(now / 1000);
const verify = (initData: string, allowedUsers = [USER]) => verifyLaunchData(initData, { botId: BOT, publicKey: hex, allowedUsers, now });

test('valid launch data returns its user with first and last name', async () => {
	expect(await verify(await launch())).toEqual({ ok: true, user: { id: USER, name: 'Dana S' } });
});

test('auth_date may be 600 s old and 60 s ahead, and no more', async () => {
	expect((await verify(await launch({ authDate: seconds - 600 }))).ok).toBe(true);
	expect((await verify(await launch({ authDate: seconds + 60 }))).ok).toBe(true);
	expect(await verify(await launch({ authDate: seconds - 601 }))).toEqual({ ok: false, reason: 'auth_date is 601 s old' });
	expect(await verify(await launch({ authDate: seconds + 61 }))).toEqual({ ok: false, reason: 'auth_date is 61 s ahead' });
});

test('a user outside the allowed users, a changed field, a repeated field and a missing signature fail', async () => {
	const initData = await launch();
	expect(await verify(initData, [112])).toEqual({ ok: false, reason: 'user is not an allowed user' });
	expect(await verify(initData.replace('chat_type=private', 'chat_type=group'))).toEqual({ ok: false, reason: 'bad signature' });
	expect(await verify(`${initData}&chat_type=private`)).toEqual({ ok: false, reason: 'duplicate field chat_type' });
	expect(await verify(initData.replace(/&signature=[^&]+/, ''))).toEqual({ ok: false, reason: 'missing signature' });
	expect(await verifyLaunchData(initData, { botId: '223', publicKey: hex, allowedUsers: [USER], now })).toEqual({ ok: false, reason: 'bad signature' });
	expect(await verifyLaunchData(initData, { botId: BOT, allowedUsers: [USER], now })).toEqual({ ok: false, reason: 'bad signature' });
});
