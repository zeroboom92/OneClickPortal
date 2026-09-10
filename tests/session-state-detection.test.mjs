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
 assert.equal(vm.runInNewContext(script,{document:{...complete,body:{innerText:'업무포털 메인'}}}),'ACTIVE');
});

test('nice exact logout route is recognized without broad logout substring matching',()=>{
 const script=extract('NiceLoggedOutExpression');
 const document={body:{innerText:''}};
 assert.equal(vm.runInNewContext(script,{location:{pathname:'/executeNeisLogout.do'},document}),true);
 assert.equal(vm.runInNewContext(script,{location:{pathname:'/ui/logoutHistory.do'},document}),false);
 assert.equal(vm.runInNewContext(script,{location:{pathname:'/main.do'},document}),false);
});
