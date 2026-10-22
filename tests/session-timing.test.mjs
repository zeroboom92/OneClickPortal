import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../PortalWorkflowController.cs',import.meta.url),'utf8');
const script=source.split('private static string EdufineServerSessionCheckScript(')[1].split('"""')[1];
const renderScript=forceCheck=>script.replace('{{(forceCheck ? "true" : "false")}}',String(forceCheck));

function setup({legacyV3,legacyV2,existingV4Wrapper=false,initialTick=true,
  officialPreviousSeconds=1000,existingV2TimerWrapper=false,legacyTimerLastTick=null,
  legacyTimerResetAt=null,eventBus=false,prepareForm=()=>{}}={}){
  let now=1000000,kills=0,resetCount=0,frameworkResetCount=0;
  const requests=[],callbackLog=[],timerLog=[];
  const displayTime=remaining=>{
    const seconds=Math.max(0,remaining);
    return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  };
  const app={gv_topFrame:{form:null}};
  const makeForm=name=>{
    // This clock belongs to the portal handler. A reset intentionally does not
    // update it, and the injected policy cannot inspect or change it.
    let previous=officialPreviousSeconds;
    const form={name,fv_useEndCeckTimerId:1,fv_nowUseEndTime:2400,fv_aliveYn:'Y',
      divTopGrp:{form:{staUseTime:{text:'40:00'}}},
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
      fnResetUseEndCeckTimer(){resetCount++;this.fv_nowUseEndTime=2400;this.divTopGrp.form.staUseTime.text='40:00'},
      fnKillServerSession(){kills++},
      gfnResetUseEndCeckTimer(){frameworkResetCount++},
      TopFrame_ontimer(obj,e){
        timerLog.push({form:this,obj,event:e});
        if(eventBus?e.timerid==this.fv_useEndCeckTimerId:e.timerid===1){
          const sec=Math.round(now/1000);
          this.fv_nowUseEndTime-=sec-previous;
          if(eventBus&&this.fv_nowUseEndTime<0)this.fv_nowUseEndTime=0;
          previous=sec;
          this.divTopGrp.form.staUseTime.text=displayTime(this.fv_nowUseEndTime);
          if(this.fv_nowUseEndTime<=0)this.fnKillServerSession();
        }
        return `official-timer-${e.timerid}`;
      },
      removeEventHandler(){return 0},addEventHandler(){return 0}};
    form.originalGfnTransaction=form.gfnTransaction;
    form.originalTransaction=form.transaction;
    form.officialMethods=Object.fromEntries([
      'fnSessionCheck','fnCallback','_gfnCallback','fnResetUseEndCeckTimer','TopFrame_ontimer'
    ].map(name=>[name,form[name]]));
    if(eventBus){
      // Nexacro dispatches saved handler references, independently of the current
      // form method. Replacing a property alone must not make these tests pass.
      form.ontimer={_user_handlers:[{handler:form.TopFrame_ontimer,target:form}],_sys_handlers:[]};
      form.removeEventHandler=function(type,handler,target){
        if(type!=='ontimer')return -1;
        const handlers=this.ontimer._user_handlers;
        const index=handlers.findIndex(item=>item.handler===handler&&item.target===target);
        if(index>=0)handlers.splice(index,1);
        return index;
      };
      form.addEventHandler=function(type,handler,target){
        if(type!=='ontimer')return -1;
        const handlers=this.ontimer._user_handlers;
        const existing=handlers.findIndex(item=>item.handler===handler&&item.target===target);
        if(existing>=0)return existing;
        return handlers.push({handler,target})-1;
      };
    }
    return form;
  };
  let f=makeForm('first');app.gv_topFrame.form=f;
  if(existingV2TimerWrapper){
    // Reproduce the previously shipped policy, rather than deriving a legacy
    // wrapper from today's implementation under test.
    const originalTimer=f.TopFrame_ontimer;
    const originalReset=f.fnResetUseEndCeckTimer;
    const timing={lastTick:legacyTimerLastTick,resetAt:legacyTimerResetAt};
    f.TopFrame_ontimer=function(obj,event){
      if(event.timerid!==this.fv_useEndCeckTimerId)
        return originalTimer.apply(this,arguments);
      const nowSeconds=Math.round(now/1000);
      if(timing.lastTick!==null&&timing.resetAt>timing.lastTick){
        this.fv_nowUseEndTime+=Math.max(0,
          Math.min(timing.resetAt,nowSeconds)-timing.lastTick);
      }
      try{return originalTimer.apply(this,arguments)}
      finally{timing.lastTick=nowSeconds;timing.resetAt=null}
    };
    f.fnResetUseEndCeckTimer=function(){
      const result=originalReset.apply(this,arguments);
      timing.resetAt=Math.round(now/1000);
      return result;
    };
    f.__oneClickTimerBaselineV2=timing;
    if(eventBus)f.ontimer._user_handlers=[{handler:f.TopFrame_ontimer,target:f}];
  }
  prepareForm(f);
  const context=vm.createContext({nexacro:{getApplication:()=>app},Date:{now:()=>now}});
  if(legacyV3)context.__oneClickEdufineServerKeepAliveV3=legacyV3;
  if(legacyV2)context.__oneClickEdufineServerKeepAliveV2=legacyV2;
  const run=(forceCheck=false)=>vm.runInContext(renderScript(forceCheck),context);
  // Retain the existing wrapper/delegation shape and V4 ownership state, then install
  // the new policy while its already-tagged request is still in flight.
  const initialResult=existingV4Wrapper
    ?vm.runInContext(renderScript(false)
      .replaceAll('__oneClickSessionWrappedV7','__oneClickSessionWrappedV4')
      .replaceAll('__oneClickSessionPolicyV7','__oneClickSessionPolicyV4'),context)
    :run();
  const dispatchTimer=(event={timerid:1})=>eventBus
    ?[...f.ontimer._user_handlers].map(({handler,target})=>handler.call(target,f,event))
    :[f.TopFrame_ontimer(f,event)];
  if(initialTick)dispatchTimer();
  const complete=(index,{form=requests[index].form,errorCode=0,alive='Y'}={})=>{
    form.fv_aliveYn=alive;
    form[requests[index].callbackName](requests[index].transactionSvcID,errorCode,'');
  };
  const replaceForm=()=>{
    f=makeForm('replacement');app.gv_topFrame.form=f;return f;
  };
  return {get f(){return f},run,advance:seconds=>now+=seconds*1000,kills:()=>kills,
    resets:()=>resetCount,frameworkResets:()=>frameworkResetCount,
    requests,callbackLog,timerLog,complete,replaceForm,context,initialResult,dispatchTimer};
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

test('confirmed reset before the first observed tick uses time elapsed after the reset',()=>{
  const s=setup({initialTick:false});
  const descriptor=Object.getOwnPropertyDescriptor(s.f,'fv_nowUseEndTime');
  s.advance(2300);s.complete(0);s.advance(200);
  assert.equal(s.f.TopFrame_ontimer(s.f,{timerid:1}),'official-timer-1');
  assert.equal(s.f.fv_nowUseEndTime,2200);
  assert.equal(s.f.divTopGrp.form.staUseTime.text,'36:40');
  assert.equal(s.kills(),0);assert.equal(s.timerLog.length,1);
  assert.deepEqual(Object.getOwnPropertyDescriptor(s.f,'fv_nowUseEndTime'),
    {...descriptor,value:2200});
});

test('a portal tick baseline older than installation cannot shorten a confirmed renewal',()=>{
  for(const officialPreviousSeconds of [900,0,-3600]){
    const s=setup({initialTick:false,officialPreviousSeconds});
    s.advance(2300);s.complete(0);s.advance(200);
    s.f.TopFrame_ontimer(s.f,{timerid:1});
    assert.equal(s.f.fv_nowUseEndTime,2200);
    assert.equal(s.f.divTopGrp.form.staUseTime.text,'36:40');
    assert.equal(s.kills(),0);assert.equal(s.timerLog.length,1);
    s.advance(1);s.f.TopFrame_ontimer(s.f,{timerid:1});
    assert.equal(s.f.fv_nowUseEndTime,2199);assert.equal(s.timerLog.length,2);
  }
});

test('five-minute confirmed renewals remain valid while no portal timer ticks for over forty minutes',()=>{
  const s=setup({initialTick:false});
  s.complete(0);assert.equal(s.run(),'Y');
  for(let request=1;request<=9;request++){
    s.advance(301);assert.equal(s.run(),'STARTED');
    s.complete(request);assert.equal(s.run(),'Y');
  }
  s.advance(200);s.f.TopFrame_ontimer(s.f,{timerid:1});
  assert.equal(s.resets(),10);assert.equal(s.requests.length,10);
  assert.equal(s.callbackLog.length,10);assert.equal(s.timerLog.length,1);
  assert.equal(s.f.fv_nowUseEndTime,2200);
  assert.equal(s.f.divTopGrp.form.staUseTime.text,'36:40');assert.equal(s.kills(),0);
});

test('an unrelated timer is forwarded once without consuming a pending renewal baseline',()=>{
  const s=setup({initialTick:false});
  const descriptor=Object.getOwnPropertyDescriptor(s.f,'fv_nowUseEndTime');
  s.advance(2300);s.complete(0);s.advance(100);
  const event={timerid:99,payload:'unrelated'};
  assert.equal(s.f.TopFrame_ontimer(s.f,event),'official-timer-99');
  assert.equal(s.timerLog.length,1);assert.equal(s.timerLog[0].event,event);
  assert.equal(s.timerLog[0].obj,s.f);assert.equal(s.timerLog[0].form,s.f);
  assert.equal(s.f.fv_nowUseEndTime,2400);
  assert.deepEqual(Object.getOwnPropertyDescriptor(s.f,'fv_nowUseEndTime'),descriptor);
  s.advance(100);s.f.TopFrame_ontimer(s.f,{timerid:1});
  assert.equal(s.f.fv_nowUseEndTime,2200);assert.equal(s.kills(),0);
  assert.equal(s.timerLog.length,2);
});

test('a tick immediately after reset keeps all forty minutes and restores the counter descriptor',()=>{
  const s=setup({initialTick:false});
  const descriptor=Object.getOwnPropertyDescriptor(s.f,'fv_nowUseEndTime');
  s.advance(2300);s.complete(0);
  s.f.TopFrame_ontimer(s.f,{timerid:1});
  assert.equal(s.f.fv_nowUseEndTime,2400);
  assert.equal(s.f.divTopGrp.form.staUseTime.text,'40:00');assert.equal(s.kills(),0);
  assert.equal(s.timerLog.length,1);
  assert.deepEqual(Object.getOwnPropertyDescriptor(s.f,'fv_nowUseEndTime'),descriptor);
  s.advance(1);s.f.TopFrame_ontimer(s.f,{timerid:1});
  assert.equal(s.f.fv_nowUseEndTime,2399);assert.equal(s.timerLog.length,2);
});

test('a confirmed renewal expires normally after more than forty minutes without another renewal',()=>{
  const s=setup({initialTick:false});
  s.advance(2300);s.complete(0);s.advance(2401);
  s.f.TopFrame_ontimer(s.f,{timerid:1});
  assert.equal(s.f.fv_nowUseEndTime,0);
  assert.equal(s.f.divTopGrp.form.staUseTime.text,'0:00');assert.equal(s.kills(),1);
  assert.equal(s.resets(),1);assert.equal(s.timerLog.length,1);
});

test('upgrading an installed V2 timer wrapper preserves exactly one official tick and renewal',()=>{
  for(const legacyTimerLastTick of [null,900]){
    const s=setup({initialTick:false,officialPreviousSeconds:900,
      existingV2TimerWrapper:true,legacyTimerLastTick});
    s.advance(2300);s.complete(0);s.advance(200);
    assert.equal(s.f.TopFrame_ontimer(s.f,{timerid:1}),'official-timer-1');
    assert.equal(s.f.fv_nowUseEndTime,2200);
    assert.equal(s.f.divTopGrp.form.staUseTime.text,'36:40');assert.equal(s.kills(),0);
    assert.equal(s.resets(),1);assert.equal(s.timerLog.length,1);
    assert.equal(s.run(),'Y');
    s.advance(1);s.f.TopFrame_ontimer(s.f,{timerid:1});
    assert.equal(s.f.fv_nowUseEndTime,2199);assert.equal(s.timerLog.length,2);
    assert.equal(s.resets(),1);
  }
});

test('upgrading with cached Y retains a V2 renewal waiting for its first portal tick',()=>{
  const s=setup({initialTick:false,officialPreviousSeconds:400,
    existingV2TimerWrapper:true,legacyTimerLastTick:400,legacyTimerResetAt:900,
    legacyV3:{inFlight:false,startedAt:899000,completedAt:900000,result:'Y',
      reported:false,recoveryRequired:false}});
  assert.equal(s.initialResult,'Y');assert.equal(s.requests.length,0);
  s.advance(100);s.f.TopFrame_ontimer(s.f,{timerid:1});
  assert.equal(s.f.fv_nowUseEndTime,2200);
  assert.equal(s.f.divTopGrp.form.staUseTime.text,'36:40');assert.equal(s.kills(),0);
  assert.equal(s.timerLog.length,1);assert.equal(s.resets(),0);
});

test('without confirmed renewal the official expiry still runs',()=>{
  const s=setup({initialTick:false});
  s.advance(2500);s.f.TopFrame_ontimer(s.f,{timerid:1});
  assert.equal(s.f.fv_nowUseEndTime,-100);assert.equal(s.kills(),1);
  assert.equal(s.f.divTopGrp.form.staUseTime.text,'0:00');
  assert.equal(s.resets(),0);assert.equal(s.timerLog.length,1);
});

test('a negative or failed server check leaves the official expiry intact before its first tick',()=>{
  for(const result of [{alive:'N'},{errorCode:-7}]){
    const s=setup({initialTick:false});
    s.advance(2300);s.complete(0,result);s.advance(200);
    s.f.TopFrame_ontimer(s.f,{timerid:1});
    assert.equal(s.f.fv_nowUseEndTime,-100);assert.equal(s.kills(),1);
    assert.equal(s.f.divTopGrp.form.staUseTime.text,'0:00');
    assert.equal(s.resets(),0);assert.equal(s.timerLog.length,1);
  }
});

test('a later N invalidates a pending successful reset in current and old timer wrappers',()=>{
  for(const existingV2TimerWrapper of [false,true]){
    const s=setup({initialTick:false,existingV2TimerWrapper,legacyTimerLastTick:900});
    s.complete(0);assert.equal(s.run(),'Y');
    s.advance(301);assert.equal(s.run(),'STARTED');
    s.complete(1,{alive:'N'});assert.equal(s.run(),'N');
    s.advance(2199);s.f.TopFrame_ontimer(s.f,{timerid:1});
    assert.equal(s.f.fv_nowUseEndTime,-100);assert.equal(s.kills(),1);
    assert.equal(s.f.divTopGrp.form.staUseTime.text,'0:00');
    assert.equal(s.resets(),1);assert.equal(s.timerLog.length,1);
  }
});

test('an externally expired counter cannot be revived by a pending renewal adjustment',()=>{
  for(const remaining of [0,-10]){
    const s=setup({initialTick:false,existingV2TimerWrapper:true,legacyTimerLastTick:900});
    s.complete(0);s.f.fv_nowUseEndTime=remaining;s.advance(1);
    s.f.TopFrame_ontimer(s.f,{timerid:1});
    assert.equal(s.f.fv_nowUseEndTime,remaining-1);assert.equal(s.kills(),1);
    assert.equal(s.f.divTopGrp.form.staUseTime.text,'0:00');assert.equal(s.timerLog.length,1);
  }
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

test('zero-timer confirmation bypasses cached Y but never overlaps an official request',()=>{
  const s=setup();s.complete(0);assert.equal(s.run(),'Y');
  s.f.fv_nowUseEndTime=0;
  assert.equal(s.run(true),'STARTED');assert.equal(s.requests.length,2);
  assert.equal(s.run(true),'IN_FLIGHT');assert.equal(s.requests.length,2);
  s.complete(1,{alive:'N'});
  assert.equal(s.run(true),'N');assert.equal(s.requests.length,2);
});

test('first observation of an old Y cannot report current session health',()=>{
  const s=setup();s.complete(0);s.advance(3600);
  assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
  assert.equal(s.run(),'IN_FLIGHT');
});

test('server Y with a missing, throwing or ineffective timer reset remains unconfirmed',()=>{
  for(const [reset,expected] of [
    [null,'Y_RESET_UNAVAILABLE'],
    [()=>{throw new Error('reset failed')},'Y_RESET_FAILED'],
    [()=>{},'Y_RESET_UNCONFIRMED']
  ]){
    const s=setup();s.f.fv_nowUseEndTime=0;
    s.f.divTopGrp.form.staUseTime.text='0:00';s.f.fnResetUseEndCeckTimer=reset;
    s.complete(0);
    assert.equal(s.run(),expected);assert.equal(s.callbackLog.length,1);
    assert.equal(s.run(true),expected);assert.equal(s.requests.length,1);
    s.advance(61);assert.equal(s.run(true),'STARTED');assert.equal(s.requests.length,2);
  }
});

test('positive displayed time cannot confirm a renewal when the internal counter is unavailable',()=>{
  const s=setup();delete s.f.fv_nowUseEndTime;
  s.f.divTopGrp={form:{staUseTime:{text:'0:00'}}};
  s.f.fnResetUseEndCeckTimer=function(){this.divTopGrp.form.staUseTime.text='40:00'};
  s.complete(0);assert.equal(s.run(),'Y_TIMER_UNAVAILABLE');
});

test('cached Y is not reused after the timer counter or its renewal protection becomes unavailable',()=>{
  for(const alreadyReported of [false,true]){
    for(const change of [
      form=>{delete form.fv_nowUseEndTime},
      form=>Object.defineProperty(form,'fv_nowUseEndTime',{get:()=>2400,configurable:true}),
      form=>Object.defineProperty(form,'fv_nowUseEndTime',{configurable:false}),
      form=>{form.__oneClickTimerBaselineV3.ready=false}
    ]){
      const s=setup();s.complete(0);
      if(alreadyReported)assert.equal(s.run(),'Y');
      change(s.f);
      assert.equal(s.run(),'Y_TIMER_UNAVAILABLE');
      assert.equal(s.run(),'Y_TIMER_UNAVAILABLE');
      assert.equal(s.requests.length,1);assert.equal(s.resets(),1);
      assert.equal(s.callbackLog.length,1);
    }
  }
});

test('unsupported counter descriptors cannot claim protected renewal or disable official expiry',()=>{
  for(const kind of ['nonconfigurable','accessor']){
    const s=setup({initialTick:false,prepareForm(form){
      if(kind==='nonconfigurable'){
        Object.defineProperty(form,'fv_nowUseEndTime',{value:2400,writable:true,
          configurable:false,enumerable:false});
      }else{
        let value=2400;
        Object.defineProperty(form,'fv_nowUseEndTime',{get:()=>value,set:next=>{value=next},
          configurable:true,enumerable:false});
      }
    }});
    const descriptor=Object.getOwnPropertyDescriptor(s.f,'fv_nowUseEndTime');
    s.complete(0);assert.equal(s.run(),'Y_TIMER_UNAVAILABLE');
    assert.equal(s.callbackLog.length,1);assert.equal(s.resets(),1);
    s.advance(2500);s.f.TopFrame_ontimer(s.f,{timerid:1});
    assert.equal(s.f.fv_nowUseEndTime,-100);assert.equal(s.kills(),1);
    assert.equal(s.f.divTopGrp.form.staUseTime.text,'0:00');assert.equal(s.timerLog.length,1);
    assert.deepEqual(Object.getOwnPropertyDescriptor(s.f,'fv_nowUseEndTime'),
      kind==='accessor'?descriptor:{...descriptor,value:-100});
  }
});

test('failed timer event installation restores the official handler and reports renewal as unprotected',()=>{
  for(const failurePhase of ['remove','add']){
    for(const failureMode of ['negative','throw']){
      let originalTimer,originalReset;
      const installed=new Set();
      const s=setup({initialTick:false,prepareForm(form){
        originalTimer=form.TopFrame_ontimer;originalReset=form.fnResetUseEndCeckTimer;
        installed.add(originalTimer);
        form.removeEventHandler=function(type,handler){
          if(handler===originalTimer&&failurePhase==='remove'){
            if(failureMode==='throw')throw new Error('cannot remove timer');
            return -1;
          }
          installed.delete(handler);return 0;
        };
        form.addEventHandler=function(type,handler){
          if(handler!==originalTimer&&failurePhase==='add'){
            if(failureMode==='throw')throw new Error('cannot add timer');
            return -1;
          }
          installed.add(handler);return 0;
        };
      }});
      assert.equal(s.f.TopFrame_ontimer,originalTimer);
      assert.equal(s.f.fnResetUseEndCeckTimer,originalReset);
      assert.deepEqual([...installed],[originalTimer]);
      s.complete(0);assert.equal(s.run(),'Y_TIMER_UNAVAILABLE');
      assert.equal(s.callbackLog.length,1);assert.equal(s.resets(),1);
      s.advance(2500);
      for(const handler of installed)handler.call(s.f,s.f,{timerid:1});
      assert.equal(s.f.fv_nowUseEndTime,-100);assert.equal(s.kills(),1);
      assert.equal(s.f.divTopGrp.form.staUseTime.text,'0:00');assert.equal(s.timerLog.length,1);
    }
  }
});

test('forced zero-timer checks preserve legacy request and recovery barriers',()=>{
  const active={inFlight:true,startedAt:1000000,completedAt:0,result:null,reported:false,recoveryRequired:false};
  for(const options of [{legacyV3:{...active}},{legacyV2:{...active}}]){
    const s=setup(options);
    assert.match(s.run(true),/^LEGACY_(?:V3_)?IN_FLIGHT$/);
    assert.equal(s.requests.length,0);
    s.advance(301);assert.match(s.run(true),/^LEGACY_/);assert.equal(s.requests.length,0);
  }
});

test('reinstalling the current callback policy over a V4 wrapper does not duplicate requests, resets or callbacks',()=>{
  for(const alive of ['Y','N']){
    const s=setup({existingV4Wrapper:true});
    assert.equal(s.f.__oneClickSessionWrappedV4,true);
    assert.equal(s.run(true),'IN_FLIGHT');assert.equal(s.requests.length,1);
    assert.equal(s.f.__oneClickSessionWrappedV7,true);
    s.complete(0,{alive});
    assert.equal(s.run(),alive);assert.equal(s.resets(),alive==='Y'?1:0);
    assert.equal(s.callbackLog.length,1);assert.equal(s.callbackLog[0].svcID,'sessionCheck');
    s.complete(0,{alive});
    assert.equal(s.resets(),alive==='Y'?1:0);assert.equal(s.callbackLog.length,2);
    assert.equal(s.requests.length,1);
  }
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

for(const method of ['fnSessionCheck','fnResetUseEndCeckTimer','TopFrame_ontimer','fnCallback','_gfnCallback']){
  test(`restoring ${method} after a working renewal is repaired before the next hidden-tab renewal`,()=>{
    const s=setup({eventBus:true});
    s.complete(0);assert.equal(s.run(),'Y');
    assert.equal(s.timerLog.length,1);
    // Keep the installation markers, exactly as a method reassignment does.
    s.f[method]=s.f.officialMethods[method];
    s.advance(2300);
    assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
    assert.equal(s.run(),'IN_FLIGHT');assert.equal(s.requests.length,2);
    s.complete(1);assert.equal(s.run(),'Y');
    assert.equal(s.resets(),2);assert.equal(s.callbackLog.length,2);
    s.advance(200);s.dispatchTimer();
    assert.equal(s.f.fv_nowUseEndTime,2200);
    assert.equal(s.f.divTopGrp.form.staUseTime.text,'36:40');
    assert.equal(s.kills(),0);assert.equal(s.timerLog.length,2);
    s.advance(1);s.dispatchTimer();
    assert.equal(s.f.fv_nowUseEndTime,2199);assert.equal(s.timerLog.length,3);
  });
}

test('restored methods cannot reuse a still-recent cached success before a fresh owned callback',()=>{
  for(const method of ['fnSessionCheck','fnResetUseEndCeckTimer','TopFrame_ontimer','fnCallback','_gfnCallback']){
    const s=setup({eventBus:true});s.complete(0);assert.equal(s.run(),'Y');
    s.advance(60);s.f[method]=s.f.officialMethods[method];
    assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
    assert.equal(s.run(),'IN_FLIGHT');assert.equal(s.resets(),1);
    s.complete(1);assert.equal(s.run(),'Y');
    assert.equal(s.resets(),2);assert.equal(s.callbackLog.length,2);
  }
});

for(const registration of ['missing','original only','original before wrapper','duplicate wrapper']){
  test(`a ${registration} timer registration is repaired through actual event dispatch`,()=>{
    const s=setup({eventBus:true});s.complete(0);assert.equal(s.run(),'Y');
    const handlers=s.f.ontimer._user_handlers;
    const original={handler:s.f.officialMethods.TopFrame_ontimer,target:s.f};
    if(registration==='missing')handlers.length=0;
    else if(registration==='original only')handlers.splice(0,handlers.length,original);
    else if(registration==='original before wrapper')handlers.unshift(original);
    else handlers.push({...handlers[0]});
    s.advance(2300);
    assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
    s.complete(1);assert.equal(s.run(),'Y');
    s.advance(200);s.dispatchTimer();
    assert.equal(s.f.fv_nowUseEndTime,2200);
    assert.equal(s.kills(),0);assert.equal(s.timerLog.length,2);
    s.advance(1);s.dispatchTimer();
    assert.equal(s.f.fv_nowUseEndTime,2199);assert.equal(s.timerLog.length,3);
  });
}

for(const method of ['fnSessionCheck','fnResetUseEndCeckTimer','TopFrame_ontimer','fnCallback','_gfnCallback']){
  test(`repairing ${method} while a request is pending preserves its callback without retransmission`,()=>{
    const s=setup({eventBus:true});
    s.advance(200);s.f[method]=s.f.officialMethods[method];
    assert.equal(s.run(),'IN_FLIGHT');assert.equal(s.requests.length,1);
    s.complete(0);assert.equal(s.run(),'Y');
    assert.equal(s.resets(),1);assert.equal(s.callbackLog.length,1);
    s.advance(2300);s.dispatchTimer();
    assert.equal(s.f.fv_nowUseEndTime,100);assert.equal(s.kills(),0);
    assert.equal(s.timerLog.length,2);
  });
}

test('restoring all site methods and their timer registration retains exactly one renewal and tick',()=>{
  const s=setup({eventBus:true});s.complete(0);assert.equal(s.run(),'Y');
  Object.assign(s.f,s.f.officialMethods);
  s.f.ontimer._user_handlers=[{handler:s.f.TopFrame_ontimer,target:s.f}];
  s.advance(2300);
  assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
  assert.equal(s.run(),'IN_FLIGHT');assert.equal(s.requests.length,2);
  s.complete(1);assert.equal(s.run(),'Y');
  s.advance(200);s.dispatchTimer();
  assert.equal(s.f.fv_nowUseEndTime,2200);assert.equal(s.kills(),0);
  assert.equal(s.resets(),2);assert.equal(s.callbackLog.length,2);
  assert.equal(s.timerLog.length,2);
});

test('an untracked replacement request cannot repeat a past success for an hour',()=>{
  const s=setup({eventBus:true});s.complete(0);assert.equal(s.run(),'Y');
  s.f.fnSessionCheck=function(){};
  for(let minute=1;minute<=60;minute++){
    s.advance(60);
    assert.doesNotMatch(s.run(),/^Y(?:_RECENT)?$/);
    assert.equal(s.requests.length,1);assert.equal(s.resets(),1);
  }
});

test('repairing stale wrappers does not revive a terminal server N or send another request',()=>{
  const s=setup({eventBus:true});s.complete(0,{alive:'N'});
  assert.equal(s.run(),'N');
  Object.assign(s.f,s.f.officialMethods);
  s.f.ontimer._user_handlers=[{handler:s.f.TopFrame_ontimer,target:s.f}];
  s.advance(3600);
  assert.equal(s.run(),'N');assert.equal(s.run(true),'N');
  assert.equal(s.requests.length,1);assert.equal(s.resets(),0);
  s.dispatchTimer();assert.equal(s.kills(),1);
});

test('a string timer ID accepted by the site still receives hidden-tab renewal protection',()=>{
  const s=setup({eventBus:true});
  s.advance(2300);s.complete(0);s.advance(200);
  s.dispatchTimer({timerid:'1'});
  assert.equal(s.f.fv_nowUseEndTime,2200);
  assert.equal(s.kills(),0);assert.equal(s.timerLog.length,2);
});

test('timer repair retains unrelated event listeners and forwards their timer unchanged',()=>{
  const s=setup({eventBus:true});s.complete(0);assert.equal(s.run(),'Y');
  const observed=[];
  const observer=function(obj,event){observed.push({context:this,obj,event})};
  s.f.addEventHandler('ontimer',observer,s.f);
  s.f.TopFrame_ontimer=s.f.officialMethods.TopFrame_ontimer;
  s.advance(2300);assert.equal(s.run(),'STARTED');s.complete(1);
  s.advance(100);const unrelated={timerid:99,payload:'preserve event'};
  s.dispatchTimer(unrelated);
  assert.equal(observed.length,1);assert.equal(observed[0].context,s.f);
  assert.equal(observed[0].obj,s.f);assert.equal(observed[0].event,unrelated);
  s.advance(100);s.dispatchTimer();
  assert.equal(observed.length,2);assert.equal(s.f.fv_nowUseEndTime,2200);
  assert.equal(s.kills(),0);assert.equal(s.timerLog.length,3);
});

test('cached success is not reused when a timer binding is broken and cannot be repaired',()=>{
  for(const missing of ['fnResetUseEndCeckTimer','TopFrame_ontimer','removeEventHandler','addEventHandler']){
    const s=setup({eventBus:true});s.complete(0);assert.equal(s.run(),'Y');
    s.f[missing]=null;
    if(missing.endsWith('EventHandler'))s.f.ontimer._user_handlers.length=0;
    assert.equal(s.run(),'Y_TIMER_UNAVAILABLE');
    assert.equal(s.run(),'Y_TIMER_UNAVAILABLE');
    assert.equal(s.requests.length,1);assert.equal(s.resets(),1);
  }
});

test('a migrated V2 timer cannot claim protected renewal while a raw original handler bypasses it',()=>{
  const s=setup({eventBus:true,existingV2TimerWrapper:true,legacyTimerLastTick:1000});
  s.complete(0);assert.equal(s.run(),'Y');
  s.f.ontimer._user_handlers.unshift({handler:s.f.officialMethods.TopFrame_ontimer,target:s.f});
  s.advance(2300);
  const repair=s.run();
  if(repair==='Y_TIMER_UNAVAILABLE')return;
  assert.equal(repair,'STARTED');s.complete(1);
  const confirmed=s.run();
  if(confirmed==='Y_TIMER_UNAVAILABLE')return;
  assert.equal(confirmed,'Y');
  s.advance(200);s.dispatchTimer();
  assert.equal(s.f.fv_nowUseEndTime,2200);assert.equal(s.kills(),0);
  assert.equal(s.timerLog.length,2);
});

test('two distinct official timer closures on one form cannot confirm protected renewal',()=>{
  const s=setup({eventBus:true});s.complete(0);assert.equal(s.run(),'Y');
  const firstOfficial=s.f.officialMethods.TopFrame_ontimer;
  const replacement=s.replaceForm();
  const secondOfficial=replacement.officialMethods.TopFrame_ontimer;
  assert.notEqual(firstOfficial,secondOfficial);
  replacement.ontimer._user_handlers.push({handler:firstOfficial,target:replacement});
  const started=s.run();
  if(started==='STARTED')s.complete(1);
  else assert.equal(started,'Y_TIMER_UNAVAILABLE');
  assert.equal(s.run(),'Y_TIMER_UNAVAILABLE');
  assert.equal(s.run(true),'Y_TIMER_UNAVAILABLE');
});

test('a new timer method and a different saved official handler cannot reuse a protected success',()=>{
  const s=setup({eventBus:true});s.complete(0);assert.equal(s.run(),'Y');
  const savedOfficial=s.f.officialMethods.TopFrame_ontimer;
  const reloaded=setup({eventBus:true});
  const newOfficial=reloaded.f.officialMethods.TopFrame_ontimer;
  assert.notEqual(savedOfficial,newOfficial);
  // The property was reassigned, but the event retains the old script's closure.
  s.f.TopFrame_ontimer=newOfficial;
  s.f.ontimer._user_handlers=[{handler:savedOfficial,target:s.f}];
  s.advance(60);
  const result=s.run();
  if(result==='STARTED')s.complete(1);
  else assert.equal(result,'Y_TIMER_UNAVAILABLE');
  assert.equal(s.run(),'Y_TIMER_UNAVAILABLE');
  assert.equal(s.run(true),'Y_TIMER_UNAVAILABLE');
});
