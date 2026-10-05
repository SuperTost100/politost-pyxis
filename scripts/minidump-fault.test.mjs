import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('identifies an unloaded fault target and prints metadata without dump memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pyxis-dump-'));
  try {
    const b = Buffer.alloc(2048);
    const u32 = (at, n) => b.writeUInt32LE(n, at);
    const u64 = (at, n) => b.writeBigUInt64LE(BigInt(n), at);
    const name = (at, text) => {
      const bytes = Buffer.from(text, 'utf16le');
      u32(at, bytes.length);
      bytes.copy(b, at + 4);
    };
    u32(0, 0x504d444d);
    u32(8, 5);
    u32(12, 32);
    const streams = [[6, 168, 128], [14, 36, 300], [17, 76, 400], [16, 64, 500], [24, 16, 600]];
    streams.forEach(([type, size, rva], i) => {
      u32(32 + i * 12, type); u32(36 + i * 12, size); u32(40 + i * 12, rva);
    });
    u32(128, 7); u32(136, 0xc0000005); u64(152, 0x1010);
    u32(160, 2); u64(168, 8); u64(176, 0x1010);
    u32(300, 12); u32(304, 24); u32(308, 1);
    u64(312, 0x1000); u32(320, 0x1000); u32(332, 1080);
    u32(400, 12); u32(404, 64); u32(408, 1); u32(412, 7); u64(460, 0x1010);
    u32(500, 16); u32(504, 48); u64(508, 1);
    u64(516, 0x1000); u64(540, 0x1000); u32(548, 0x10000);
    u32(600, 1); u32(604, 7); u64(608, 1024);
    name(1024, 'napi-worker'); name(1080, 'C:\\fixture\\retired.dll');
    b.write('DUMP_MEMORY_MUST_NOT_BE_PRINTED', 1500);
    const file = join(dir, 'fixture.dmp');
    writeFileSync(file, b);
    const result = spawnSync(process.execPath, ['scripts/minidump-fault.mjs', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /faulting thread name: napi-worker/);
    assert.match(result.stdout, /thread start: 0x1010/);
    assert.match(result.stdout, /unloaded retired\.dll: 0x1000\.\.0x2000 CONTAINS FAULT ADDRESS/);
    assert.match(result.stdout, /state 0x10000/);
    assert.doesNotMatch(result.stdout, /DUMP_MEMORY_MUST_NOT_BE_PRINTED|fixture\\/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
