import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../PortalWorkflowController.cs',import.meta.url),'utf8');
const script=source.split('private static string EdufineServerSessionCheckScript()')[1].split('"""')[1];

function setup(){
  let now=1000000,previous=1000,kills=0,resetCount=0;
  const requests=[],callbackLog=[];
  const app={gv_topFrame:{form:null}};
  const makeForm=name=>({name,fv_useEndCeckTimerId:1,fv_nowUseEndTime:2400,fv_aliveYn:'Y',
    transaction(svcID){requests.push({form:this,svcID})},
    fnSessionCheck(){this.transaction('sessionCheck')},
    fnCallback(svcID,errorCode,errorMsg,...rest){callbackLog.push({form:this,svcID,errorCode,errorMsg,rest})},
    fnResetUseEndCeckTimer(){resetCount++;this.fv_nowUseEndTime=2400},
    TopFrame_ontimer(obj,e){if(e.timerid!==1)return;const sec=Math.round(now/1000);this.fv_nowUseEndTime-=sec-previous;previous=sec;if(this.fv_nowUseEndTime<=0)kills++},
    removeEventHandler(){return 0},addEventHandler(){return 0}});
  let f=makeForm('first');app.gv_topFrame.form=f;
  const context=vm.createContext({nexacro:{getApplication:()=>app},Date:{now:()=>now}});
  const run=()=>vm.runInContext(script,context);
  run();f.TopFrame_ontimer(f,{timerid:1});
  const complete=(index,{form=requests[index].form,errorCode=0,alive='Y'}={})=>{
    form.fv_aliveYn=alive;
    form.fnCallback(requests[index].svcID,errorCode,'');
  };
  const replaceForm=()=>{
    f=makeForm('replacement');app.gv_topFrame.form=f;return f;
  };
  return {get f(){return f},run,advance:seconds=>now+=seconds*1000,kills:()=>kills,
    resets:()=>resetCount,requests,callbackLog,complete,replaceForm,context};
}

test('confirmed reset during hidden interval does not subtract pre-reset time twice',()=>{
  const s=setup();s.advance(2300);s.complete(0);s.advance(200);
  s.f.TopFrame_ontimer(s.f,{timerid:1});
  assert.equal(s.f.fv_nowUseEndTime,2200);assert.equal(s.kills(),0);
});

test('without confirmed renewal the official expiry still runs',()=>{
  const s=setup();s.advance(2500);s.f.TopFrame_ontimer(s.f,{timerid:1});assert.equal(s.kills(),1);
});

test('an old error is reported before a retry and N remains terminal',()=>{
  const s=setup();s.complete(0,{errorCode:-7});s.advance(70);
  assert.equal(s.run(),'ERROR_-7');assert.equal(s.run(),'STARTED');
  s.complete(1,{alive:'N'});s.advance(70);
  assert.equal(s.run(),'N');assert.equal(s.run(),'N');
});

test('in-flight checks are deduplicated',()=>{
  const s=setup();s.f.fnSessionCheck();assert.equal(s.requests.length,1);assert.equal(s.run(),'IN_FLIGHT');
});

test('stale request enters recovery-required state without duplicate transmission',()=>{
  const s=setup();s.advance(301);
  assert.equal(s.run(),'RECOVERY_REQUIRED');s.advance(301);
  assert.equal(s.run(),'RECOVERY_REQUIRED');assert.equal(s.requests.length,1);
  s.complete(0);assert.equal(s.run(),'Y');
});

test('late callback from an older request cannot complete the current request or reset timer',()=>{
  const s=setup();s.complete(0,{errorCode:-7});s.advance(70);
  assert.equal(s.run(),'ERROR_-7');assert.equal(s.run(),'STARTED');
  const resetsBefore=s.resets();
  const callbacksBefore=s.callbackLog.length;
  s.complete(0,{alive:'Y'});
  assert.equal(s.resets(),resetsBefore);assert.equal(s.run(),'IN_FLIGHT');
  assert.equal(s.callbackLog.length,callbacksBefore+1);
  assert.equal(s.callbackLog.at(-1).svcID,'sessionCheck');
  assert.equal(s.callbackLog.at(-1).errorCode,0);assert.equal(s.callbackLog.at(-1).form,s.f);
  s.complete(0,{alive:'N'});
  assert.equal(s.resets(),resetsBefore);assert.equal(s.run(),'IN_FLIGHT');
  assert.equal(s.callbackLog.length,callbacksBefore+2);
  assert.equal(s.callbackLog.at(-1).svcID,'sessionCheck');assert.equal(s.callbackLog.at(-1).form,s.f);
  s.complete(1,{alive:'N'});assert.equal(s.run(),'N');
});

test('duplicate callback cannot overwrite result or reset the timer twice',()=>{
  const s=setup();s.complete(0);assert.equal(s.resets(),1);
  assert.equal(s.callbackLog.length,1);assert.equal(s.callbackLog[0].svcID,'sessionCheck');
  assert.equal(s.callbackLog[0].errorCode,0);assert.equal(s.callbackLog[0].form,s.f);
  s.f.fv_nowUseEndTime=123;s.complete(0,{alive:'Y'});
  assert.equal(s.resets(),1);assert.equal(s.f.fv_nowUseEndTime,123);assert.equal(s.run(),'Y');
  assert.equal(s.callbackLog.length,2);assert.equal(s.callbackLog[1].svcID,'sessionCheck');
  assert.equal(s.callbackLog[1].form,s.f);
});

test('callback from replaced topForm cannot alter replacement state or timer',()=>{
  const s=setup();const oldForm=s.f;const replacement=s.replaceForm();
  assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
  s.complete(0,{form:oldForm,alive:'Y'});
  assert.equal(s.resets(),0);assert.equal(replacement.fv_nowUseEndTime,2400);
  assert.equal(s.callbackLog.length,1);assert.equal(s.callbackLog[0].svcID,'sessionCheck');
  assert.equal(s.callbackLog[0].form,oldForm);
  s.complete(0,{form:oldForm,alive:'N'});
  assert.equal(s.resets(),0);assert.equal(replacement.fv_nowUseEndTime,2400);
  assert.equal(s.callbackLog.length,2);assert.equal(s.callbackLog[1].svcID,'sessionCheck');
  assert.equal(s.callbackLog[1].form,oldForm);
  assert.equal(s.run(),'IN_FLIGHT');
  s.complete(1,{form:replacement,alive:'Y'});
  assert.equal(s.resets(),1);assert.equal(s.run(),'Y');
  assert.equal(s.callbackLog.length,3);assert.equal(s.callbackLog[2].svcID,'sessionCheck');
  assert.equal(s.callbackLog[2].form,replacement);
});

test('request without transaction ownership tag is stopped as recovery required',()=>{
  const s=setup();const replacement=s.replaceForm();
  const baseCallback=replacement.fnCallback;let previousCalls=0;
  replacement.__oneClickOriginalCallbackV1=baseCallback;
  replacement.fnCallback=function(...args){previousCalls++;return baseCallback.apply(this,args)};
  replacement.fnSessionCheck=function(){};
  assert.equal(s.run(),'OWNERSHIP_UNCONFIRMED');
  assert.equal(s.run(),'OWNERSHIP_UNCONFIRMED');
  replacement.fnCallback('sessionCheck',-9,'site error','extra');
  assert.equal(s.callbackLog.length,1);
  assert.equal(s.callbackLog[0].svcID,'sessionCheck');
  assert.equal(s.callbackLog[0].errorCode,-9);assert.equal(s.callbackLog[0].errorMsg,'site error');
  assert.deepEqual(s.callbackLog[0].rest,['extra']);assert.equal(s.callbackLog[0].form,replacement);
  assert.equal(previousCalls,1);
});

test('unrelated service callback reaches the base handler once without changing session ownership',()=>{
  const s=setup();
  const resetsBefore=s.resets();
  s.f.fnCallback('documentLoad',-3,'other service','payload');
  assert.equal(s.callbackLog.length,1);
  assert.deepEqual(s.callbackLog[0],{
    form:s.f,svcID:'documentLoad',errorCode:-3,errorMsg:'other service',rest:['payload']
  });
  assert.equal(s.resets(),resetsBefore);
  assert.equal(s.run(),'IN_FLIGHT');
  assert.equal(s.requests.length,1);
});
