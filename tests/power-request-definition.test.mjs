import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../SystemSleepGuard.cs',import.meta.url),'utf8');

test('power request uses SYSTEM_REQUIRED and a native-sized explicit union',()=>{
 assert.match(source,/SystemRequired\s*=\s*1/);
 assert.match(source,/PowerSetRequest\(requestHandle, PowerRequestType\.SystemRequired\)/);
 assert.match(source,/PowerClearRequest\(requestHandle, PowerRequestType\.SystemRequired\)/);
 assert.match(source,/StructLayout\(LayoutKind\.Explicit\)[\s\S]*DetailedReasonContext[\s\S]*SimpleReasonString/);
 assert.match(source,/SafeFileHandle\? _requestHandle/);
 assert.match(source,/IntPtr\.Size == 8 \? 32 : 24/);
});
