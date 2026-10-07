const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.slice(html.indexOf('function openSyncCache('), html.indexOf('function teardownRemoteRealtime('));
const hashSource = html.slice(html.indexOf('function hashState('), html.indexOf('function saveLocalSnapshot('));
const bootstrapSource = html.slice(html.indexOf('async function completeAuthenticatedBootstrap('), html.indexOf('async function bootstrapSession('));
const realtimeSource = html.slice(html.indexOf('function setupRemoteRealtime('), html.indexOf('async function setupRemoteSync('));

function fakeIndexedDB() {
  const records = new Map();
  const db = {
    createObjectStore:()=>{},
    transaction:()=> {
      const transaction = {objectStore:()=>({
        get:key=> {
          const request = {};
          queueMicrotask(()=>{request.result=records.get(key); request.onsuccess();});
          return request;
        },
        put:(record,key)=>queueMicrotask(()=>{
          records.set(key, JSON.parse(JSON.stringify(record)));
          transaction.oncomplete();
        })
      })};
      return transaction;
    }
  };
  return {open:()=>{
    const request = {result:db};
    queueMicrotask(()=>{request.onupgradeneeded(); request.onsuccess();});
    return request;
  }};
}

function fixture() {
  const storage = new Map();
  const context = {
    remoteSync:{enabled:true, loaded:true, lastHash:'', pending:false, revision:0, pushPromise:null, localSnapshotOk:true, localStorageSnapshotOk:true},
    window:{indexedDB:fakeIndexedDB()},
    authState:{session:{user:{id:'user'}}}, remoteCfg:{syncTable:'app_state'},
    localStorage:{setItem:(k,v)=>storage.set(k,v), getItem:k=>storage.get(k), removeItem:k=>storage.delete(k)},
    hashState:JSON.stringify, serializeRemoteState:()=>context.payload,
    getCurrentWorkspaceId:()=> 'workspace', setSyncStatus:label=>context.status=label,
    applyState:()=> { throw new Error('Pending local state must not be overwritten'); },
    console:{error:()=>{}}, payload:{gare:[{id:1}], attivitaGare:[]}
  };
  vm.createContext(context);
  vm.runInContext(hashSource, context);
  vm.runInContext(source, context);
  return context;
}

(async () => {
  const c = fixture();
  const writes = [];
  const releases = [];
  c.remoteSync.client = {from:()=>({upsert:payload=>{
    writes.push(payload);
    return new Promise(resolve=>releases.push(resolve));
  }})};
  c.markSyncPending();
  const first = c.pushRemoteState();
  c.payload.gare.push({id:2});
  c.markSyncPending();
  assert.equal(c.pushRemoteState(), first);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.gare.length, 1);
  releases.shift()({error:null});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].payload.gare.length, 2);
  releases.shift()({error:null});
  assert.equal(await first, true);
  assert.equal(c.remoteSync.pending, false);
  await c.remoteSync.cachePromise;
  assert.equal((await c.readSyncCache(c.pendingSyncKey())).pending, false);

  c.remoteSync.client = {from:()=>({upsert:async()=>({error:{code:'57014'}})})};
  c.payload.gare.push({id:3});
  c.markSyncPending();
  assert.equal(await c.pushRemoteState(), false);
  assert.equal(c.remoteSync.pending, true);
  assert.match(c.status, /Timeout cloud/);
  assert.equal(await c.pullRemoteState(), false);

  const read = fixture();
  let completeRead;
  read.remoteSync.client = {from:()=>({select:()=>({eq:()=>({maybeSingle:()=>new Promise(resolve=>completeRead=resolve)})})})};
  const pendingRead = read.pullRemoteState();
  read.markSyncPending();
  completeRead({data:{payload:{gare:[]}}, error:null});
  assert.equal(await pendingRead, false);

  read.remoteSync.recovering = true;
  read.remoteSync.baseline = read.syncFingerprint(JSON.stringify({gare:[{id:'old'}]}));
  const recovery = read.pullRemoteState();
  completeRead({data:{payload:{gare:[{id:'other-user-change'}]}},error:null});
  assert.equal(await recovery, false);
  assert.equal(read.remoteSync.conflict, true);
  assert.equal(read.remoteSync.pending, true);

  assert.equal(c.hashState({z:{b:2,a:1},a:[{d:4,c:3}]}), c.hashState({a:[{c:3,d:4}],z:{a:1,b:2}}));
  c.remoteSync.client = {from:()=>({upsert:async()=>{throw new TypeError('Failed to fetch');}})};
  assert.equal(await c.pushRemoteState(), false);
  assert.equal(c.remoteSync.pending, true);
  assert.match(c.status, /Salvataggio cloud fallito/);

  const retry = fixture();
  let recoverRead;
  let recoveredWrites = 0;
  const baseline = retry.hashState({gare:[{id:'baseline'}]});
  retry.remoteSync.lastHash = baseline;
  retry.markSyncPending();
  retry.remoteSync.client = {from:()=>({
    select:()=>({eq:()=>({maybeSingle:()=>new Promise(resolve=>recoverRead=resolve)})}),
    upsert:async()=>{recoveredWrites++; return {error:null};}
  })};
  const retryPromise = retry.retryRemoteSync();
  recoverRead({data:{payload:JSON.parse(baseline)},error:null});
  assert.equal(await retryPromise, true);
  assert.equal(recoveredWrites, 1);
  assert.equal(retry.remoteSync.pending, false);
  retry.remoteSync.recoveryIncomplete = true;
  assert.equal(await retry.retryRemoteSync(), false);
  assert.equal(recoveredWrites, 1);

  const full = fixture();
  full.remoteSync.localStorageSnapshotOk = false;
  full.remoteSync.localSnapshotOk = false;
  full.markSyncPending();
  assert.equal(await full.remoteSync.cachePromise, true);
  assert.equal(full.remoteSync.cacheSaving, false);
  assert.equal(full.remoteSync.localSnapshotOk, true);
  const cached = await full.readSyncCache(full.pendingSyncKey());
  assert.equal(cached.pending, true);
  assert.equal(cached.payload.gare.length, 1);
  full.payload.gare.push({id:2});
  full.markSyncPending();
  await full.remoteSync.cachePromise;
  assert.equal((await full.readSyncCache(full.pendingSyncKey())).payload.gare.length, 2);

  function prepareBootstrap(context) {
    Object.assign(context, {
      loadCurrentProfile:async()=>{}, loadWorkspaceProfiles:async()=>{},
      remoteInitWithTimeout:async ms=>assert.equal(ms, 35000),
      normalizeStateOperatori:()=>false, syncUiControls:()=>{}, updateBadges:()=>{},
      fillPortSel:()=>{}, fillCalendarAssignees:()=>{}, redrawCurrent:()=>{}, unlockAppAfterAuth:()=>{},
      applyState:payload=>{context.payload=payload; context.restored=true;}
    });
    vm.runInContext(bootstrapSource, context);
  }
  const reload = fixture();
  reload.window.indexedDB = full.window.indexedDB;
  const latestCache = await full.readSyncCache(full.pendingSyncKey());
  reload.localStorage.setItem(reload.pendingSyncKey(), JSON.stringify({baseline:latestCache.baseline, snapshotId:latestCache.snapshotId, durable:false}));
  prepareBootstrap(reload);
  await reload.completeAuthenticatedBootstrap();
  assert.equal(reload.payload.gare.length, 2);
  assert.equal(reload.remoteSync.recovering, true);
  assert.equal(reload.remoteSync.recoveryIncomplete, undefined);

  const stale = fixture();
  stale.window.indexedDB = full.window.indexedDB;
  stale.payload.gare.push({id:2},{id:3});
  stale.localStorage.setItem(stale.pendingSyncKey(), JSON.stringify({baseline:latestCache.baseline, snapshotId:'newer-than-cache', durable:true}));
  prepareBootstrap(stale);
  await stale.completeAuthenticatedBootstrap();
  assert.equal(stale.restored, undefined);
  assert.equal(stale.payload.gare.length, 3);
  assert.equal(stale.remoteSync.recovering, true);

  const unloaded = fixture();
  unloaded.remoteSync.loaded = false;
  unloaded.markSyncPending();
  assert.equal(await unloaded.pushRemoteState(), false);

  const realtime = fixture();
  let refreshes = 0;
  const channel = {
    on:(kind, filter, callback)=>{realtime.onChange=callback; return channel;},
    subscribe:()=>channel
  };
  realtime.remoteSync.client = {channel:()=>channel};
  realtime.teardownRemoteRealtime = ()=>{};
  realtime.pullRemoteState = async()=>{refreshes++; return true;};
  vm.runInContext(realtimeSource, realtime);
  realtime.setupRemoteRealtime();
  realtime.onChange({new:{workspace_id:'workspace',updated_at:'2026-10-07T12:00:00Z'}});
  assert.equal(refreshes, 1);
  realtime.remoteSync.pending = true;
  realtime.onChange({new:{workspace_id:'workspace'}});
  assert.equal(refreshes, 1);
  console.log('Cloud sync: queue, immutable snapshots, timeout, stale read, recovery conflict, canonical JSON, network errors, safe retry, IndexedDB persistence/reload, stale-cache protection, initial-load guard and oversized Realtime fallback passed');
})().catch(error=>{console.error(error); process.exitCode=1;});
