import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../PortalWorkflowController.cs',import.meta.url),'utf8');
const script=source.split('private static string EdufineServerSessionCheckScript()')[1].split('"""')[1];

function setup({legacyV3,legacyV2}={}){
  let now=1000000,previous=1000,kills=0,resetCount=0,frameworkResetCount=0;
  const requests=[],callbackLog=[];
  const app={gv_topFrame:{form:null}};
  const makeForm=name=>{
    const form={name,fv_useEndCeckTimerId:1,fv_nowUseEndTime:2400,fv_aliveYn:'Y',
      transaction(transactionSvcID,inData,outData,args,callbackName){
        requests.push({form:this,transactionSvcID,callbackName});
      },
      gfnTransaction(strSvcId,inData,outData,args,async,callbackName){
        const service={svcId:strSvcId,callback:callbackName};
        return this.transaction(JSON.stringify(service),inData,outData,args,'_gfnCallback');
      },
      _gfnCallback(transactionSvcID,errorCode,errorMsg){
        const service=JSON.parse(transactionSvcID);
        switch(service.svcId){
          case 'sessionCheck':break;
          default:this.gfnResetUseEndCeckTimer();break;
        }
        return this[service.callback](service.svcId,errorCode,errorMsg);
      },
      fnSessionCheck(){return this.gfnTransaction('sessionCheck','','','','true','fnCallback')},
      fnCallback(svcID,errorCode,errorMsg,...rest){callbackLog.push({form:this,svcID,errorCode,errorMsg,rest})},
      fnResetUseEndCeckTimer(){resetCount++;this.fv_nowUseEndTime=2400},
      gfnResetUseEndCeckTimer(){frameworkResetCount++},
      TopFrame_ontimer(obj,e){if(e.timerid!==1)return;const sec=Math.round(now/1000);this.fv_nowUseEndTime-=sec-previous;previous=sec;if(this.fv_nowUseEndTime<=0)kills++},
      removeEventHandler(){return 0},addEventHandler(){return 0}};
    form.originalGfnTransaction=form.gfnTransaction;
    form.originalTransaction=form.transaction;
    return form;
  };
  let f=makeForm('first');app.gv_topFrame.form=f;
  const context=vm.createContext({nexacro:{getApplication:()=>app},Date:{now:()=>now}});
  if(legacyV3)context.__oneClickEdufineServerKeepAliveV3=legacyV3;
  if(legacyV2)context.__oneClickEdufineServerKeepAliveV2=legacyV2;
  const run=()=>vm.runInContext(script,context);
  const initialResult=run();f.TopFrame_ontimer(f,{timerid:1});
  const complete=(index,{form=requests[index].form,errorCode=0,alive='Y'}={})=>{
    form.fv_aliveYn=alive;
    form[requests[index].callbackName](requests[index].transactionSvcID,errorCode,'');
  };
  const replaceForm=()=>{
    f=makeForm('replacement');app.gv_topFrame.form=f;return f;
  };
  return {get f(){return f},run,advance:seconds=>now+=seconds*1000,kills:()=>kills,
    resets:()=>resetCount,frameworkResets:()=>frameworkResetCount,
    requests,callbackLog,complete,replaceForm,context,initialResult};
}

test('real gfnTransaction JSON flow keeps sessionCheck service ID and restores wrappers',()=>{
  const s=setup();assert.equal(s.initialResult,'STARTED');
  const service=JSON.parse(s.requests[0].transactionSvcID);
  assert.equal(service.svcId,'sessionCheck');assert.equal(service.callback,'fnCallback');
  assert.match(service.__oneClickFormToken,/^f\d+$/);
  assert.equal(service.__oneClickRequestId,1);
  assert.equal(s.requests[0].callbackName,'_gfnCallback');
  assert.equal(s.f.transaction,s.f.originalTransaction);
  assert.equal(s.f.gfnTransaction,s.f.originalGfnTransaction);
  s.complete(0);
  assert.equal(s.frameworkResets(),0);
  assert.equal(s.callbackLog.length,1);assert.equal(s.callbackLog[0].svcID,'sessionCheck');
});

test('pending and stale V3 requests block every V4 transmission',()=>{
  const legacyV3={inFlight:true,startedAt:1000000,completedAt:0,result:null,
    reported:false,recoveryRequired:false};
  const s=setup({legacyV3});
  assert.equal(s.initialResult,'LEGACY_V3_IN_FLIGHT');assert.equal(s.requests.length,0);
  s.advance(301);
  assert.equal(s.run(),'LEGACY_V3_RECOVERY_REQUIRED');assert.equal(s.requests.length,0);
});

test('V3 recovery and ownership-unconfirmed states never start V4',()=>{
  for(const legacyV3 of [
    {inFlight:false,startedAt:0,completedAt:0,result:null,reported:false,recoveryRequired:false},
    {inFlight:true,startedAt:1000000,completedAt:0,result:null,reported:false,recoveryRequired:true},
    {inFlight:true,startedAt:0,completedAt:0,result:null,reported:false,recoveryRequired:false},
    {inFlight:false,startedAt:0,completedAt:1000000,result:'NETWORK_ERROR',reported:true,recoveryRequired:true},
    {inFlight:false,startedAt:0,completedAt:1000000,result:'OWNERSHIP_UNCONFIRMED',reported:true,recoveryRequired:true}
  ]){
    const s=setup({legacyV3});
    assert.equal(s.initialResult,'LEGACY_V3_RECOVERY_REQUIRED');
    s.advance(600);assert.equal(s.run(),'LEGACY_V3_RECOVERY_REQUIRED');
    assert.equal(s.requests.length,0);
  }
});

test('confirmed V3 Y is imported once before V4 can start',()=>{
  const legacyV3={inFlight:false,startedAt:999000,completedAt:999999,result:'Y',
    reported:false,recoveryRequired:false};
  const s=setup({legacyV3});
  assert.equal(s.initialResult,'Y');assert.equal(s.requests.length,0);
  legacyV3.result='N';assert.equal(s.run(),'Y_RECENT');
  s.advance(301);assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,1);
});

test('confirmed V3 N stays terminal and is never retransmitted',()=>{
  const legacyV3={inFlight:false,startedAt:999000,completedAt:999999,result:'N',
    reported:false,recoveryRequired:false};
  const s=setup({legacyV3});
  assert.equal(s.initialResult,'N');s.advance(3600);
  assert.equal(s.run(),'N');assert.equal(s.requests.length,0);
});

test('V2 migration still blocks pending and imports confirmed completion when V3 is absent',()=>{
  const legacyV2={inFlight:true,startedAt:1000000,completedAt:0,result:null,reported:false};
  const s=setup({legacyV2});
  assert.equal(s.initialResult,'LEGACY_IN_FLIGHT');assert.equal(s.requests.length,0);
  legacyV2.inFlight=false;legacyV2.completedAt=1000001;legacyV2.result='Y';
  assert.equal(s.run(),'Y');assert.equal(s.requests.length,0);
});

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
  replacement._gfnCallback(JSON.stringify({svcId:'sessionCheck',callback:'fnCallback'}),-9,'site error');
  assert.equal(s.callbackLog.length,1);
  assert.equal(s.callbackLog[0].svcID,'sessionCheck');
  assert.equal(s.callbackLog[0].errorCode,-9);assert.equal(s.callbackLog[0].errorMsg,'site error');
  assert.deepEqual(s.callbackLog[0].rest,[]);assert.equal(s.callbackLog[0].form,replacement);
  assert.equal(previousCalls,1);
  assert.equal(s.frameworkResets(),0);
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
