import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../PortalWorkflowController.cs',import.meta.url),'utf8');
const script=source.split('private static string NiceServerSessionExtensionScript()')[1].split('"""')[1];
function setup({cancel=false}={}){
 let now=1000000, resets=0, requests=[];
 const jq={ajax(options){
  let state=cancel?'rejected':'pending',done=[],fail=[];
  const request={options,done(fn){done.push(fn);if(state==='resolved')fn('Y','success',this);return this},
   fail(fn){fail.push(fn);if(state==='rejected')fn({},'abort');return this},state:()=>state,
   abort(reason='abort'){state='rejected';fail.forEach(fn=>fn({},reason));},
   success(value){state='resolved';options.success(value);done.forEach(fn=>fn(value))}};
  requests.push(request);return request;
 }};
 const context=vm.createContext({jQuery:jq,Date:{now:()=>now},window:{voMainApp:{hasAppMethod:()=>true,callAppMethod:()=>resets++}}});
 return {run:()=>vm.runInContext(script,context),advance:s=>now+=s*1000,requests,resets:()=>resets,context};
}
test('beforeSend cancellation without option callbacks releases in-flight state',()=>{
 const s=setup({cancel:true});assert.equal(s.run(),'STARTED');assert.equal(s.run(),'REQUEST_ABORTED');
 s.advance(61);assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
});
test('hung transport is aborted before retry; retry waits one minute',()=>{
 const s=setup();s.run();s.advance(121);assert.equal(s.run(),'REQUEST_TIMEOUT');
 assert.equal(s.requests[0].state(),'rejected');assert.equal(s.requests.length,1);
 s.advance(61);assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
});
test('duplicate site caller receives the shared request success callback',()=>{
 const s=setup();s.run();let duplicateSuccess=0,duplicateComplete=0;
 const shared=s.context.jQuery.ajax({url:'/sessionExtension.do',success(){duplicateSuccess++},complete(){duplicateComplete++}});
 assert.equal(shared,s.requests[0]);assert.equal(s.requests.length,1);
 s.requests[0].success('Y');assert.equal(duplicateSuccess,1);assert.equal(duplicateComplete,1);
});
test('callback arrays, context, complete, and callback exceptions are isolated',()=>{
 const s=setup();s.run();const context={name:'caller'};let success=0,complete=0;
 s.context.jQuery.ajax({url:'/sessionExtension.do',context,
  success:[function(){throw new Error('caller failure')},function(){assert.equal(this,context);success++}],
  complete:[function(){assert.equal(this,context);complete++}]});
 s.requests[0].success('Y');assert.equal(success,1);assert.equal(complete,1);
 assert.equal(s.run(),'Y');
});
test('Y resets once and shares the success interval',()=>{
 const s=setup();s.run();s.requests[0].success('Y');assert.equal(s.resets(),1);
 assert.equal(s.run(),'Y');assert.equal(s.run(),'Y_RECENT');assert.equal(s.requests.length,1);
});
test('N remains terminal even after retry interval',()=>{
 const s=setup();s.run();s.requests[0].success('N');s.advance(1000);
 assert.equal(s.run(),'N');assert.equal(s.run(),'N');assert.equal(s.requests.length,1);assert.equal(s.resets(),0);
});
test('pending request is deduplicated and unconfirmed abort never permits overlap',()=>{
 const s=setup();s.run();assert.equal(s.run(),'IN_FLIGHT');
 s.requests[0].abort=()=>{};s.advance(121);assert.equal(s.run(),'IN_FLIGHT_STALE');assert.equal(s.requests.length,1);
});
test('timer is resolved when response arrives, including a replaced main app',()=>{
 const s=setup();s.context.window.voMainApp=undefined;s.run();let reset=0;
 s.context.window.voMainApp={hasAppMethod:()=>true,callAppMethod:()=>reset++};
 s.requests[0].success('Y');assert.equal(reset,1);
});
test('a pending V2 request blocks V3 without sharing its mutable state object',()=>{
 const s=setup();const legacyRequest={done(){return this},fail(){return this}};
 const legacy={inFlight:true,startedAt:1000000,completedAt:0,result:null,reported:false,request:legacyRequest};
 s.context.__oneClickNiceServerKeepAliveV2=legacy;
 assert.equal(s.run(),'LEGACY_IN_FLIGHT');assert.equal(s.requests.length,0);
 assert.equal(s.context.jQuery.ajax({url:'/sessionExtension.do'}),legacyRequest);
 assert.equal(s.requests.length,0);
 legacy.inFlight=false;legacy.completedAt=1000001;legacy.result='Y';legacy.reported=false;
 assert.equal(s.run(),'Y');legacy.result='N';
 assert.equal(s.run(),'Y_RECENT');assert.notEqual(s.context.__oneClickNiceServerKeepAliveV3,legacy);
});
test('a stale V2 request remains blocked until legacy completion is observed',()=>{
 const s=setup();s.context.__oneClickNiceServerKeepAliveV2={
  inFlight:true,startedAt:1,completedAt:0,result:null,reported:false,request:{abort(){}}
 };
 assert.equal(s.run(),'LEGACY_IN_FLIGHT_STALE');assert.equal(s.requests.length,0);
});
