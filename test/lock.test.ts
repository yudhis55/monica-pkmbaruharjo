import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../src/core/db/store.ts';

const fresh = () => Store.open({ sqlitePath: join(mkdtempSync(join(tmpdir(), 'monev-lock-')), 'l.db') });

test('sweep kedua ditolak selama pemilik pertama hidup', async () => {
  // Butuh pid yang benar-benar hidup tetapi berbeda dari proses test ini.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const path = join(mkdtempSync(join(tmpdir(), 'monev-lock-')), 'l.db');
    const a = await Store.open({ sqlitePath: path });
    assert.equal(await a.claimSync(`web:${child.pid}`), true);
    const b = await Store.open({ sqlitePath: path });
    assert.equal(await b.claimSync(`cli:${process.pid}`), false);
    await a.close(); await b.close();
  } finally {
    child.kill();
  }
});

test('kunci pemilik yang sudah mati diambil alih', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'monev-lock-')), 'l.db');
  const a = await Store.open({ sqlitePath: path });
  // pid 999999 hampir pasti tidak ada; host sama supaya pemeriksaan liveness berlaku.
  assert.equal(await a.claimSync('cli:999999'), true);
  const b = await Store.open({ sqlitePath: path });
  assert.equal(await b.claimSync(`web:${process.pid}`), true);
  await a.close(); await b.close();
});

test('lease yang habis bisa diambil alih (pengganti "kunci basi")', async () => {
  // Model baru memakai lease, bukan umur lock: lease 0 = langsung kedaluwarsa.
  const a = await fresh();
  assert.equal(await a.claimSync(`cli:${process.pid}`, 0), true);
  assert.equal(await a.claimSync(`web:${process.pid + 1}`), true);
  await a.close();
});

test('lease dapat diperpanjang tanpa kehilangan kunci', async () => {
  const a = await fresh();
  const owner = `cli:${process.pid}:abc`;
  assert.equal(await a.claimSync(owner, 1), true);
  assert.equal(await a.renewSync(owner), true);
  // Perpanjangan hanya berlaku untuk pemilik yang sama.
  assert.equal(await a.renewSync('cli:999999:zzz'), false);
  await a.close();
});

test('lease 0 milik proses lain tidak menahan pemilik baru', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'monev-lock-')), 'l.db');
  const a = await Store.open({ sqlitePath: path });
  assert.equal(await a.claimSync('web:1:aaa', 0), true);
  const b = await Store.open({ sqlitePath: path });
  assert.equal(await b.claimSync('web:2:bbb'), true);
  await a.close(); await b.close();
});

test('captcha sekali pakai: pengambilan kedua tidak menemukan state', async () => {
  const store = await fresh();
  await store.saveCaptcha('cap-1', 'asik_web_stk=x; asik_web_ctk=y');
  const first = await store.takeCaptcha('cap-1');
  assert.equal(first?.jar, 'asik_web_stk=x; asik_web_ctk=y');
  assert.equal(await store.takeCaptcha('cap-1'), null);
  await store.close();
});

test('pengaturan tersimpan dan bisa dibaca ulang', async () => {
  const store = await fresh();
  assert.equal(await store.getSetting('sweep.start'), null);
  await store.setSetting('sweep.start', '2026-01-01');
  await store.setSetting('sweep.end', '2026-12-31');
  assert.equal(await store.getSetting('sweep.start'), '2026-01-01');
  assert.equal(await store.getSetting('sweep.end'), '2026-12-31');
  await store.close();
});

test('release membebaskan kunci', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'monev-lock-')), 'l.db');
  const a = await Store.open({ sqlitePath: path });
  assert.equal(await a.claimSync(`web:${process.pid}`), true);
  await a.releaseSync(`web:${process.pid}`);
  const b = await Store.open({ sqlitePath: path });
  assert.equal(await b.claimSync(`cli:${process.pid + 1}`), true);
  await a.close(); await b.close();
});

test('recoverInterrupted menutup run yang tertinggal', async () => {
  const store = await fresh();
  const id = await store.startRun();
  assert.equal(await store.recoverInterrupted(), 1);
  const run = await store.lastRun();
  assert.equal(run?.id, id);
  assert.equal(run?.status, 'interrupted');
  assert.ok(run?.finished_at);
  await store.close();
});

test('galat sesi tersimpan dan bisa dibersihkan', async () => {
  const store = await fresh();
  assert.equal(await store.sessionError(), null);
  await store.setSessionError('Akun Anda sedang digunakan oleh perangkat lain.');
  assert.equal((await store.sessionError())?.message, 'Akun Anda sedang digunakan oleh perangkat lain.');
  await store.setSessionError('pesan baru');
  assert.equal((await store.sessionError())?.message, 'pesan baru');
  await store.clearSessionError();
  assert.equal(await store.sessionError(), null);
  await store.close();
});