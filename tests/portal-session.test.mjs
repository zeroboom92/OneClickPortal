import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../PortalWorkflowController.cs',import.meta.url),'utf8');
const script=source.split('private static string PortalSessionStateScript()')[1].split('"""')[1];

function setup(){
 let now=1000000,clicks=0,completeHandler;
 const button={click(){clicks++},getAttribute:()=>null};
 const document={readyState:'complete',body:{innerText:'업무포털 메인'},querySelectorAll(selector){
  if(selector==='button.btn.btn-refresh[title="세션 시간 초기화"]')return [button];
  return [];
 }};
 const jquery=()=>({on(name,handler){completeHandler=handler}});
 const context=vm.createContext({document,jQuery:jquery,Date:{now:()=>now}});
 return {run:()=>vm.runInContext(script,context),advance:s=>now+=s*1000,clicks:()=>clicks,
  complete:(status,url='/bpm_lgn_lg00_102.do')=>completeHandler({}, {status}, {url})};
}

test('official refresh click is deduplicated until its ajax completion',()=>{
 const s=setup();assert.equal(s.run(),'STARTED');assert.equal(s.run(),'IN_FLIGHT');
 assert.equal(s.clicks(),1);s.complete(200);assert.equal(s.run(),'HTTP_OK_OFFICIAL_CLICK');
 assert.equal(s.run(),'HTTP_OK_RECENT');assert.equal(s.clicks(),1);
});

test('unconfirmed stale portal request requires recovery and never clicks twice',()=>{
 const s=setup();assert.equal(s.run(),'STARTED');s.advance(16);
 assert.equal(s.run(),'RECOVERY_REQUIRED');s.advance(120);
 assert.equal(s.run(),'RECOVERY_REQUIRED');assert.equal(s.clicks(),1);
 s.complete(200);assert.equal(s.run(),'HTTP_OK_OFFICIAL_CLICK');
});

test('only the observed official endpoint completes the pending click',()=>{
 const s=setup();s.run();s.complete(200,'/other.do');assert.equal(s.run(),'IN_FLIGHT');
});
