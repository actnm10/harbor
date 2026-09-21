import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, openDatabase } from '../lib.js';
import { checkInstallation } from '../preflight.js';
import { createStorageManager } from '../storage.js';

const admin = fileURLToPath(new URL('../admin.js', import.meta.url));

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'harbor-preflight-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data'), storageRoot = path.join(base, 'storage');
  await mkdir(dataDir); await mkdir(storageRoot);
  const config = loadConfig({ dataDir, storageRoot, nodeEnv: 'test', appOrigin: 'http://localhost' }, {});
  return { base, dataDir, storageRoot, config };
}

function cli(config, command) {
  return spawnSync(process.execPath, [admin, command], {
    env: { ...process.env, NODE_ENV: 'test', APP_ORIGIN: config.appOrigin, DATA_DIR: config.dataDir, STORAGE_ROOT: config.storageRoot },
    encoding: 'utf8', timeout: 10000,
  });
}

test('installation checks leave stored content and identity markers untouched without creating an account database', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.storageRoot, '.harbor-location.json'), 'existing marker bytes');
  await writeFile(path.join(f.storageRoot, 'existing-file'), 'private file bytes');
  const before = await readdir(f.storageRoot);
  assert.deepEqual(checkInstallation(f.config), { dataDir: f.dataDir, storageRoot: f.storageRoot, appOrigin: f.config.appOrigin });
  assert.deepEqual(await readdir(f.storageRoot), before);
  assert.deepEqual(await readdir(f.dataDir), []);
  assert.equal(await readFile(path.join(f.storageRoot, '.harbor-location.json'), 'utf8'), 'existing marker bytes');
  assert.equal(await readFile(path.join(f.storageRoot, 'existing-file'), 'utf8'), 'private file bytes');
});

test('a missing explicit storage mount is reported without silently provisioning a replacement', async t => {
  const f = await fixture(t);
  const missing = path.join(f.base, 'unmounted', 'storage');
  assert.throws(() => checkInstallation({ ...f.config, storageRoot: missing }), /missing.*STORAGE_PATH/);
  assert.equal(existsSync(path.dirname(missing)), false);
  assert.deepEqual(await readdir(f.dataDir), []);
});

test('optional default directories are checked through their parent without creating the data tree', async t => {
  const f = await fixture(t);
  const dataDir = path.join(f.base, 'new', 'data');
  const config = loadConfig({ dataDir, nodeEnv: 'test', appOrigin: 'http://localhost' }, {});
  checkInstallation(config);
  assert.equal(existsSync(path.join(f.base, 'new')), false);
  assert.deepEqual((await readdir(f.base)).sort(), ['data', 'storage']);
});

test('installation checks reject symlink ancestors before writing through them', async t => {
  const f = await fixture(t);
  const target = path.join(f.base, 'target'), link = path.join(f.base, 'link');
  await mkdir(target);
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => checkInstallation({ ...f.config, dataDir: path.join(link, 'new-data') }), /symlink/);
  assert.deepEqual(await readdir(target), []);
});

test('installation checks reject overlapping storage paths', async t => {
  const f = await fixture(t);
  for (const storageRoot of [f.dataDir, path.join(f.dataDir, 'blobs'), path.join(f.dataDir, 'blobs', 'nested')]) {
    assert.throws(() => checkInstallation({ ...f.config, storageRoot }), /STORAGE_ROOT must be separate/);
  }
  assert.deepEqual(await readdir(f.dataDir), []);
});

test('the check command works without a terminal and does not initialize an account', async t => {
  const f = await fixture(t);
  const result = cli(f.config, 'check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check.*passed|ready|writable/i);
  assert.ok(result.stdout.includes(JSON.stringify(f.dataDir)));
  assert.ok(result.stdout.includes(JSON.stringify(f.storageRoot)));
  assert.deepEqual(await readdir(f.dataDir), []);
  assert.deepEqual(await readdir(f.storageRoot), []);
});

test('account initialization reports missing storage before prompting for credentials', async t => {
  const f = await fixture(t);
  const result = cli({ ...f.config, storageRoot: path.join(f.base, 'missing') }, 'init');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing.*STORAGE_PATH/);
  assert.doesNotMatch(result.stderr, /interactive terminal/);
  assert.doesNotMatch(result.stdout, /Owner username|Password/);
  assert.deepEqual(await readdir(f.dataDir), []);
});

const nonrootLinux = process.platform === 'linux' && process.getuid() !== 0;

test('a non-writable mount gives actionable ownership guidance before any account is created', { skip: !nonrootLinux }, async t => {
  const f = await fixture(t);
  await chmod(f.storageRoot, 0o500);
  try {
    const result = cli(f.config, 'init');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EACCES/);
    assert.match(result.stderr, /UID \d+ \/ GID \d+/);
    assert.match(result.stderr, /STORAGE_PATH/);
    assert.deepEqual(await readdir(f.dataDir), []);
    assert.deepEqual(await readdir(f.storageRoot), []);
  } finally { await chmod(f.storageRoot, 0o700); }
});

test('startup detects a mount that became read-only to the runtime user after initialization', { skip: !nonrootLinux }, async t => {
  const f = await fixture(t), db = openDatabase(f.dataDir);
  try {
    createStorageManager(db, f.config);
    const marker = await readFile(path.join(f.storageRoot, '.harbor-location.json'));
    await chmod(f.storageRoot, 0o500);
    try {
      assert.throws(() => createStorageManager(db, f.config), /EACCES.*UID.*STORAGE_PATH/);
      assert.deepEqual(await readFile(path.join(f.storageRoot, '.harbor-location.json')), marker);
      assert.deepEqual(await readdir(f.storageRoot), ['.harbor-location.json']);
    } finally { await chmod(f.storageRoot, 0o700); }
  } finally { db.close(); }
});

test('startup checks registered storage folders as well as the mount root', { skip: !nonrootLinux }, async t => {
  const f = await fixture(t), db = openDatabase(f.dataDir);
  try {
    const storage = createStorageManager(db, f.config);
    const id = storage.addLocation('Photos', () => {}), folder = storage.locationPath(id);
    const marker = await readFile(path.join(folder, '.harbor-location.json'));
    await chmod(folder, 0o500);
    try {
      assert.throws(() => createStorageManager(db, f.config), /EACCES.*STORAGE_PATH/);
      assert.deepEqual(await readFile(path.join(folder, '.harbor-location.json')), marker);
      assert.deepEqual(await readdir(folder), ['.harbor-location.json']);
    } finally { await chmod(folder, 0o700); }
  } finally { db.close(); }
});

test('unreadable identity markers and inaccessible folders report ownership rather than a missing mount', { skip: !nonrootLinux }, async t => {
  const f = await fixture(t), db = openDatabase(f.dataDir);
  try {
    const storage = createStorageManager(db, f.config);
    const original = storage.locationPath('original');
    const registered = storage.locationPath(storage.addLocation('Restricted', () => {}));
    for (const [folder, setting] of [[original, 'DATA_PATH'], [f.storageRoot, 'STORAGE_PATH'], [registered, 'STORAGE_PATH']]) {
      const marker = path.join(folder, '.harbor-location.json');
      const before = await readFile(marker);
      await chmod(marker, 0o000);
      try {
        assert.throws(() => createStorageManager(db, f.config), new RegExp(`EACCES.*UID.*${setting}`));
      } finally { await chmod(marker, 0o600); }
      assert.deepEqual(await readFile(marker), before);
    }
    await chmod(registered, 0o000);
    try {
      assert.throws(() => createStorageManager(db, f.config), /EACCES.*UID.*STORAGE_PATH/);
    } finally { await chmod(registered, 0o700); }
  } finally { db.close(); }
});
