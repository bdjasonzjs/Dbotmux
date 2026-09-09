import { mkdtempSync,writeFileSync,copyFileSync,chmodSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { expect,test } from 'vitest';
import { initializeDelegation } from '../src/cli/delegation.js';

test('explicit recovery of missing-mention receipt does not repeat the send and enables actual parent ingest',()=>{
 const root=mkdtempSync(join(tmpdir(),'delegation-reconcile-test-'));
 try {
  const actors=join(root,'actors.json'),home=join(root,'home'),transport=join(root,'transport');
  writeFileSync(actors,JSON.stringify({profile:'fixture',app_id:'cli_executor',owner_open_id:'ou_owner',executor_open_id:'ou_executor',observer_app_id:'cli_observer',reviewer_app_id:'cli_reviewer'}));
  initializeDelegation(['--home',home,'--root','om_fixture1','--task','example','--path','oc_demoroot,oc_demomid,oc_demoleaf','--actors',actors]);
  copyFileSync(new URL('./fixtures/delegation/transport.py',import.meta.url),transport);chmodSync(transport,0o755);
  const p=spawnSync('python3',[new URL('./fixtures/delegation/reconcile-receipt.py',import.meta.url).pathname,home,transport],{encoding:'utf8',timeout:30000});
  expect(p.status,p.stderr||p.stdout).toBe(0);
  expect(JSON.parse(p.stdout)).toMatchObject({ok:true,initial_failed_send_rc:9,zero_duplicate_external_sends:true,wrong_message_rejected:true,wrong_body_rejected:true,repeated_reconcile_zero_state_writes:true,parent_ingest_applied:true,live_lark_verified:false});
 } finally {rmSync(root,{recursive:true,force:true});}
});
