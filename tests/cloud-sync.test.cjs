const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.slice(html.indexOf('function syncFingerprint('), html.indexOf('function teardownRemoteRealtime('));
const hashSource = html.slice(html.indexOf('function hashState('), html.indexOf('function saveLocalSnapshot('));

function fixture() {
  const storage = new Map();
  const context = {
    remoteSync:{enabled:true, lastHash:'', pending:false, revision:0, pushPromise:null, localSnapshotOk:true},
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
  console.log('Cloud sync: queue, immutable snapshots, timeout, stale read, recovery conflict, canonical JSON, network errors and safe retry passed');
})().catch(error=>{console.error(error); process.exitCode=1;});
