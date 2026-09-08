import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../PortalWorkflowController.cs',import.meta.url),'utf8');
const script=source.split('private static string EdufineServerSessionCheckScript()')[1].split('"""')[1];
function setup(){
  let now=1000000,previous=1000,kills=0,requests=0;
  const f={fv_useEndCeckTimerId:1,fv_nowUseEndTime:2400,fv_aliveYn:'Y',
    fnSessionCheck(){requests++},fnCallback(){},
    fnResetUseEndCeckTimer(){this.fv_nowUseEndTime=2400},
    TopFrame_ontimer(obj,e){if(e.timerid!==1)return;const sec=Math.round(now/1000);this.fv_nowUseEndTime-=sec-previous;previous=sec;if(this.fv_nowUseEndTime<=0)kills++},
    removeEventHandler(){return 0},addEventHandler(){return 0}};
  const context=vm.createContext({nexacro:{getApplication:()=>({gv_topFrame:{form:f}})},Date:{now:()=>now}});
  const run=()=>vm.runInContext(script,context);
  run(); f.TopFrame_ontimer(f,{timerid:1});
  return {f,run,advance:seconds=>now+=seconds*1000,kills:()=>kills,requests:()=>requests};
}
test('confirmed reset during hidden interval does not subtract pre-reset time twice',()=>{
  const s=setup();s.advance(2300);s.f.fnCallback('sessionCheck',0,'');s.advance(200);
  s.f.TopFrame_ontimer(s.f,{timerid:1});
  assert.equal(s.f.fv_nowUseEndTime,2200);assert.equal(s.kills(),0);
});
test('without confirmed renewal the official expiry still runs',()=>{
  const s=setup();s.advance(2500);s.f.TopFrame_ontimer(s.f,{timerid:1});assert.equal(s.kills(),1);
});
test('an old error is reported before a retry and N remains terminal',()=>{
  const s=setup();s.f.fnCallback('sessionCheck',-7,'');s.advance(70);
  assert.equal(s.run(),'ERROR_-7');assert.equal(s.run(),'STARTED');
  s.f.fv_aliveYn='N';s.f.fnCallback('sessionCheck',0,'');s.advance(70);
  assert.equal(s.run(),'N');assert.equal(s.run(),'N');
});
test('in-flight checks are deduplicated',()=>{
  const s=setup();s.f.fnSessionCheck();assert.equal(s.requests(),1);assert.equal(s.run(),'IN_FLIGHT');
});
