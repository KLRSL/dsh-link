/**
 * link-config 单测：配置文件读写的合并、原子写、容错。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { notifyEnabled, patchLinkConfig, patchLinkPeer, readLinkConfig } from '../lib/desktop/link-config.js';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass += 1; console.log('  ok  ', name); }
	else { fail += 1; console.log('  FAIL', name, extra); }
};

const dir = mkdtempSync(join(tmpdir(), 'dsh-link-cfg-'));

check('link.json 不存在 → null', readLinkConfig(dir) === null);
check('link-peer.json 不存在 → notify=false', notifyEnabled(dir) === false);

patchLinkConfig(dir, { port: 8899, addressFamily: 'ipv4', allowGlobal: false });
check('写入后能读回', readLinkConfig(dir)?.port === 8899 && readLinkConfig(dir)?.addressFamily === 'ipv4');

patchLinkConfig(dir, { port: 9000 });
const merged = readLinkConfig(dir);
check('合并写保留未传字段', merged?.port === 9000 && merged?.addressFamily === 'ipv4' && merged?.allowGlobal === false);

patchLinkPeer(dir, { notify: true });
check('notify 开关写入并读回', notifyEnabled(dir) === true);

patchLinkPeer(dir, { key: 'abc' });
const peer = JSON.parse(readFileSync(join(dir, 'link-peer.json'), 'utf8'));
check('link-peer 合并保留 notify', peer.notify === true && peer.key === 'abc');

writeFileSync(join(dir, 'link.json'), '{broken json');
check('坏 JSON → 当没有配置（不抛）', readLinkConfig(dir) === null);

console.log(`\nlink-config: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
