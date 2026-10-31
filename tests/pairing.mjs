#!/usr/bin/env node
/**
 * pairing —— 两段式配对的协议级自测（不需要起 DSH）。
 *
 * 覆盖：发起 → 同一组数字 → 未确认 → 允许 → 已授权；以及过期与拒绝。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDeviceAuth } from '../lib/desktop/device-auth.js';

const dir = mkdtempSync(join(tmpdir(), 'dsh-link-pair-'));
let now = 1_000_000;
const auth = createDeviceAuth({ dir, now: () => now });
const key = 'k'.repeat(32);

try {
	const started = auth.requestPairing({ deviceId: 'device-001', deviceName: '手机', deviceKey: key, ip: '192.168.1.9' });
	assert.equal(started.ok, true);
	assert.match(started.code, /^\d{6}$/);

	// 未确认：手机上查到的还是 pending，同一组数字
	const seen = auth.pairingStatus({ pendingId: started.pendingId, deviceKey: key });
	assert.equal(seen.state, 'pending');
	assert.equal(seen.code, started.code);

	// 允许后：approved，白名单多一台
	const approved = auth.approvePairing({ pendingId: started.pendingId });
	assert.equal(approved.ok, true);
	assert.equal(auth.pairingStatus({ pendingId: started.pendingId, deviceKey: key }).state, 'approved');
	assert.equal(auth.devices.length, 1);
	assert.equal(auth.devices[0].id, 'device-001');

	// 别的设备拿不到状态
	assert.equal(auth.pairingStatus({ pendingId: started.pendingId, deviceKey: 'x'.repeat(32) }).error, 'forbidden');

	// 拒绝
	now += 1000;
	const second = auth.requestPairing({ deviceId: 'device-002', deviceName: '手机2', deviceKey: '2'.repeat(32) });
	auth.rejectPairing({ pendingId: second.pendingId });
	assert.equal(auth.pairingStatus({ pendingId: second.pendingId, deviceKey: '2'.repeat(32) }).state, 'rejected');
	assert.equal(auth.devices.length, 1);

	// 过期：60 秒后 pending → expired
	now += 61_000;
	const third = auth.requestPairing({ deviceId: 'device-003', deviceName: '手机3', deviceKey: '3'.repeat(32) });
	now += 61_000;
	assert.equal(auth.pairingStatus({ pendingId: third.pendingId, deviceKey: '3'.repeat(32) }).state, 'expired');

	console.log('pairing ok');
} finally {
	rmSync(dir, { recursive: true, force: true });
}
