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
  const request={options,done(fn){done.push(fn);if(state==='resolved')fn('Y');return this},
   fail(fn){fail.push(fn);if(state==='rejected')fn();return this},state:()=>state,
   abort(){state='rejected';fail.forEach(fn=>fn());},
   success(value){state='resolved';options.success(value);done.forEach(fn=>fn(value))}};
  requests.push(request);return request;
 }};
 const context=vm.createContext({jQuery:jq,Date:{now:()=>now},window:{voMainApp:{hasAppMethod:()=>true,callAppMethod:()=>resets++}}});
 return {run:()=>vm.runInContext(script,context),advance:s=>now+=s*1000,requests,resets:()=>resets,context};
}
test('beforeSend cancellation without option callbacks releases in-flight state',()=>{
 const s=setup({cancel:true});assert.equal(s.run(),'STARTED');assert.equal(s.run(),'NETWORK_ERROR');
 s.advance(61);assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
});
test('hung transport is aborted before retry; retry waits one minute',()=>{
 const s=setup();s.run();s.advance(121);assert.equal(s.run(),'NETWORK_ERROR');
 assert.equal(s.requests[0].state(),'rejected');assert.equal(s.requests.length,1);
 s.advance(61);assert.equal(s.run(),'STARTED');assert.equal(s.requests.length,2);
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
