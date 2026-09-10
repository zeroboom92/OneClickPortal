import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../MainForm.cs',import.meta.url),'utf8');

test('workflow session expiry keeps the browser connection and records one pending owner',()=>{
 const workflow=source.split('private async Task RunWorkflowAsync')[1]
  .split('private async Task CheckPortalSessionsInBackgroundAsync')[0];
 const expiredCatch=workflow.split('catch (PortalSessionExpiredException exception)')[1]
  .split('catch (Exception exception)')[0];
 assert.doesNotMatch(expiredCatch,/DisconnectBrowser\s*\(/);
 assert.match(expiredCatch,/_pendingTaskSystemName = exception\.SystemName/);
 assert.match(expiredCatch,/_pendingTaskKind = taskKind/);
});

test('background session notice is shown only after gate release and is nonmodal',()=>{
 const check=source.split('private async Task CheckPortalSessionsInBackgroundAsync')[1]
  .split('private void ShowSessionNotice')[0];
 assert.equal(check.includes('MessageBox.Show'),false);
 assert.ok(check.indexOf('_portalOperationGate.Release()')<check.indexOf('ShowSessionNotice('));
 assert.match(check,/checkGeneration != _connectionGeneration/);
});
