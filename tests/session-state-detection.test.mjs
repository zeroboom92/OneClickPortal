import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../PortalWorkflowController.cs',import.meta.url),'utf8');
const extract=name=>source.split(`private static string ${name}()`)[1].split('"""')[1];

test('portal logout message is recognized only after loading completes',()=>{
 const script=extract('PortalSessionStateScript');
 const complete={readyState:'complete',body:{innerText:'정보보호를 위해 업무포털을 로그아웃하였습니다.'},querySelectorAll:()=>[]};
 assert.equal(vm.runInNewContext(script,{document:complete}),'LOGGED_OUT');
 assert.equal(vm.runInNewContext(script,{document:{...complete,readyState:'loading'}}),'LOADING');
 assert.equal(vm.runInNewContext(script,{document:{...complete,body:{innerText:'업무포털 메인'}}}),'OFFICIAL_BUTTON_NOT_VISIBLE');
});

test('hidden frame logout text does not expire the visible portal',()=>{
 const script=extract('PortalSessionStateScript');
 const hiddenFrame={hidden:true,contentDocument:{body:{innerText:'업무포털을 로그아웃하였습니다.'},querySelectorAll:()=>[]}};
 const document={readyState:'complete',body:{innerText:'업무포털 메인'},querySelectorAll:selector=>selector==='iframe,frame'?[hiddenFrame]:[]};
 assert.equal(vm.runInNewContext(script,{document}),'OFFICIAL_BUTTON_NOT_VISIBLE');
});

test('nice exact logout route is recognized without broad logout substring matching',()=>{
 const script=extract('NiceLoggedOutExpression');
 const document={body:{innerText:''}};
 assert.equal(vm.runInNewContext(script,{location:{pathname:'/executeNeisLogout.do'},document}),true);
 assert.equal(vm.runInNewContext(script,{location:{pathname:'/ui/logoutHistory.do'},document}),false);
 assert.equal(vm.runInNewContext(script,{location:{pathname:'/main.do'},document}),false);
});

function node(children=[],options={}){
 return {
  nodeType:1,tagName:'DIV',hidden:false,
  childNodes:children.map(child=>typeof child==='string'?{nodeType:3,textContent:child}:child),
  style:{display:'block',visibility:'visible',opacity:'1'},
  getAttribute(name){return this[name]??null},
  getBoundingClientRect(){return {width:100,height:24,right:100,bottom:24}},
  ...options
 };
}
function edufinePage(children){
 const all=[];
 const document={readyState:'complete',body:node(children),defaultView:{getComputedStyle:e=>e.style},
  querySelectorAll:()=>all.filter(e=>e.tagName==='IFRAME')};
 const attach=(element,parent)=>{
  element.ownerDocument=document;element.parentElement=parent;all.push(element);
  for(const child of element.childNodes)if(child.nodeType===1)attach(child,element);
 };
 attach(document.body,null);return document;
}
function edufineState(document,timerText='20:00',extra={}){
 const form={fv_nowUseEndTime:1200,divTopGrp:{form:{staUseTime:{text:timerText}}}};
 return JSON.parse(vm.runInNewContext(extract('EdufineSessionStateScript'),{
  document,application:{mainframe:{MainVFrameSet:{TopFrame:{form}}}},...extra
 }));
}

test('hidden old shutdown text does not expire a live Edufine page',()=>{
 for(const options of [
  {hidden:true},{'aria-hidden':'true'},
  {style:{display:'none',visibility:'visible',opacity:'1'}},
  {style:{display:'block',visibility:'hidden',opacity:'1'}},
  {style:{display:'block',visibility:'visible',opacity:'0'}}
 ]){
  const document=edufinePage([node([node(['사용시간이 종료되었습니다'])],options),node(['결재대기'])]);
  // Even if an aggregate fallback contains stale content, only rendered text may expire it.
  document.body.innerText='';document.body.textContent='사용시간이 종료되었습니다';
  const state=edufineState(document);
  assert.equal(state.remainingSeconds,1200);assert.equal(state.visibleShutdown,false);assert.equal(state.expired,false);
 }
});

test('only visible same-origin frame shutdown messages expire Edufine',()=>{
 const frame=node([],{tagName:'IFRAME',contentDocument:edufinePage([node(['사용시간이 종료되었습니다'])])});
 let document=edufinePage([frame]);
 assert.equal(edufineState(document).visibleShutdown,true);
 frame.hidden=true;assert.equal(edufineState(document).visibleShutdown,false);
 frame.hidden=false;document=edufinePage([node([frame],{hidden:true})]);
 assert.equal(edufineState(document).visibleShutdown,false);
 const inaccessible=node([],{tagName:'IFRAME'});
 Object.defineProperty(inaccessible,'contentDocument',{get(){throw new Error('cross-origin')}});
 assert.equal(edufineState(edufinePage([inaccessible])).visibleShutdown,false);
});

test('visible shutdown message is detected through split labels and zero-size ancestors',()=>{
 const wrapper=node([node(['사용시간이 ']),node(['종료되었습니다'])],{
  getBoundingClientRect:()=>({width:0,height:0,right:0,bottom:0})
 });
 const state=edufineState(edufinePage([wrapper]));
 assert.equal(state.visibleShutdown,true);assert.equal(state.expired,true);
});

test('zero timer is distinct from a visible shutdown and malformed or loading timers stay unknown',()=>{
 const document=edufinePage([node(['결재대기'])]);
 const zero=edufineState(document,'0:00');
  assert.equal(zero.remainingSeconds,0);assert.equal(zero.visibleShutdown,false);
  assert.equal(zero.internalRemainingSeconds,1200);
  assert.equal(zero.expired,false);
  for(const remaining of [0,undefined]){
   const form={fv_nowUseEndTime:remaining,divTopGrp:{form:{staUseTime:{text:'0:00'}}}};
   assert.equal(edufineState(document,'0:00',{application:{gv_topFrame:{form}}}).expired,true);
  }
  assert.equal(edufineState(edufinePage([node(['사용시간이 종료되었습니다'])]),'0:00').expired,true);
 for(const timer of ['',':','00:99','text','-1:00'])assert.equal(edufineState(document,timer).remainingSeconds,null);
 document.readyState='loading';
 assert.equal(edufineState(document,'0:00').expired,false);
});

test('session state and renewal inspect the same preferred top-frame form',()=>{
 const preferred={fv_nowUseEndTime:900,divTopGrp:{form:{staUseTime:{text:'15:00'}}}};
 const obsolete={fv_nowUseEndTime:0,divTopGrp:{form:{staUseTime:{text:'0:00'}}}};
 const state=edufineState(edufinePage([]),'0:00',{
  application:{gv_topFrame:{form:preferred},mainframe:{MainVFrameSet:{TopFrame:{form:obsolete}}}}
 });
 assert.equal(state.remainingSeconds,900);assert.equal(state.internalRemainingSeconds,900);assert.equal(state.expired,false);
});
