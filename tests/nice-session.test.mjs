import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../PortalWorkflowController.cs',import.meta.url),'utf8');
const script=source.split('private static string NiceServerSessionExtensionScript()')[1].split('"""')[1];
function setup({cancel=false,hidden=false}={}){
 let now=1000000,resets=0;const requests=[];
 const originalAjax=function(first,second){
  const options=typeof first==='string'?{...second,url:first}:first;
  let status=cancel?'rejected':'pending',value,reason='abort';const done=[],fail=[];
  const context=options.context||options;
  const request={options,done(fn){done.push(fn);if(status==='resolved')fn(value,'success',this);return this},
   fail(fn){fail.push(fn);if(status==='rejected')fn({},reason);return this},state:()=>status,
   abort(why='abort'){if(status!=='pending')return;status='rejected';reason=why;
    options.error?.call(context,{},why,why);fail.forEach(fn=>fn({},why,why));options.complete?.call(context,{},why)},
   success(next){status='resolved';value=next;options.success?.call(context,next,'success',this);
    done.forEach(fn=>fn(next,'success',this));options.complete?.call(context,this,'success')},
   lateSuccess(next){options.success?.call(context,next,'success',this);done.forEach(fn=>fn(next,'success',this))},
   error(code=0,textStatus='error'){status='rejected';reason=textStatus;
    options.error?.call(context,{status:code},textStatus,'private detail');fail.forEach(fn=>fn({status:code},textStatus,'private detail'));
    options.complete?.call(context,{status:code},textStatus)}};
  requests.push(request);return request;
 };
 const jq={ajax:originalAjax};
 const makeApp=({available=true,throws=false,confirm=true,lookupThrows=false,label,configured=50}={})=>{
  let resetAt=now;
  return {hasAppMethod:name=>available&&name==='setSessionTimerInit',
   callAppMethod(name){assert.equal(name,'setSessionTimerInit');if(throws)throw Error('private account');resets++;
    resetAt=confirm?now:now-50*60*1000},
   lookup(id){if(lookupThrows)throw Error('private screen');
    if(id==='dmUserInfoSub')return {getValue(name){assert.equal(name,'logSesnTime');return configured}};
    assert.equal(id,'optTime');const seconds=Math.max(0,50*60-Math.floor((now-resetAt)/1000));
    return {value:label??(Math.floor(seconds/60)+'분 '+String(seconds%60).padStart(2,'0')+'초')}}};
 };
 const context=vm.createContext({jQuery:jq,$:jq,URL,Date:{now:()=>now},document:{hidden},
  location:{href:'https://jbe.neis.go.kr/jsp/main.jsp',origin:'https://jbe.neis.go.kr'},window:{voMainApp:makeApp()}});
 return {run:()=>vm.runInContext(script,context),runLegacy:()=>vm.runInContext(legacyV3Script,context),
  runLegacyV2:()=>vm.runInContext(legacyV2Script,context),
  advance:seconds=>now+=seconds*1000,requests,resets:()=>resets,context,jq,originalAjax,makeApp,
  get state(){return context.__oneClickNiceServerKeepAliveV3},get now(){return now}};
}

test('beforeSend cancellation releases ownership and retries after one minute',()=>{
 const s=setup({cancel:true});assert.equal(s.run(),'REQUEST_ABORTED');assert.equal(s.run(),'REQUEST_ABORTED');
 assert.equal(s.state.inFlight,false);s.advance(61);assert.equal(s.run(),'REQUEST_ABORTED');assert.equal(s.requests.length,2);
});
test('hung transport is aborted before retry, which waits one minute',()=>{
 const s=setup();s.run();s.advance(121);assert.equal(s.run(),'REQUEST_TIMEOUT');
 assert.equal(s.requests[0].state(),'rejected');assert.equal(s.requests.length,1);
 s.advance(61);assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
});
test('site caller shares raw success and complete callbacks without duplicate traffic',()=>{
 const s=setup();s.run();let value,complete=0;
 const shared=s.jq.ajax({url:'/sessionExtension.do',success(raw){value=raw},complete(){complete++}});
 assert.equal(shared,s.requests[0]);assert.equal(s.requests.length,1);s.requests[0].success('"Y"');
 assert.equal(value,'"Y"');assert.equal(complete,1);assert.equal(s.run(),'Y');assert.equal(s.resets(),1);
});
test('nested callback arrays, caller context and callback exceptions are preserved',()=>{
 const s=setup();s.run();const context={name:'caller'};let success=0,complete=0;
 s.jq.ajax('/sessionExtension.do',{context,success:[()=>{throw Error('caller')},[function(){assert.equal(this,context);success++}]],
  complete:[function(){assert.equal(this,context);complete++}]});
 s.requests[0].success('Y');assert.equal(success,1);assert.equal(complete,1);assert.equal(s.run(),'Y');
});
for(const url of ['/other.do','/other?next=/sessionExtension.do','https://other.example/sessionExtension.do',
 '/sessionExtension.do/extra','/prefix/sessionExtension.do','not a valid :// url'])test('unrelated ajax passes through unchanged: '+url,()=>{
 const s=setup();s.run();const options={url};s.jq.ajax(options);
 assert.equal(s.requests[1].options,options);assert.equal(s.state.requestSequence,1);
});
for(const url of ['/sessionExtension.do?check=1','https://jbe.neis.go.kr/sessionExtension.do','../sessionExtension.do'])test('exact same-origin session path shares pending request: '+url,()=>{
 const s=setup();s.run();assert.equal(s.jq.ajax({url}),s.requests[0]);assert.equal(s.requests.length,1);
});
test('missing location preserves all original ajax calls and reports untracked renewal',()=>{
 const s=setup();s.context.location=undefined;assert.equal(s.run(),'REQUEST_NOT_TRACKED');assert.equal(s.requests.length,1);
 assert.equal(s.state.requestSequence,0);assert.equal(s.state.diagnosticEvents.at(-1).code,'REQUEST_NOT_TRACKED');
});
test('confirmed Y resets once and shares only the ten minute success interval',()=>{
 const s=setup();s.run();s.requests[0].success('Y');assert.equal(s.resets(),1);assert.equal(s.run(),'Y');
 assert.equal(s.run(),'Y_RECENT');assert.equal(s.state.serverResult,'Y');assert.equal(s.state.timerResetResult,'Y');
 assert.equal(s.state.timerResetAt,s.now);s.advance(599);assert.equal(s.run(),'Y_RECENT');
 s.advance(1);assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
});
test('an unreported old Y cannot bypass the freshness limit',()=>{
 const s=setup();s.run();s.requests[0].success('Y');s.advance(601);assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
});
test('N keeps official raw shutdown callbacks and survives a later genuine site Y',()=>{
 const s=setup();s.run();let shutdown=0,siteY=0;
 s.jq.ajax({url:'/sessionExtension.do',success(raw){if(raw!=='"Y"')shutdown++}});s.requests[0].success('"N"');
 assert.equal(shutdown,1);assert.equal(s.run(),'N');assert.equal(s.resets(),0);
 s.jq.ajax({url:'/sessionExtension.do',success(raw){if(raw==='"Y"')siteY++}});
 assert.equal(s.requests.length,2);s.requests[1].success('"Y"');assert.equal(siteY,1);
 assert.equal(s.run(),'N');assert.equal(s.resets(),0);assert.equal(s.state.terminalN,true);
 s.jq.ajax=function outer(){};s.advance(1000);assert.equal(s.run(),'N');assert.equal(s.requests.length,2);
});
test('pending request shares transport and unconfirmed abort never permits overlap',()=>{
 const s=setup();s.run();assert.equal(s.run(),'IN_FLIGHT');s.requests[0].abort=()=>{};s.advance(121);
 assert.equal(s.run(),'IN_FLIGHT_STALE');assert.equal(s.requests.length,1);
});
test('late aborted callbacks cannot reset timers or overwrite a newer N',()=>{
 const s=setup();s.run();s.advance(121);assert.equal(s.run(),'REQUEST_TIMEOUT');s.advance(61);s.run();
 s.requests[1].success('N');s.requests[0].lateSuccess('Y');assert.equal(s.run(),'N');assert.equal(s.resets(),0);
 assert.equal(s.state.requestId,2);assert.equal(s.state.serverResult,'N');
});
test('restored direct ajax original is rebound and requires new owned Y immediately',()=>{
 const s=setup();s.run();s.requests[0].success('Y');assert.equal(s.run(),'Y');const old=s.jq.ajax;s.jq.ajax=s.originalAjax;
 assert.equal(s.run(),'STARTED');assert.notEqual(s.jq.ajax,old);assert.equal(s.requests.length,2);
 assert.equal(s.state.wrapperRepaired,true);assert.equal(s.state.wrapperInstalled,true);
 s.requests[1].success('Y');assert.equal(s.run(),'Y');assert.equal(s.resets(),2);
 assert.equal(s.state.diagnosticEvents.some(e=>e.code==='BINDING_REPAIRED'),true);
});
test('rebinding during flight preserves ownership and site callbacks before new owned Y',()=>{
 const s=setup();s.run();s.jq.ajax=s.originalAjax;assert.equal(s.run(),'IN_FLIGHT');assert.equal(s.requests.length,1);
 let calls=0;s.jq.ajax({url:'/sessionExtension.do',success(){calls++}});s.requests[0].success('Y');assert.equal(calls,1);
 assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);s.requests[1].success('Y');assert.equal(s.run(),'Y');
});
test('unknown outer wrapper is preserved without nesting or unrequested transport',()=>{
 const s=setup();s.run();s.requests[0].success('Y');const own=s.jq.ajax;
 const outer=function(...args){return own.apply(this,args)};s.jq.ajax=outer;
 assert.equal(s.run(),'BINDING_UNAVAILABLE');assert.equal(s.jq.ajax,outer);
 assert.equal(s.run(),'BINDING_UNAVAILABLE');assert.equal(s.requests.length,1);
 let callback=0;s.jq.ajax({url:'/sessionExtension.do',success(){callback++}});s.requests[1].success('N');
 assert.equal(callback,1);assert.equal(s.run(),'N');
});
test('unknown replacement recovers when its owner restores known original',()=>{
 const s=setup();s.run();s.requests[0].success('Y');s.jq.ajax=function replacement(){};
 assert.equal(s.run(),'BINDING_UNAVAILABLE');s.jq.ajax=s.originalAjax;assert.equal(s.run(),'STARTED');
 s.requests[1].success('Y');assert.equal(s.run(),'Y');
});
test('unwritable ajax fails with no transport or invented success',()=>{
 const s=setup();Object.defineProperty(s.jq,'ajax',{writable:false});assert.equal(s.run(),'BINDING_UNAVAILABLE');
 assert.equal(s.requests.length,0);assert.equal(s.state.wrapperInstalled,false);assert.equal(s.jq.ajax,s.originalAjax);
});
test('partial installation rolls back original ajax and prior marker descriptors',()=>{
 const s=setup();Object.defineProperty(s.jq,'__oneClickAjaxWrapperV3',{value:null,writable:false,configurable:false});
 assert.equal(s.run(),'BINDING_UNAVAILABLE');assert.equal(s.jq.ajax,s.originalAjax);
 assert.equal(s.jq.__oneClickAjaxWrapperV3,null);assert.equal(Object.hasOwn(s.jq,'__oneClickAjaxPolicyV4'),false);
 assert.equal(Object.hasOwn(s.jq,'__oneClickOriginalAjaxV3'),false);assert.equal(s.requests.length,0);
});
test('missing jQuery reports unavailable and retains an observed N',()=>{
 const s=setup();s.context.jQuery=undefined;s.context.$=undefined;assert.equal(s.run(),'NO_JQUERY');
 s.state.result='N';assert.equal(s.run(),'N');
});
for(const [name,makeApp,result] of [
 ['absent app',()=>undefined,'Y_RESET_UNAVAILABLE'],
 ['missing reset',s=>s.makeApp({available:false}),'Y_RESET_UNAVAILABLE'],
 ['reset exception',s=>s.makeApp({throws:true}),'Y_RESET_FAILED'],
 ['zero display',s=>s.makeApp({confirm:false}),'Y_RESET_UNCONFIRMED'],
 ['unreadable display',s=>s.makeApp({lookupThrows:true}),'Y_RESET_UNCONFIRMED'],
 ['invalid display',s=>s.makeApp({label:'50분 99초'}),'Y_RESET_UNCONFIRMED'],
 ['unknown configured time',s=>s.makeApp({configured:null}),'Y_RESET_UNCONFIRMED'],
 ['positive display but no reset',s=>({...s.makeApp({label:'10분 00초'}),callAppMethod(){}}),'Y_RESET_UNCONFIRMED']
])test('server Y with '+name+' never becomes Y_RECENT and can recover',()=>{
 const s=setup();s.context.window.voMainApp=makeApp(s);s.run();s.requests[0].success('Y');
 assert.equal(s.run(),result);assert.equal(s.run(),result);assert.equal(s.state.serverResult,'Y');
 assert.equal(s.state.timerResetResult,result);assert.equal(s.requests.length,1);
 assert.equal(s.state.diagnosticEvents.some(e=>e.code==='TIMER_'+result.slice(2)),true);
 s.advance(61);s.context.window.voMainApp=s.makeApp();assert.equal(s.run(),'STARTED');
 s.requests[1].success('Y');assert.equal(s.run(),'Y');
});
test('response uses current app, and later replacement forces a new owned Y',()=>{
 const s=setup();s.context.window.voMainApp=undefined;s.run();s.context.window.voMainApp=s.makeApp();
 s.requests[0].success('Y');assert.equal(s.run(),'Y');s.context.window.voMainApp=s.makeApp();
 assert.equal(s.run(),'STARTED');s.requests[1].success('Y');assert.equal(s.run(),'Y');
});
test('app replaced during reset cannot confirm old display',()=>{
 const s=setup();const app=s.makeApp(),reset=app.callAppMethod;
 app.callAppMethod=function(...args){reset.apply(this,args);s.context.window.voMainApp=s.makeApp()};
 s.context.window.voMainApp=app;s.run();s.requests[0].success('Y');assert.equal(s.run(),'Y_RESET_UNCONFIRMED');
});
test('disposed app cannot reuse cached success or confirm new reset',()=>{
 const s=setup();s.run();s.requests[0].success('Y');assert.equal(s.run(),'Y');s.context.window.voMainApp.disposed=true;
 assert.equal(s.run(),'STARTED');s.requests[1].success('Y');assert.equal(s.run(),'Y_RESET_UNAVAILABLE');
});
test('zero display invalidates cached Y without silently resetting it',()=>{
 const s=setup();s.run();s.requests[0].success('Y');assert.equal(s.run(),'Y');
 s.context.window.voMainApp.lookup=()=>({value:'00분 00초'});assert.equal(s.run(),'Y_RESET_UNCONFIRMED');
 assert.equal(s.resets(),1);assert.equal(s.requests.length,1);
});
test('hidden pages repeat actual server renewal over four hours',()=>{
 const s=setup({hidden:true});for(let minute=0;minute<241;minute++){
  const result=s.run();if(result==='STARTED')s.requests.at(-1).success('"Y"');else assert.equal(result==='Y'||result==='Y_RECENT',true);
  s.advance(60);
 }
 assert.equal(s.context.document.hidden,true);assert.equal(s.requests.length,25);assert.equal(s.resets(),25);
 assert.equal(s.state.diagnosticEvents.length,16);
});
test('diagnostics contain only fixed codes and numeric measurements',()=>{
 const s=setup();s.run();s.requests[0].error(503);assert.equal(s.run(),'HTTP_503');s.advance(61);s.run();
 s.requests[1].success('<html>private account</html>');assert.equal(s.run(),'AUTH_RESPONSE');
 const codes=new Set(['BINDING_INSTALLED','BINDING_REPAIRED','BINDING_FAILED','REQUEST_START','RESPONSE_Y','RESPONSE_N',
  'RESPONSE_ERROR','TIMER_RESET_OK','TIMER_RESET_UNAVAILABLE','TIMER_RESET_FAILED','TIMER_RESET_UNCONFIRMED','REQUEST_NOT_TRACKED']);
 for(const event of s.state.diagnosticEvents){assert.deepEqual(Object.keys(event).sort(),['at','code','remaining','requestId']);
  assert.equal(codes.has(event.code),true);assert.equal(Number.isSafeInteger(event.at),true);
  assert.equal(Number.isSafeInteger(event.requestId),true);assert.equal(event.remaining===null||Number.isSafeInteger(event.remaining),true)}
 assert.doesNotMatch(JSON.stringify(s.state.diagnosticEvents),/private|account|html|https/);
});
test('pending V2 keeps separate state and requires new owned Y after completion',()=>{
 const s=setup();const legacyRequest={done(){return this},fail(){return this}};
 const legacy={inFlight:true,startedAt:s.now,completedAt:0,result:null,reported:false,request:legacyRequest};
 s.context.__oneClickNiceServerKeepAliveV2=legacy;assert.equal(s.run(),'LEGACY_IN_FLIGHT');assert.equal(s.requests.length,0);
 assert.equal(s.jq.ajax({url:'/sessionExtension.do'}),legacyRequest);legacy.inFlight=false;legacy.completedAt=s.now;legacy.result='Y';
 assert.equal(s.run(),'STARTED');assert.notEqual(s.state,legacy);s.requests[0].success('Y');assert.equal(s.run(),'Y');
 legacy.result='N';assert.equal(s.run(),'Y_RECENT');
});
test('stale V2 blocks retries until actual completion, including N',()=>{
 const s=setup();const legacy={inFlight:true,startedAt:1,completedAt:0,result:null,reported:false,request:{abort(){}}};
 s.context.__oneClickNiceServerKeepAliveV2=legacy;assert.equal(s.run(),'LEGACY_IN_FLIGHT_STALE');assert.equal(s.requests.length,0);
 legacy.inFlight=false;legacy.completedAt=s.now;legacy.result='N';assert.equal(s.run(),'N');assert.equal(s.requests.length,0);
});
test('real shipped V3 wrapper upgrades without stacking and preserves pending callback',()=>{
 const s=setup();assert.equal(s.runLegacy(),'STARTED');const old=s.jq.ajax;
 assert.equal(s.run(),'IN_FLIGHT');assert.notEqual(s.jq.ajax,old);assert.equal(s.requests.length,1);
 let called=0;s.jq.ajax({url:'/sessionExtension.do',success(){called++}});s.requests[0].success('Y');assert.equal(called,1);
 assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);s.requests[1].success('Y');assert.equal(s.run(),'Y');assert.equal(s.resets(),2);
});
test('real shipped V3 N survives upgrade without request',()=>{
 const s=setup();s.runLegacy();s.requests[0].success('N');assert.equal(s.run(),'N');assert.equal(s.requests.length,1);assert.equal(s.resets(),0);
});
test('outer wrapper around shipped V3 remains intact during upgrade',()=>{
 const s=setup();s.runLegacy();s.requests[0].success('Y');const old=s.jq.ajax;
 const outer=function(...args){return old.apply(this,args)};s.jq.ajax=outer;
 assert.equal(s.run(),'BINDING_UNAVAILABLE');assert.equal(s.jq.ajax,outer);assert.equal(s.requests.length,1);
});
test('real shipped V2 wrapper upgrades directly and waits for its pending request',()=>{
 const s=setup();assert.equal(s.runLegacyV2(),'STARTED');const old=s.jq.ajax;
 assert.equal(s.run(),'LEGACY_IN_FLIGHT');assert.notEqual(s.jq.ajax,old);assert.equal(s.requests.length,1);
 let calls=0;s.jq.ajax({url:'/sessionExtension.do',success(){calls++}});s.requests[0].success('Y');
 assert.equal(calls,1);assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
 s.requests[1].success('Y');assert.equal(s.run(),'Y');assert.equal(s.resets(),2);
});
test('real shipped V2 terminal N survives upgrade and never resets the timer',()=>{
 const s=setup();s.runLegacyV2();s.requests[0].success('N');assert.equal(s.run(),'N');
 assert.equal(s.requests.length,1);assert.equal(s.resets(),0);
});
test('jQuery object replacement preserves an existing request before requiring fresh ownership',()=>{
 const s=setup();s.run();const newJquery={ajax:s.originalAjax};s.context.jQuery=newJquery;s.context.$=newJquery;
 assert.equal(s.run(),'IN_FLIGHT');assert.equal(s.requests.length,1);s.requests[0].success('Y');
 assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);s.requests[1].success('Y');assert.equal(s.run(),'Y');
});

// Frozen previously shipped V3 script for upgrade regressions.
const legacyV3Script="(()=>{\n  const stateKey='__oneClickNiceServerKeepAliveV3';\n  const successIntervalMs=10*60*1000;\n  const retryIntervalMs=60*1000;\n  const staleRequestMs=2*60*1000;\n  const now=Date.now();\n  const jquery=globalThis.jQuery||globalThis.$;\n  if(!jquery||typeof jquery.ajax!=='function')return 'NO_JQUERY';\n\n  const getState=()=>{\n    const state=globalThis[stateKey]||(globalThis[stateKey]={\n      inFlight:false,\n      startedAt:0,\n      completedAt:0,\n      result:null,\n      reported:false,\n      request:null,\n      legacyImported:false\n    });\n    state.requestSequence=Number(state.requestSequence||0);\n    state.requestId=Number(state.requestId||0);\n    return state;\n  };\n  const resetTimer=()=>{\n    const mainApp=window.voMainApp;\n    if(mainApp?.hasAppMethod?.('setSessionTimerInit'))\n      mainApp.callAppMethod('setSessionTimerInit');\n  };\n\n  if(!jquery.__oneClickOriginalAjaxV3){\n    const originalAjax=jquery.__oneClickOriginalAjaxV2||jquery.ajax;\n    jquery.__oneClickOriginalAjaxV3=originalAjax;\n    jquery.ajax=function(first,second){\n      const settings=typeof first==='string'\n        ?Object.assign({},second||{},{url:first})\n        :Object.assign({},first||{});\n      const url=String(settings.url||'');\n      if(!url.includes('/sessionExtension.do'))\n        return originalAjax.apply(this,arguments);\n\n      const userSuccess=settings.success;\n      const userError=settings.error;\n      const userComplete=settings.complete;\n      const context=settings.context||settings;\n      const callCallbacks=(callbacks,args)=>{\n        const list=Array.isArray(callbacks)?callbacks:[callbacks];\n        for(const callback of list){\n          if(typeof callback!=='function')continue;\n          try{callback.apply(context,args);}catch{}\n        }\n      };\n      const classifyFailure=(xhr,textStatus)=>{\n        const reason=String(textStatus||'').toLowerCase();\n        if(reason==='timeout')return 'REQUEST_TIMEOUT';\n        if(reason==='abort')return 'REQUEST_ABORTED';\n        const status=Number(xhr?.status||0);\n        return status>0?`HTTP_${status}`:'NETWORK_ERROR';\n      };\n      const shared=getState();\n      const legacyState=globalThis.__oneClickNiceServerKeepAliveV2;\n      const pendingState=shared.inFlight\n        ?shared\n        :(legacyState?.inFlight?legacyState:null);\n      if(pendingState){\n        pendingState.request?.done?.(function(data,textStatus,xhr){\n          callCallbacks(userSuccess,[data,textStatus,xhr]);\n          callCallbacks(userComplete,[xhr,textStatus]);\n        });\n        pendingState.request?.fail?.(function(xhr,textStatus,errorThrown){\n          callCallbacks(userError,[xhr,textStatus,errorThrown]);\n          callCallbacks(userComplete,[xhr,textStatus]);\n        });\n        return pendingState.request;\n      }\n\n      let finished=false;\n      const requestId=++shared.requestSequence;\n      const finish=result=>{\n        if(finished)return;\n        finished=true;\n        if(shared.requestId!==requestId)return;\n        shared.inFlight=false;\n        shared.result=result;\n        shared.completedAt=Date.now();\n        shared.reported=false;\n        shared.request=null;\n        if(result==='Y'){\n          try{resetTimer();}catch{}\n        }\n      };\n\n      shared.inFlight=true;\n      shared.startedAt=Date.now();\n      shared.completedAt=0;\n      shared.result=null;\n      shared.reported=false;\n      shared.requestId=requestId;\n      shared.ownerSource=settings.__oneClickSource==='program'?'program':'site';\n\n      const recordSuccess=result=>{\n        const raw=String(result??'').trim();\n        let normalized=raw;\n        try{\n          const parsed=JSON.parse(raw);\n          if(typeof parsed==='string')normalized=parsed.trim();\n        }catch{}\n        finish(normalized==='Y'||normalized==='N'\n          ?normalized\n          :(/<!doctype|<html|로그인|login/i.test(raw)\n            ?'AUTH_RESPONSE':'UNEXPECTED_RESPONSE'));\n      };\n      settings.success=function(result,...rest){\n        recordSuccess(result);\n        callCallbacks(userSuccess,[result,...rest]);\n      };\n      settings.error=function(...args){\n        finish(classifyFailure(args[0],args[1]));\n        callCallbacks(userError,args);\n      };\n      settings.complete=function(...args){\n        callCallbacks(userComplete,args);\n      };\n\n      try{\n        const request=originalAjax.call(this,settings);\n        // beforeSend cancellation can settle jqXHR without option callbacks.\n        // Deferred handlers also observe completion when site callbacks throw.\n        if(shared.inFlight)shared.request=request;\n        request?.done?.(recordSuccess);\n        request?.fail?.((xhr,textStatus)=>finish(classifyFailure(xhr,textStatus)));\n        return request;\n      }catch{\n        finish('REQUEST_EXCEPTION');\n        return null;\n      }\n    };\n  }\n\n  const state=getState();\n  const legacy=globalThis.__oneClickNiceServerKeepAliveV2;\n  if(legacy&&!state.legacyImported){\n    if(legacy.inFlight){\n      return now-Number(legacy.startedAt||now)>staleRequestMs\n        ?'LEGACY_IN_FLIGHT_STALE':'LEGACY_IN_FLIGHT';\n    }\n    state.legacyImported=true;\n    if(legacy.completedAt&&legacy.result){\n      state.completedAt=Number(legacy.completedAt);\n      state.result=String(legacy.result);\n      state.reported=Boolean(legacy.reported);\n    }\n  }\n  if(state.inFlight){\n    if(now-state.startedAt<=staleRequestMs)return 'IN_FLIGHT';\n    const request=state.request;\n    // Abort the old transport before allowing any retry. Never overlap requests.\n    if(typeof request?.abort!=='function')return 'IN_FLIGHT_STALE';\n    try{request.abort('timeout');}catch{return 'IN_FLIGHT_STALE';}\n    if(state.inFlight){\n      const settled=request.state?.();\n      if(settled!=='rejected'&&settled!=='resolved')return 'IN_FLIGHT_STALE';\n      state.inFlight=false;\n      state.request=null;\n      state.result='REQUEST_TIMEOUT';\n      state.completedAt=now;\n      state.reported=false;\n    }\n  }\n\n  if(state.completedAt&&state.result){\n    if(state.result==='N')return 'N';\n    if(!state.reported){\n      state.reported=true;\n      return state.result;\n    }\n    const waitMs=state.result==='Y'?successIntervalMs:retryIntervalMs;\n    if(now-state.completedAt<waitMs)\n      return state.result==='Y'?'Y_RECENT':state.result;\n  }\n\n  jquery.ajax({\n    async:true,\n    timeout:staleRequestMs,\n    dataType:'text',\n    type:'post',\n    url:'/sessionExtension.do',\n    __oneClickSource:'program'\n  });\n  return 'STARTED';\n})()";

// Frozen V2 script from ffea748 for direct upgrades.
const legacyV2Script="\n            (()=>{\n              const stateKey='__oneClickNiceServerKeepAliveV2';\n              const successIntervalMs=10*60*1000;\n              const retryIntervalMs=60*1000;\n              const staleRequestMs=10*60*1000;\n              const now=Date.now();\n              const jquery=globalThis.jQuery||globalThis.$;\n              if(!jquery||typeof jquery.ajax!=='function')return 'NO_JQUERY';\n\n              const getState=()=>globalThis[stateKey]||(globalThis[stateKey]={\n                inFlight:false,\n                startedAt:0,\n                completedAt:0,\n                result:null,\n                reported:false,\n                request:null\n              });\n              const mainApp=window.voMainApp;\n              const canResetTimer=!!mainApp\n                &&typeof mainApp.hasAppMethod==='function'\n                &&mainApp.hasAppMethod('setSessionTimerInit')\n                &&typeof mainApp.callAppMethod==='function';\n\n              if(!jquery.__oneClickOriginalAjaxV2){\n                const originalAjax=jquery.ajax;\n                jquery.__oneClickOriginalAjaxV2=originalAjax;\n                jquery.ajax=function(first,second){\n                  const settings=typeof first==='string'\n                    ?Object.assign({},second||{},{url:first})\n                    :Object.assign({},first||{});\n                  const url=String(settings.url||'');\n                  if(!url.includes('/sessionExtension.do'))\n                    return originalAjax.apply(this,arguments);\n\n                  const shared=getState();\n                  if(shared.inFlight)return shared.request;\n\n                  const userSuccess=settings.success;\n                  const userError=settings.error;\n                  const userComplete=settings.complete;\n                  const finish=result=>{\n                    shared.inFlight=false;\n                    shared.result=result;\n                    shared.completedAt=Date.now();\n                    shared.reported=false;\n                    shared.request=null;\n                    if(result==='Y'&&canResetTimer){\n                      try{mainApp.callAppMethod('setSessionTimerInit');}catch{}\n                    }\n                  };\n\n                  shared.inFlight=true;\n                  shared.startedAt=Date.now();\n                  shared.completedAt=0;\n                  shared.result=null;\n                  shared.reported=false;\n\n                  settings.success=function(result,...rest){\n                    const raw=String(result??'').trim();\n                    let normalized=raw;\n                    try{\n                      const parsed=JSON.parse(raw);\n                      if(typeof parsed==='string')normalized=parsed.trim();\n                    }catch{}\n                    finish(normalized==='Y'||normalized==='N'\n                      ?normalized\n                      :'UNEXPECTED_RESPONSE');\n                    if(typeof userSuccess==='function')\n                      userSuccess.apply(this,[result,...rest]);\n                  };\n                  settings.error=function(...args){\n                    finish('NETWORK_ERROR');\n                    if(typeof userError==='function')userError.apply(this,args);\n                  };\n                  settings.complete=function(...args){\n                    if(typeof userComplete==='function')userComplete.apply(this,args);\n                  };\n\n                  try{\n                    const request=originalAjax.call(this,settings);\n                    shared.request=request;\n                    return request;\n                  }catch{\n                    finish('REQUEST_EXCEPTION');\n                    return null;\n                  }\n                };\n              }\n\n              const state=getState();\n              if(state.inFlight)\n                return now-state.startedAt>staleRequestMs?'IN_FLIGHT_STALE':'IN_FLIGHT';\n\n              if(state.completedAt&&state.result){\n                if(state.result==='Y'&&!state.reported){\n                  state.reported=true;\n                  return 'Y';\n                }\n                const waitMs=state.result==='Y'?successIntervalMs:retryIntervalMs;\n                if(now-state.completedAt<waitMs)\n                  return state.result==='Y'?'Y_RECENT':state.result;\n              }\n\n              jquery.ajax({\n                async:true,\n                dataType:'text',\n                type:'post',\n                url:'/sessionExtension.do'\n              });\n              return 'STARTED';\n            })()\n            ";
