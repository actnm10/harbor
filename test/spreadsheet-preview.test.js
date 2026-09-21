import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import http from 'node:http';
import { createApplication } from '../server.js';
import { initializeOwner } from '../lib.js';

const XLSX = createRequire(import.meta.url)('xlsx');
const ORIGIN = 'http://localhost';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'harbor-excel-test-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await initializeOwner(dataDir, 'excel-test-owner', 'a private spreadsheet test password');
  app = await createApplication({ dataDir, nodeEnv: 'test', appOrigin: ORIGIN, host: '127.0.0.1', port: 0,
    maxUploadBytes: 24 * 1024 * 1024, maxStorageBytes: 64 * 1024 * 1024, logger: { error() {} } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'excel-test-owner', password: 'a private spreadsheet test password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], session = await login.json();
  return {
    async upload(name, bytes) {
      const response = await fetch(base + '/api/upload?' + new URLSearchParams({ name, parent: 'root' }), {
        method: 'PUT', headers: { Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/octet-stream' }, body: bytes });
      assert.equal(response.status, 201, await response.clone().text());
      return response.json();
    },
    preview: (item, authenticated = true) => fetch(`${base}/api/files/${item.id}/preview`, { headers: authenticated ? { Cookie: cookie } : {} }),
    download: item => fetch(`${base}/api/files/${item.id}/content?download=1`, { headers: { Cookie: cookie } }),
  };
}

// Tiny ZIP writer keeps malformed fixtures synthetic and independent of SheetJS.
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), content = Buffer.from(entry.content ?? '');
    const compressed = deflateRawSync(content), flags = entry.flags ?? 0x800;
    let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const size = entry.declaredSize ?? content.length;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(flags, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(compressed.length, 18); head.writeUInt32LE(size, 22); head.writeUInt16LE(name.length, 26);
    local.push(head, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += head.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function workbook(sheets = [{ name: 'Summary', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>Ready</t></is></c></row>' }], extras = []) {
  const entries = [
    { name: '[Content_Types].xml', content: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>` },
    { name: '_rels/.rels', content: `<Relationships xmlns="${PKG}"><Relationship Id="book" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', content: `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets.map((sheet, i) => `<sheet name="${escape(sheet.name)}" sheetId="${i + 1}" r:id="sheet${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', content: `<Relationships xmlns="${PKG}">${sheets.map((_, i) => `<Relationship Id="sheet${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="strings" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { name: 'xl/sharedStrings.xml', content: `<sst xmlns="${NS}" count="1" uniqueCount="1"><si><r><t>Café </t></r><r><t>&lt;script&gt;</t></r></si></sst>` },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: `<worksheet xmlns="${NS}" xmlns:r="${REL}">${sheet.dimension ? `<dimension ref="${sheet.dimension}"/>` : ''}<sheetData>${sheet.xml}</sheetData>${sheet.tail ?? ''}</worksheet>` })),
    ...extras,
  ];
  return entries;
}

async function rejected(f, name, bytes, status = 422) {
  const item = await f.upload(name, bytes), start = Date.now();
  const response = await f.preview(item);
  assert.equal(response.status, status, `${name}: ${await response.clone().text()}`);
  assert.equal(typeof (await response.json()).error, 'string');
  assert.ok(Date.now() - start < 6000, 'malformed data should fail before the eight-second worker deadline');
}

test('Excel previews authenticate and preserve ordered sheets, sparse coordinates, rich strings and cached values', async t => {
  const f = await fixture(t);
  const bytes = zip(workbook([
    { name: 'Summary & totals', dimension: 'A1:D3', xml: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42.5</v></c><c r="D1" t="b"><v>1</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>literal &lt;img onerror=&quot;x&quot;&gt;</t></is></c><c r="C3"><f>SUM(C1,99)</f><v>7</v></c></row>' },
    { name: 'Inventory', xml: '<row r="2"><c r="B2" t="inlineStr"><is><t>Second sheet</t></is></c></row>' },
  ]));
  const item = await f.upload('REPORT.XLSX', bytes);
  assert.equal((await f.preview(item, false)).status, 401);
  const response = await f.preview(item);
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const result = await response.json();
  assert.equal(result.kind, 'spreadsheet'); assert.equal(result.label, 'Excel preview'); assert.equal(result.truncated, false);
  assert.deepEqual(result.sheets.map(sheet => sheet.name), ['Summary & totals', 'Inventory']);
  assert.deepEqual(result.sheets[0].rows, [['Café <script>', '', '42.5', 'TRUE'], ['', '', '', ''], ['literal <img onerror="x">', '', '7', '']]);
  assert.deepEqual(result.sheets[1].rows, [['', ''], ['', 'Second sheet']]);
  for (const sheet of result.sheets) { assert.equal(sheet.startRow, 1); assert.equal(sheet.startColumn, 1); }
  const download = await f.download(item);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});

test('legacy XLS previews show Unicode and formatted numbers without executing formulas', async t => {
  const f = await fixture(t), book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['Legacy café', 12.5], [], [true, 7]]);
  sheet.B1.z = '0.00'; sheet.B3.f = 'SUM(B1,99)';
  XLSX.utils.book_append_sheet(book, sheet, 'Legacy');
  const item = await f.upload('legacy.xls', XLSX.write(book, { type: 'buffer', bookType: 'xls' }));
  const response = await f.preview(item);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).sheets[0].rows, [['Legacy café', '12.50'], ['', ''], ['TRUE', '7']]);
  await rejected(f, 'not-excel.xls', Buffer.from('Name,Value\nplaintext,1'));
  await rejected(f, 'not-excel.xlsx', Buffer.from('Name,Value\nplaintext,1'));
});

test('Excel previews limit sheets, rows and columns without expanding hostile sparse dimensions', async t => {
  const f = await fixture(t);
  const sheets = Array.from({ length: 21 }, (_, i) => ({ name: `Sheet ${i + 1}`, xml: '' }));
  sheets[0] = { name: 'Bounded', dimension: 'A1:XFD1048576', xml: '<row r="1"><c r="A1"><v>1</v></c><c r="AX1"><v>50</v></c><c r="AY1"><v>51</v></c></row><row r="200"><c r="A200"><v>200</v></c></row><row r="201"><c r="A201"><v>201</v></c></row><row r="1048576"><c r="XFD1048576"><v>99</v></c></row>' };
  const item = await f.upload('bounded.xlsx', zip(workbook(sheets)));
  const response = await f.preview(item);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.truncated, true); assert.equal(result.sheets.length, 20);
  const first = result.sheets[0];
  assert.equal(first.truncated, true); assert.equal(first.rows.length, 200);
  assert.ok(first.rows.every(row => row.length === 50));
  assert.equal(first.rows[0][0], '1'); assert.equal(first.rows[0][49], '50'); assert.equal(first.rows[199][0], '200');
});

test('Excel previews bound total UTF-8 text and leave oversized downloads available', async t => {
  const f = await fixture(t);
  const value = '界'.repeat(10000);
  const xml = Array.from({ length: 20 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${value}</t></is></c></row>`).join('');
  const item = await f.upload('text-limit.xlsx', zip(workbook([{ name: 'Lots of text', xml }, { name: 'Later sheet', xml: '' }])));
  const response = await f.preview(item);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.truncated, true);
  assert.equal(result.sheets[1].name, 'Later sheet');
  const texts = result.sheets.flatMap(sheet => [sheet.name, ...sheet.rows.flat()]);
  assert.ok(texts.reduce((total, text) => total + Buffer.byteLength(text), 0) <= 512 * 1024);
  assert.ok(texts.every(text => !text.includes('\ufffd')));
  const oversized = await f.upload('too-large.xlsx', Buffer.alloc(20 * 1024 * 1024 + 1));
  assert.equal((await f.preview(oversized)).status, 413);
  assert.equal((await f.download(oversized)).status, 200);
});

test('Excel ZIP preflight rejects encrypted, duplicate, traversal, inflated and excessive-entry archives', async t => {
  const f = await fixture(t), normal = workbook();
  const cases = [
    ['encrypted', normal.map((entry, i) => i === 0 ? { ...entry, flags: 0x801 } : entry)],
    ['duplicate', [...normal, normal[2]]],
    ['traversal', [...normal, { name: '../outside.xml', content: '<root/>' }]],
    ['inflated', [...normal, { name: 'ignored.bin', content: 'tiny', declaredSize: 41 * 1024 * 1024 }]],
    ['dishonest-size', [...normal, { name: 'ignored.bin', content: 'more than one byte', declaredSize: 1 }]],
    ['xml-part-size', [...normal, { name: 'xl/too-large.xml', content: '<root/>', declaredSize: 8 * 1024 * 1024 + 1 }]],
    ['noncanonical-path', [...normal, { name: 'xl/./workbook.xml', content: '<root/>' }]],
    ['entry-count', [...normal, ...Array.from({ length: 2000 }, (_, i) => ({ name: `padding/${i}`, content: '' }))]],
  ];
  for (const [name, entries] of cases) await rejected(f, name + '.xlsx', zip(entries));
});

test('legacy Excel rejects hostile sector geometry and oversized shared-string declarations promptly', async t => {
  const f = await fixture(t), book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['A string']]), 'Sheet');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xls', bookSST: true });
  const badGeometry = Buffer.from(bytes); badGeometry.writeUInt16LE(30, 30);
  await rejected(f, 'hostile-sector.xls', badGeometry);
  const compound = XLSX.CFB.read(bytes, { type: 'buffer' });
  const data = compound.FileIndex.find(entry => entry.name === 'Workbook').content;
  let sharedStrings;
  for (let offset = 0; offset + 4 <= data.length; offset += 4 + data.readUInt16LE(offset + 2)) {
    if (data.readUInt16LE(offset) === 0x00fc) { sharedStrings = offset; break; }
  }
  assert.notEqual(sharedStrings, undefined, 'synthetic BIFF workbook must have a shared-string record');
  data.writeUInt32LE(0x7fffffff, sharedStrings + 8);
  await rejected(f, 'hostile-shared-strings.xls', XLSX.CFB.write(compound, { type: 'buffer' }));
});

test('Excel XML preflight rejects DTDs, malformed XML, excessive nesting and invalid relationship targets', async t => {
  const f = await fixture(t);
  for (const [name, content] of [
    ['doctype', '<!DOCTYPE root [<!ENTITY secret SYSTEM "file:///etc/passwd">]><root>&secret;</root>'],
    ['malformed', '<root><child></root>'],
    ['deep', '<root>'.repeat(65) + '</root>'.repeat(65)],
    ['undefined-entity', '<root>&unknown;</root>'],
  ]) await rejected(f, name + '.xlsx', zip([...workbook(), { name: 'xl/extra.xml', content }]));
  for (const target of ['../../outside.xml', 'worksheets/missing.xml']) {
    const entries = workbook();
    entries.find(entry => entry.name === 'xl/_rels/workbook.xml.rels').content = `<Relationships xmlns="${PKG}"><Relationship Id="sheet1" Type="${REL}/worksheet" Target="${target}"/></Relationships>`;
    await rejected(f, target.startsWith('..') ? 'escaping-target.xlsx' : 'missing-target.xlsx', zip(entries));
  }
  await rejected(f, 'invalid-coordinate.xlsx', zip(workbook([{ name: 'Bad', xml: '<row r="1"><c r="XFE1"><v>1</v></c></row>' }])));
});

test('Excel external hyperlinks and formula references never make network requests', async t => {
  let requests = 0;
  const canary = http.createServer((_request, response) => { requests++; response.end('must not be read'); });
  canary.listen(0, '127.0.0.1'); await once(canary, 'listening');
  t.after(() => new Promise(resolve => canary.close(resolve)));
  const url = `http://127.0.0.1:${canary.address().port}/external`, f = await fixture(t);
  const entries = workbook([{ name: 'External', xml: `<row r="1"><c r="A1" t="str"><f>WEBSERVICE(&quot;${url}&quot;)</f><v>Saved value</v></c></row>`, tail: '<hyperlinks><hyperlink ref="A1" r:id="link"/></hyperlinks>' }],
    [{ name: 'xl/worksheets/_rels/sheet1.xml.rels', content: `<Relationships xmlns="${PKG}"><Relationship Id="link" Type="${REL}/hyperlink" Target="${url}" TargetMode="External"/></Relationships>` }]);
  const response = await f.preview(await f.upload('external.xlsx', zip(entries)));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).sheets[0].rows[0][0], 'Saved value');
  assert.equal(requests, 0);
});
