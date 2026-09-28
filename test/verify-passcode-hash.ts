// 调试：离线核对 .cache/deploy/passcode.hash 与 passcode.txt 是否匹配（不访问任何服务）
import { readFileSync } from 'node:fs';
import { parsePasscodeHash, verifyPasscode } from '../apps/server/src/access/passcode';

const h = parsePasscodeHash(readFileSync('.cache/deploy/passcode.hash', 'utf8').trim());
if (!h.ok) throw new Error(h.reason);
const pass = readFileSync('.cache/deploy/passcode.txt', 'utf8').split('\n')[0] ?? '';
const wrong = `${pass}x`;
console.log('match:', await verifyPasscode(pass, h.value), 'wrong-rejected:', !(await verifyPasscode(wrong, h.value)));
