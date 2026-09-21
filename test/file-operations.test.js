import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, rename, mkdir, rmdir, readdir, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import yauzl from 'yauzl';
import { createApplication } from '../server.js';
import { initializeOwner, resetOwnerPassword } from '../lib.js';

const password = 'private file operation test password';
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'harbor-operations-'));
  await initializeOwner(dataDir, 'owner', password);
  let app, base, cookie, csrf;
  const f = { dataDir,
    async start() { app = await createApplication({ dataDir, appOrigin: 'http://localhost', nodeEnv: 'test', port: 0, maxUploadBytes: 4*1024*1024, maxStorageBytes: 16*1024*1024, logger: { error() {} }, ...overrides }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); base = `http://127.0.0.1:${app.server.address().port}`; },
    async stop() { if (app) { const running = app; app = null; await running.close(); } },
    get base() { return base; }, get cookie() { return cookie; }, get csrf() { return csrf; },
    async request(route, { method = 'GET', json, body, authenticated = true, headers = {}, signal } = {}) {
      const h = { ...(authenticated && cookie ? { Cookie: cookie } : {}), ...headers };
      if (!['GET','HEAD'].includes(method)) Object.assign(h, { Origin: 'http://localhost', 'X-CSRF-Token': csrf ?? '', 'Content-Type': route.startsWith('/api/upload') ? 'application/octet-stream' : 'application/json' });
      return fetch(base + route, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body, signal: signal ?? AbortSignal.timeout(15000) });
    },
    async login(pw = password) { const r = await f.request('/api/login', { method: 'POST', json: { username: 'owner', password: pw }, authenticated: false }); assert.equal(r.status, 200); cookie = r.headers.get('set-cookie').split(';')[0]; csrf = (await r.json()).csrfToken; },
    async folder(name, parent = 'root') { const r = await f.request('/api/folders', { method: 'POST', json: { name, parent } }); assert.equal(r.status,201,await r.clone().text()); return r.json(); },
    async file(name, bytes, parent = 'root') { const r = await f.request('/api/upload?' + new URLSearchParams({ name,parent }), { method: 'PUT',body: bytes }); assert.equal(r.status,201,await r.clone().text()); return r.json(); },
    async list(query = '') { return (await f.request('/api/files' + query)).json(); },
    async trash(ids) { return f.request('/api/files/bulk', { method: 'POST',json: { action:'trash',ids } }); },
    async bulk(action, ids, parent) { return f.request('/api/files/bulk', { method:'POST',json: { action,ids,parent } }); },
    db(work) { const db = new DatabaseSync(path.join(dataDir,'harbor.sqlite')); try { return work(db); } finally { db.close(); } },
    cleanup() { return app.cleanupTrash(); },
  };
  t.after(async()=>{ await f.stop(); await rm(dataDir,{recursive:true,force:true}); });
  await f.start(); await f.login(); return f;
}
async function jsonOk(response, status = 200) { assert.equal(response.status,status,await response.clone().text()); return response.json(); }
async function archiveEntries(buffer) {
  const zip = await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,value)=>error?reject(error):resolve(value)));
  const entries = new Map();
  await new Promise((resolve,reject)=>{ zip.on('error',reject); zip.on('end',resolve); zip.on('entry',entry=>{ if(entry.fileName.endsWith('/')){entries.set(entry.fileName,Buffer.alloc(0));zip.readEntry();return;} zip.openReadStream(entry,async(error,stream)=>{if(error){reject(error);return;}try{const chunks=[];for await(const chunk of stream)chunks.push(chunk);entries.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();}catch(error){reject(error);}});});zip.readEntry();});
  return entries;
}
async function blockNextRead(t, filePath) {
  const sample=await open(filePath,'r'), prototype=Object.getPrototypeOf(sample), original=prototype.read;await sample.close();
  let unblock, entered, blocked=false;
  const gate=new Promise(resolve=>{unblock=resolve;});const started=new Promise(resolve=>{entered=resolve;});
  t.mock.method(prototype,'read',async function(...args){if(!blocked){blocked=true;entered();await gate;}return original.apply(this,args);});
  return {started,release:unblock};
}
async function eventually(work) {
  let error;
  for(let attempt=0;attempt<100;attempt++){try{return await work();}catch(caught){error=caught;await new Promise(resolve=>setTimeout(resolve,20));}}
  throw error;
}

test('trash hides complete trees, keeps quota, normalizes overlaps and restores bytes with a collision-safe name', async t=>{
  const f=await fixture(t); const folder=await f.folder('Trips'); const nested=await f.folder('京都',folder.id); const file=await f.file('photo.txt','keep me',nested.id);
  const result=await jsonOk(await f.trash([folder.id,nested.id,file.id])); assert.equal(result.count,1);
  const normal=await f.list(); assert.equal(normal.items.length,0); assert.equal(normal.stats.usedBytes,7); assert.equal(normal.stats.trashBytes,7); assert.equal(normal.stats.trashCount,1);
  for(const suffix of ['/content','/preview','/preview.pdf']) assert.equal((await f.request(`/api/files/${file.id}${suffix}`)).status,404);
  assert.equal((await f.request('/api/files?parent='+nested.id)).status,404);
  assert.equal((await f.list('?q=photo')).items.length,0);
  assert.equal((await f.request(`/api/files/${file.id}`,{method:'PATCH',json:{name:'stolen.txt'}})).status,404);
  const bin=await (await f.request('/api/trash')).json(); assert.equal(bin.items.length,1); assert.equal(bin.items[0].originalPath,'My files / Trips'); assert.ok(bin.items[0].deletedAt);
  await f.folder('Trips');
  const restored=await jsonOk(await f.request('/api/trash/restore',{method:'POST',json:{ids:[folder.id]}}));
  assert.equal(restored.items[0].name,'Trips (restored 1)'); assert.equal(restored.items[0].id,folder.id);
  assert.equal(await (await f.request(`/api/files/${file.id}/content`)).text(),'keep me'); assert.equal((await f.list()).stats.trashBytes,0);
});

test('independently trashed descendants survive parent purge and restore to My files',async t=>{
  const f=await fixture(t);const parent=await f.folder('Parent');const child=await f.file('child.txt','child',parent.id);const other=await f.file('other.txt','other',parent.id);
  await f.trash([child.id]);await f.trash([parent.id]);
  await jsonOk(await f.request('/api/trash/purge',{method:'POST',json:{ids:[parent.id]}}));
  await assert.rejects(stat(path.join(f.dataDir,'blobs',other.id)),{code:'ENOENT'});
  assert.equal(await readFile(path.join(f.dataDir,'blobs',child.id),'utf8'),'child');
  const restored=await jsonOk(await f.request('/api/trash/restore',{method:'POST',json:{ids:[child.id]}}));assert.equal(restored.items[0].parent,'root');
  assert.equal((await f.list()).stats.usedBytes,5);
});

test('bulk validation and move conflicts have no partial effects, and moves reject cycles and excessive depth',async t=>{
  const f=await fixture(t);const a=await f.folder('A');const nested=await f.folder('Nested',a.id);const b=await f.folder('B');const one=await f.file('one.txt','one');const two=await f.file('two.txt','two');await f.file('two.txt','existing',b.id);
  assert.equal((await f.trash([one.id,randomUUID()])).status,404);assert.equal((await f.list()).items.some(row=>row.id===one.id),true);
  assert.equal((await f.bulk('move',[one.id,two.id],b.id)).status,409);assert.equal((await f.list()).items.filter(row=>[one.id,two.id].includes(row.id)).length,2);
  assert.equal((await f.bulk('move',[a.id],nested.id)).status,400);assert.equal((await f.bulk('copy',[a.id],a.id)).status,400);
  const moved=await jsonOk(await f.bulk('move',[a.id,nested.id],b.id));assert.equal(moved.count,1);assert.equal(moved.items[0].parent,b.id);
  let deepest=null; f.db(db=>{const insert=db.prepare("INSERT INTO nodes(id,parent,name,kind,mime,size,status,created_at,updated_at,storage_id) VALUES(?,?,?,'folder','',0,'ready',?,?,'original')");for(let i=0;i<64;i++){const id=randomUUID();insert.run(id,deepest,'level'+i,new Date().toISOString(),new Date().toISOString());deepest=id;}});
  assert.equal((await f.bulk('move',[a.id],deepest)).status,400);
});

test('copy publishes independent nested blobs atomically and enforces quota including trash',{timeout:10000},async t=>{
  const f=await fixture(t,{maxUploadBytes:100,maxStorageBytes:30});const source=await f.folder('Source');const child=await f.file('binary.bin',Buffer.from([0,1,2,3,4]),source.id);const destination=await f.folder('Destination');
  const copied=await jsonOk(await f.bulk('copy',[source.id,child.id],destination.id));assert.equal(copied.count,1);assert.notEqual(copied.items[0].id,source.id);
  const copiedChild=(await f.list('?parent='+copied.items[0].id)).items[0];assert.notEqual(copiedChild.id,child.id);assert.deepEqual(Buffer.from(await(await f.request(`/api/files/${copiedChild.id}/content`)).arrayBuffer()),Buffer.from([0,1,2,3,4]));
  await f.trash([source.id]);assert.equal((await f.list()).stats.usedBytes,10);
  const filler=await f.file('fill.bin',Buffer.alloc(18));await f.trash([filler.id]);
  assert.equal((await f.bulk('copy',[copied.items[0].id],'root')).status,507);
  assert.equal(f.db(db=>db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE status='pending'").get().n),0);
  await jsonOk(await f.request('/api/trash/purge',{method:'POST',json:{ids:[source.id]}}));
  assert.equal(await readFile(path.join(f.dataDir,'blobs',copiedChild.id)).then(bytes=>bytes.length),5);
});

test('failed permanent deletion remains tracked across restart and cannot restore partially purged trees',async t=>{
  const f=await fixture(t);const folder=await f.folder('To purge');const a=await f.file('a.txt','aaaa',folder.id);const b=await f.file('b.txt','bbbb',folder.id);await f.trash([folder.id]);
  const filePath=path.join(f.dataDir,'blobs',b.id),backup=filePath+'.saved';await rename(filePath,backup);await mkdir(filePath);
  assert.equal((await f.request('/api/trash/purge',{method:'POST',json:{ids:[folder.id]}})).status,503);
  assert.equal((await(await f.request('/api/trash')).json()).items[0].purging,true);
  assert.equal((await f.request('/api/trash/restore',{method:'POST',json:{ids:[folder.id]}})).status,409);
  assert.equal((await f.list()).stats.usedBytes,8,'quota stays reserved until deletion finishes');
  await rmdir(filePath);await rename(backup,filePath);await f.stop();await f.start();
  assert.equal((await(await f.request('/api/trash')).json()).items.length,0);assert.equal((await f.list()).stats.usedBytes,0);
  for(const id of [a.id,b.id])await assert.rejects(stat(path.join(f.dataDir,'blobs',id)),{code:'ENOENT'});
});

test('retention settings migrate, validate and expire only old trash; empty removes remaining trash',async t=>{
  const f=await fixture(t);const expired=await f.file('old.txt','old');const recent=await f.file('recent.txt','recent');await f.trash([expired.id,recent.id]);
  assert.equal((await(await f.request('/api/trash')).json()).retentionDays,30);
  for(const trashRetentionDays of [0,366,'10'])assert.equal((await f.request('/api/admin/settings',{method:'PATCH',json:{trashRetentionDays}})).status,400);
  await jsonOk(await f.request('/api/admin/settings',{method:'PATCH',json:{trashRetentionDays:1}}));
  f.db(db=>db.prepare('UPDATE nodes SET deleted_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',expired.id));await f.cleanup();
  assert.deepEqual((await(await f.request('/api/trash')).json()).items.map(row=>row.id),[recent.id]);
  const result=await jsonOk(await f.request('/api/trash/empty',{method:'POST',json:{}}));assert.equal(result.count,1);assert.equal((await f.list()).stats.usedBytes,0);
});

test('archive authenticates, preserves nested and empty directories and has exact GET and HEAD length',async t=>{
  const f=await fixture(t);const folder=await f.folder('旅行');const empty=await f.folder('Empty',folder.id);const child=await f.file('京都.txt','zip bytes',folder.id);
  const route='/api/archive?'+new URLSearchParams({ids:[folder.id,child.id].join(','),download:'1'});
  assert.equal((await f.request(route,{authenticated:false})).status,401);
  const response=await f.request(route);assert.equal(response.status,200,await response.clone().text());const bytes=Buffer.from(await response.arrayBuffer());assert.equal(Number(response.headers.get('content-length')),bytes.length);
  const entries=await archiveEntries(bytes);assert.ok(entries.has('旅行/'));assert.ok(entries.has('旅行/Empty/'));assert.equal(entries.get('旅行/京都.txt').toString(),'zip bytes');assert.equal(entries.size,3);
  const head=await f.request(route,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),bytes.length);assert.equal((await head.arrayBuffer()).byteLength,0);
  await f.trash([folder.id]);assert.equal((await f.request(route)).status,404);assert.equal((await f.request('/api/archive?ids='+empty.id)).status,400);
});

test('a session revoked while bulk JSON is pending cannot trash files',async t=>{
  const f=await fixture(t);const item=await f.file('private.txt','still here');const body=JSON.stringify({action:'trash',ids:[item.id]});let request;
  let connected;const connection=new Promise(resolve=>{connected=resolve;});
  const result=new Promise((resolve,reject)=>{request=http.request(f.base+'/api/files/bulk',{method:'POST',headers:{Origin:'http://localhost',Cookie:f.cookie,'X-CSRF-Token':f.csrf,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);request.on('socket',socket=>socket.once('connect',connected));request.flushHeaders();});
  t.after(()=>request.destroy());await connection;await resetOwnerPassword(f.dataDir,'a changed private test password');request.end(body);assert.equal(await result,401);
  await f.login('a changed private test password');assert.equal((await f.list()).items[0].id,item.id);
});

test('copy reserves quota and locks source ancestors and destination until publication',{timeout:10000},async t=>{
  const f=await fixture(t,{maxUploadBytes:512,maxStorageBytes:512});const ancestor=await f.folder('Ancestor'),source=await f.folder('Source',ancestor.id),destination=await f.folder('Destination');const file=await f.file('bytes.bin',Buffer.alloc(128),source.id);
  const gate=await blockNextRead(t,path.join(f.dataDir,'blobs',file.id));const copying=f.bulk('copy',[source.id],destination.id);copying.catch(()=>{});
  try {
    await gate.started;
    const settings=await(await f.request('/api/admin/settings')).json();assert.equal(settings.storage.reservedBytes,128);
    assert.equal((await f.request('/api/upload?name=over.bin&parent=root',{method:'PUT',body:Buffer.alloc(300)})).status,507);
    assert.equal((await f.request(`/api/files/${ancestor.id}`,{method:'PATCH',json:{name:'changed'}})).status,409);
    assert.equal((await f.trash([ancestor.id])).status,409);
    assert.equal((await f.request('/api/folders',{method:'POST',json:{name:'race',parent:destination.id}})).status,409);
    assert.equal((await f.request('/api/upload?'+new URLSearchParams({name:'race',parent:destination.id}),{method:'PUT',body:'race'})).status,409);
    assert.equal((await f.bulk('copy',[source.id],'root')).status,429);
    assert.equal((await f.request('/api/archive?'+new URLSearchParams({ids:source.id,download:'1'}))).status,409);
  } finally {gate.release();}
  await jsonOk(await copying);assert.equal((await(await f.request('/api/admin/settings')).json()).storage.reservedBytes,0);
  assert.equal((await f.list()).stats.usedBytes,256);
});

test('copy authorization is checked during streaming and rollback releases all files, names and quota',{timeout:10000},async t=>{
  const f=await fixture(t);const source=await f.file('bytes.bin',Buffer.alloc(128)),destination=await f.folder('Destination');
  const gate=await blockNextRead(t,path.join(f.dataDir,'blobs',source.id));const copying=f.bulk('copy',[source.id],destination.id);copying.catch(()=>{});
  try {await gate.started;await resetOwnerPassword(f.dataDir,'a replacement copy test password');}finally{gate.release();}
  assert.equal((await copying).status,401);await f.login('a replacement copy test password');
  assert.equal((await f.list('?parent='+destination.id)).items.length,0);assert.equal((await(await f.request('/api/admin/settings')).json()).storage.reservedBytes,0);
  assert.equal(f.db(db=>db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE status='pending'").get().n),0);
  assert.deepEqual((await readdir(path.join(f.dataDir,'blobs'))).filter(name=>!name.startsWith('.')),[source.id]);
  await jsonOk(await f.bulk('copy',[source.id],destination.id));
});

test('archive locks a consistent source tree and shutdown cancels work before closing the database',{timeout:10000},async t=>{
  const f=await fixture(t);const folder=await f.folder('Archive'),file=await f.file('data.txt','archive data',folder.id);
  const gate=await blockNextRead(t,path.join(f.dataDir,'blobs',file.id));
  const downloaded=f.request('/api/archive?'+new URLSearchParams({ids:folder.id,download:'1'})).then(response=>response.arrayBuffer());downloaded.catch(()=>{});
  let stopping;
  try {await gate.started;assert.equal((await f.trash([folder.id])).status,409);stopping=f.stop();}finally{gate.release();}
  await stopping;await assert.rejects(downloaded);await f.start();assert.equal((await f.list()).items[0].id,folder.id);
  assert.equal((await f.trash([folder.id])).status,200);
});

test('a canceled copy removes unpublished blobs and can be retried without a reserved name or quota',{timeout:10000},async t=>{
  const f=await fixture(t);const source=await f.file('bytes.bin',Buffer.alloc(128)),destination=await f.folder('Destination');
  const gate=await blockNextRead(t,path.join(f.dataDir,'blobs',source.id));const controller=new AbortController();
  const copying=f.request('/api/files/bulk',{method:'POST',json:{action:'copy',ids:[source.id],parent:destination.id},signal:controller.signal});copying.catch(()=>{});
  try {await gate.started;controller.abort();await assert.rejects(copying);}finally{gate.release();}
  await eventually(async()=>{assert.equal((await(await f.request('/api/admin/settings')).json()).storage.reservedBytes,0);});
  assert.equal((await f.list('?parent='+destination.id)).items.length,0);
  assert.deepEqual((await readdir(path.join(f.dataDir,'blobs'))).filter(name=>!name.startsWith('.')),[source.id]);
  await jsonOk(await f.bulk('copy',[source.id],destination.id));
});

test('startup removes interrupted copy records and UUID blobs while retaining active and trashed files',async t=>{
  const f=await fixture(t);const active=await f.file('active.txt','active'),trashed=await f.file('trashed.txt','trashed');await f.trash([trashed.id]);await f.stop();
  const folderId=randomUUID(),fileId=randomUUID(),now=new Date().toISOString();
  f.db(db=>{const insert=db.prepare("INSERT INTO nodes(id,parent,name,kind,mime,size,status,created_at,updated_at,storage_id) VALUES(?,?,?,?,?,?,'pending',?,?,'original')");insert.run(folderId,null,'interrupted','folder','',0,now,now);insert.run(fileId,folderId,'copy.txt','file','text/plain',4,now,now);});
  await writeFile(path.join(f.dataDir,'blobs',fileId),'part');await writeFile(path.join(f.dataDir,'blobs',fileId+'.part'),'part');
  await f.start();assert.equal(f.db(db=>db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE status='pending'").get().n),0);
  assert.deepEqual(new Set((await readdir(path.join(f.dataDir,'blobs'))).filter(name=>!name.startsWith('.'))),new Set([active.id,trashed.id]));
  assert.equal((await f.list()).stats.usedBytes,13);assert.equal((await(await f.request('/api/trash')).json()).items[0].id,trashed.id);
});

test('empty drains valid roots exceeding the aggregate cap and the tree cap includes its root',{timeout:30000},async t=>{
  const f=await fixture(t),now=new Date().toISOString();
  const boundary=randomUUID(),second=randomUUID(),oversized=randomUUID();
  f.db(db=>{
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert=db.prepare("INSERT INTO nodes(id,parent,name,kind,mime,size,status,created_at,updated_at,storage_id,deleted_at,trash_root) VALUES(?,?,?,'folder','',0,'ready',?,?,'original',?,?)");
      for(const [root,name,children,trashed] of [[boundary,'Boundary',9999,true],[second,'Second',1,true],[oversized,'Oversized',10000,false]]) {
        insert.run(root,null,name,now,now,trashed?now:null,trashed?1:0);
        for(let index=0;index<children;index++)insert.run(randomUUID(),root,'child-'+index,now,now,trashed?now:null,0);
      }
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK');throw error; }
  });
  assert.equal((await f.trash([oversized])).status,413,'10,001 entries in one tree exceed the limit');
  assert.equal((await f.request('/api/trash/purge',{method:'POST',json:{ids:[boundary,second]}})).status,413,'explicit bulk operations retain their aggregate bound');
  assert.equal(f.db(db=>db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE deleted_at IS NOT NULL').get().n),10002,'rejected bulk purge has no partial effects');
  const emptied=await jsonOk(await f.request('/api/trash/empty',{method:'POST',json:{}}));
  assert.equal(emptied.count,2,'one root with exactly10,000 entries and a second valid root both drain');
  assert.equal(f.db(db=>db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE deleted_at IS NOT NULL').get().n),0);
  assert.deepEqual((await f.list()).items.map(row=>row.id),[oversized],'active oversized tree remains unchanged');
});
