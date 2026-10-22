import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';

const source = fs.readFileSync(new URL('../NiceAbsencePendingReader.cs', import.meta.url), 'utf8');
const template = source.split('internal static string Script(')[1].split('=> $$"""')[1].split('""";')[0];
const domain = 'jbe.neis.go.kr';
const office = 'P10';
const script = start => template
  .replace('{{JsonSerializer.Serialize(officeDomain)}}', JSON.stringify(domain))
  .replace('{{JsonSerializer.Serialize(officeCode)}}', JSON.stringify(office))
  .replace('{{(startQuery ? "true" : "false")}}', String(start));
const absenceApp = 'edu/sa/eds/eaa/ae/eds_eaaae03_m01';
const scope = JSON.stringify([office, 'ACCOUNT-A', 'SCHOOL-A']);
const pending = (id, extra = {}) => ({shlCd:'SCHOOL-A',ayr:'2026',abeDclrId:id,
  eduActPrcsStsCd:'01',stuFlnm:'PRIVATE-STUDENT',abeRsnCn:'PRIVATE-REASON',...extra});
const menuPath = ['학급담임', '교육활동신청관리', '출결관리', '결석신고서관리'];
function makeMenus() {
  const rows = menuPath.map((name, index) => ({
    MENU_ID:index === 3 ? 'AMEDS40531' : `MENU-${index}`,MENU_NM:name,
    V_MENU_ID:`CLASS-${index}`,V_UP_MENU_ID:index ? `CLASS-${index-1}` : '',
    CALL_PAGE:index === 3 ? absenceApp : '',SHOW_YN:'Y',menuUseYn:'Y',inqAccesAuthYn:'Y',
    menuId:'AMEDS40531',pgeId:absenceApp,pgePathNm:absenceApp,ayr:'2026',shlDptCd:'',
    shlDptWrkCd:'EDS',rptdYn:'1',dataAuthScCd:'Y',dataAuthAplcnYn:'Y',orgCd:'ORG-A',orgScCd:'S',
  }));
  // The real menu contains another absence menu. Only the exact class-teacher path is valid.
  rows.push({...rows[0],MENU_NM:'다른업무',V_MENU_ID:'OTHER-0'});
  rows.push({...rows[3],V_MENU_ID:'OTHER-ABSENCE',V_UP_MENU_ID:'OTHER-0'});
  return rows;
}

function fixture(options = {}) {
  let now = 1_000_000;
  let sequence = 0;
  const user = {userId:'ACCOUNT-A',instCd:'SCHOOL-A',ayr:'2026',Ayr:'2026',
    shlCrseScCd:'2',shlKndScCd:'01',orgCd:'ORG-A',orgScCd:'S',...options.user};
  const menus = options.menus ?? makeMenus();
  const menuColumns = [...new Set(menus.flatMap(Object.keys))];
  const requests = [], pendingRequests = [], registered = new Set(), reads = [];
  const existingSearch = Object.freeze({stuFlnm:'USER-FILTER',clsCd:'USER-CLASS',abeBgngDt:'20261001'});
  const existingRows = Object.freeze([Object.freeze({abeDclrId:'EDITED-ROW',chk:'1',edited:true})]);
  const menu = {getColumnNames:() => [...menuColumns],getRowCount:() => menus.length,
    getValue:(row,name) => menus[row][name],getRowData:row => ({...menus[row]})};
  const root = {disposed:false,app:{id:'app/com/main/Index'},lookup(name) {
    assert.equal(name,'dsAllMenu','The background reader must not access existing search, grid or MDI controls.');
    return menu;
  },register(value) {registered.add(value);},unregister(value) {registered.delete(value);}};
  const apps = {root};
  if (options.open !== false) apps.absence = {disposed:false,app:{id:absenceApp},lookup() {
    throw new Error('The existing absence application must not be read or changed.');
  }};
  class DataMap {
    constructor(id) {this.id=id;this.values={};this.disposed=false;}
    parseData({columns}) {this.columns=columns.map(item=>item.name);}
    build(values) {this.values={...values};}
    getValue(name) {return this.values[name];}
    getDatas() {return {...this.values};}
    dispose() {this.disposed=true;}
  }
  class DataSet {
    constructor(id) {this.id=id;this.rows=[];this.disposed=false;}
    parseData({columns,rows=[]}) {this.columns=columns.map(item=>item.name);this.rows=rows.map(row=>({...row}));}
    getRowCount() {return this.rows.length;}
    getValue(row,name) {
      reads.push(name);
      assert.ok(['cd','ayrAuthType','shlCd','ayr','abeDclrId','eduActPrcsStsCd'].includes(name),
        `The reader requested unneeded student data: ${name}`);
      return this.rows[row][name];
    }
    dispose() {this.disposed=true;}
  }
  class Submission {
    constructor(id) {this.id=id;this.input=new Map();this.output=null;this.outputs=new Map();this.listeners=new Map();
      this.attributes={};this.status='IDLE';this.disposed=false;this.succeeded=true;}
    userAttr(name,value) {if (arguments.length>1) this.attributes[name]=value;return this.attributes[name];}
    addRequestData(data,alias=data.id,payload) {this.input.set(alias,{data,payload});}
    getRequestData(name) {return this.input.get(name);}
    addResponseData(data,add,alias) {assert.equal(add,false);this.outputs.set(alias,{data,alias});}
    addEventListener(name,handler) {
      if (!this.listeners.has(name)) this.listeners.set(name,new Set());
      this.listeners.get(name).add(handler);
    }
    removeEventListener(name,handler) {this.listeners.get(name)?.delete(handler);}
    emit(name) {
      const event={control:this,preventDefault:()=>{this.prevented=true;}};
      for (const handler of [...(this.listeners.get(name)??[])]) handler(event);
    }
    isSuccess() {return this.succeeded;}
    setRequestEncoder() {throw new Error('The verified CPR data envelope must not be replaced.');}
    send() {
      assert.ok(registered.has(this));
      assert.equal(this.mediaType,'application/json');
      assert.equal(this.withCredentials,true);
      assert.equal(this.attributes._menuAuthChk,'Y');
      // Models the verified site module/submit filter. The reader cannot create or replace it.
      if (!options.missingAuthFilter) {
        const supplied=new DataMap('_AUTHDATA');
        supplied.build(this.input.get('AUTHDATA').data.getDatas());
        if (options.wrongAuth) supplied.values.V_MENU_ID='WRONG-MENU';
        this.addRequestData(supplied);
      }
      this.emit('before-submit');
      if (this.prevented) return false;
      this.status='SENDING';
      const body=Object.fromEntries([...this.input].map(([name,{data}])=>
        [name,data instanceof DataMap?data.getDatas():data.rows.map(row=>({...row}))]));
      // Actual normal UI and isolated read requests retain CPR's standard data envelope.
      const wire={data:body};
      assert.deepEqual(Object.keys(wire),['data']);
      const encoded=wire.data;
      assert.equal(encoded.dmSearch.shlCd,'SCHOOL-A');
      for (const name of ['dsSwcAuthList','dsClsCd'])
        if (this.input.has(name)) assert.equal(this.input.get(name).payload,'all');
      for (const right of encoded.dsSwcAuthList??[]) {
        assert.deepEqual(Object.keys(right),['authType','tenseType','cmdType','refValue','bindColumn','firstCdType']);
        assert.equal(typeof right.refValue,'string');assert.equal(right.firstCdType,null);assert.ok(right.bindColumn);
      }
      const currentRight=encoded.dsSwcAuthList?.find(row=>!row.refValue);
      const command=currentRight?.cmdType;
      this.output=this.outputs.get(command?'ds'+command[0].toUpperCase()+command.slice(1):'dsStdntListForAbe');
      assert.ok(this.output);
      const request={sub:this,action:this.action,search:this.input.get('dmSearch').data.getDatas(),
        command,
        auth:this.input.get('_AUTHDATA').data.getDatas(),
        rights:this.input.get('dsSwcAuthList')?.data.rows.map(row=>({...row})),
        classes:this.input.get('dsClsCd')?Array.from(this.input.get('dsClsCd').data.rows,row=>({...row})):undefined};
      assert.ok(['/swc_cmm_at00_000.do','/eds_eaa_ae03_002.do'].includes(request.action));
      requests.push(request);pendingRequests.push(request);
      return true;
    }
    abort() {this.aborted=true;this.status='DONE';}
    dispose() {this.disposed=true;}
  }
  const location={protocol:'https:',hostname:domain,pathname:'/index.html',href:`https://${domain}/index.html`};
  const document={readyState:'complete',body:{innerText:''}};
  const context=vm.createContext({location,document,Date:{now:()=>now},Math,
    cpr:{data:{DataMap,DataSet},protocols:{Submission},core:{Platform:{INSTANCE:{getAllRunningAppInstances:()=>apps}}}},
    createCommonUtil:()=>({Auth:{getUserInfo:owner=>{assert.equal(owner,root);return {getValue:name=>user[name]};}}}),
    fetch(){throw new Error('Only verified CPR submissions are allowed.');},
    XMLHttpRequest(){throw new Error('Only verified CPR submissions are allowed.');},
  });
  const f={user,menus,menuColumns,menu,root,apps,requests,pendingRequests,registered,reads,context,location,document,
    existingSearch,existingRows,advance(ms){now+=ms;},
    run(start=true){return JSON.parse(JSON.stringify(vm.runInContext(script(start),context,{timeout:1000})));},
    complete(rows,extra={}) {
      const request=pendingRequests.shift();assert.ok(request,'No query is pending.');
      const sub=request.sub;
      let response=extra.response??{ErrorCode:0,[sub.output.alias]:rows};
      sub.xhr={responseText:extra.raw??JSON.stringify(response)};
      sub.output.data.rows=rows.map(row=>({...row}));
      if (extra.datasetRows) sub.output.data.rows=extra.datasetRows;
      sub.succeeded=extra.success??true;
      sub.status=extra.status??'DONE';
      sub.emit('receive');
      if (extra.error) sub.emit('submit-error');
      if (extra.done!==false) sub.emit('submit-done');
      return request;
    },
    drain(lists=[pending('A'),pending('B'),pending('C'),pending('DONE-A',{eduActPrcsStsCd:'02'}),
      pending('DONE-B',{eduActPrcsStsCd:'03'})],rights={}) {
      while (pendingRequests.length) {
        assert.ok(++sequence<300,'The reader did not terminate.');
        const request=pendingRequests[0];
        if (request.action==='/eds_eaa_ae03_002.do') {f.complete(typeof lists==='function'?lists(request):lists);continue;}
        const command=request.command;
        const supplied=rights[command];
        let rows=typeof supplied==='function'?supplied(request):supplied;
        if (!rows) rows=command==='swcOrgAyr'?[{cd:'2026',ayrAuthType:'SCA'}]
          :command==='swcOrgGrd'?[{cd:'3'}]
          :command==='swcOrgClsCd'?[{cd:request.search.grd+'01'},{cd:request.search.grd+'02'}]
          :command==='swcOrgOrdGrdDddepCd'?[{cd:'1/3/00685'}]:[{cd:'1'}];
        f.complete(rows);
      }
      return f.run(false);
    },
    assertClean() {
      assert.equal(registered.size,0,'Temporary submissions were left registered.');
      for (const request of requests) {
        assert.equal(request.sub.disposed,true);
        assert.equal([...request.sub.listeners.values()].reduce((sum,set)=>sum+set.size,0),0);
      }
      assert.deepEqual(existingSearch,{stuFlnm:'USER-FILTER',clsCd:'USER-CLASS',abeBgngDt:'20261001'});
      assert.equal(existingRows[0].edited,true);
    },
  };
  return f;
}

test('finds all three existing pending absences without opening or selecting their management page',()=>{
  for (const open of [true,false]) {
    const f=fixture({open});
    assert.equal(f.run(false).state,'SnapshotUnavailable');
    assert.equal(f.run().state,'Started');
    assert.equal(f.run().state,'Busy');
    assert.equal(f.run(false).state,'Started');
    const result=f.drain();
    assert.deepEqual(result,{state:'Available',scope,
      items:['A','B','C'].map(id=>JSON.stringify(['SCHOOL-A','2026',id]))});
    assert.equal(f.requests.length,4);
    assert.deepEqual(f.requests.map(request=>request.command??'list'),
      ['swcOrgAyr','swcOrgGrd','swcOrgClsCd','list']);
    const request=f.requests.at(-1);
    assert.equal(request.search.clsCd,'00');
    assert.equal(request.search.grd,'3');
    assert.equal(request.search.abeBgngDt,'20260301');
    assert.equal(request.search.abeEndDt,'20270228');
    for (const field of ['stuFlnm','stuInvlNo','clsNo','eduActPrcsStsCd','atrzStsCd','onlAplyYn'])
      assert.equal(request.search[field],'');
    assert.equal(request.auth.V_MENU_ID,'CLASS-3');
    assert.deepEqual(request.classes.map(row=>row.cd),['301','302']);
    assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
    f.assertClean();
  }
});

test('queries each authorized grade and deduplicates documents across the complete combined result',()=>{
  const f=fixture();f.run();
  const result=f.drain(request=>[pending('SAME'),pending(`GRADE-${request.search.grd}`)],
    {swcOrgGrd:[{cd:'1'},{cd:'2'}]});
  assert.equal(result.state,'Available');
  assert.deepEqual(result.items,['SAME','GRADE-1','GRADE-2'].map(id=>JSON.stringify(['SCHOOL-A','2026',id])));
  assert.deepEqual(f.requests.filter(request=>request.classes).map(request=>request.search.grd),['1','2']);
  f.assertClean();
});

test('ignores broad all-class/year entries and uses only the account-authorized concrete rows',()=>{
  const f=fixture();f.run();
  const result=f.drain([],{swcOrgAyr:[{cd:'2025'},{cd:'2026'}],swcOrgGrd:[{cd:''},{cd:'00'},{cd:'3'}],
    swcOrgClsCd:[{cd:''},{cd:'%'},{cd:'00'},{cd:'301'}]});
  assert.equal(result.state,'Available');assert.deepEqual(result.items,[]);
  assert.deepEqual(f.requests.at(-1).classes.map(row=>row.cd),['301']);f.assertClean();
});

test('checks the exact class-teacher path, permission and unambiguous menu authority',()=>{
  for (const change of [f=>{f.menus[3].inqAccesAuthYn='N';},f=>{f.menus[0].MENU_NM='학교관리';},
    f=>{f.menus.push({...f.menus[3]});},f=>{f.menus[3].CALL_PAGE='other/app';}]) {
    const f=fixture();change(f);assert.equal(f.run().state,'NotAuthorized');assert.equal(f.requests.length,0);
  }
  const f=fixture();f.menuColumns.splice(f.menuColumns.indexOf('dataAuthAplcnYn'),1);
  assert.equal(f.run().state,'SnapshotUnavailable');assert.equal(f.requests.length,0);
});

test('fails safely if the official menu-auth filter is missing or supplies another menu',()=>{
  for (const options of [{missingAuthFilter:true},{wrongAuth:true}]) {
    const f=fixture(options);assert.equal(f.run().state,'SnapshotUnavailable');
    assert.equal(f.requests.length,0);assert.equal(f.registered.size,0);
  }
});

test('rejects wrong hosts, unloaded pages, logout screens and ambiguous or missing root apps',()=>{
  for (const [change,state] of [
    [f=>{f.location.hostname=domain+'.example.com';},'SnapshotUnavailable'],
    [f=>{f.location.protocol='http:';},'SnapshotUnavailable'],
    [f=>{f.document.readyState='loading';},'SnapshotUnavailable'],
    [f=>{f.document.body.innerText='나이스를 로그아웃 하였습니다';},'ScopeUnavailable'],
    [f=>{f.location.pathname='/executeNeisLogout.do';},'ScopeUnavailable'],
    [f=>{delete f.apps.root;},'ScopeUnavailable'],
    [f=>{f.apps.other={...f.root};},'ScopeUnavailable'],
  ]) {const f=fixture();change(f);assert.equal(f.run().state,state);assert.equal(f.requests.length,0);}
});

test('requires a stable authenticated account, school, school kind, course and current school year',()=>{
  for (const user of [{userId:''},{instCd:''},{ayr:'2025'},{ayr:'',Ayr:''},{ayr:'NaN',Ayr:'NaN'},
    {shlKndScCd:''},{shlCrseScCd:'9'}]) {
    const f=fixture({user});assert.equal(f.run().state,'ScopeUnavailable');assert.equal(f.requests.length,0);
  }
});

test('a changed account or school invalidates an in-flight response instead of publishing old student keys',()=>{
  for (const field of ['userId','instCd','ayr','shlKndScCd','shlCrseScCd']) {
    const f=fixture();f.run();f.user[field]='CHANGED';f.complete([{cd:'2026'}]);
    assert.notEqual(f.run(false).state,'Available');assert.equal(f.requests.length,1);f.assertClean();
  }
});

test('returns no partial keys when a later grade query fails',()=>{
  const f=fixture();f.run();
  f.complete([{cd:'2026'}]);f.complete([{cd:'1'},{cd:'2'}]);
  f.complete([{cd:'101'}]);f.complete([{cd:'201'}]);f.complete([pending('FIRST-GRADE')]);
  assert.equal(f.run(false).state,'Started');
  f.complete([],{success:false});
  assert.deepEqual(f.run(false),{state:'QueryFailed'});f.assertClean();
});

test('rejects missing response datasets, application errors, malformed JSON and failed transport',()=>{
  for (const extra of [{response:{ErrorCode:0}},{response:{ErrorCode:-99999,dsSwcOrgAyr:[]}},
    {raw:'<html>login</html>'},{success:false},{error:true}]) {
    const f=fixture();f.run();f.complete([{cd:'2026'}],extra);
    assert.equal(f.run(false).state,'QueryFailed');f.assertClean();
  }
});

test('a truncated dataset cannot become an empty successful result',()=>{
  const f=fixture();f.run();f.complete([{cd:'2026'}],{datasetRows:[]});
  assert.equal(f.run(false).state,'SnapshotUnavailable');f.assertClean();
});

test('does not treat missing academic-year or class permissions as a zero pending count',()=>{
  for (const rights of [{swcOrgAyr:[{cd:'2025'}]},{swcOrgGrd:[]},{swcOrgClsCd:[]}]) {
    const f=fixture();f.run();assert.equal(f.drain([],rights).state,'NotAuthorized');
    assert.equal(f.requests.some(request=>request.classes),false);f.assertClean();
  }
});

test('rejects duplicate or malformed authorization rows',()=>{
  const duplicate=fixture();duplicate.run();
  assert.equal(duplicate.drain([],{swcOrgGrd:[{cd:'3'},{cd:'3'}]}).state,'SnapshotUnavailable');
  duplicate.assertClean();
  const malformed=fixture({user:{shlCrseScCd:'4'}});malformed.run();
  assert.equal(malformed.drain([],{swcOrgOrdGrdDddepCd:[{cd:'bad-composite'}]}).state,'SnapshotUnavailable');
  malformed.assertClean();
});

test('rejects invalid or cross-school/year records without returning valid prefixes',()=>{
  for (const row of [pending(''),pending('BAD',{shlCd:'OTHER-SCHOOL'}),pending('BAD',{ayr:'2025'}),
    pending('BAD',{eduActPrcsStsCd:'99'}),pending('A'.repeat(1025))]) {
    const f=fixture();f.run();assert.equal(f.drain([pending('GOOD'),row]).state,'SnapshotUnavailable');f.assertClean();
  }
});

test('supports course-specific authority chains and the official combined high-school grade code',()=>{
  for (const course of ['3','4','5']) {
    const f=fixture({user:{shlCrseScCd:course}});f.run();
    assert.equal(f.drain().state,'Available');
    const list=f.requests.find(request=>request.classes);
    if (course==='4') {
      assert.equal(list.search.ordGrdDddepCd,'1/3/00685');
      assert.equal(list.search.ordScCd,'1');assert.equal(list.search.grd,'3');assert.equal(list.search.dddepCd,'00685');
    }
    if (course==='3'||course==='4') assert.equal(list.search.dghtCrseScCd,'1');
    if (course==='5') assert.equal(list.search.shlCrseScCd,'1');
    f.assertClean();
  }
});

test('uses PRESENT authority for lifelong schools and includes the school-year leap day',()=>{
  const f=fixture({user:{shlKndScCd:'12',ayr:'2027',Ayr:'2027'}});f.run();
  assert.equal(f.requests[0].rights[0].tenseType,'PRESENT');
  assert.equal(f.requests[0].search.abeEndDt,'20280229');
  assert.equal(f.drain([],{swcOrgAyr:[{cd:'2027'}]}).state,'Available');f.assertClean();
});

test('a stalled request is never duplicated, and an exceeded deadline prevents subsequent queries',()=>{
  const f=fixture();f.run();f.advance(30000);
  assert.equal(f.run().state,'Busy');assert.equal(f.requests.length,1);
  f.complete([{cd:'2026'}]);assert.equal(f.run(false).state,'QueryFailed');
  assert.equal(f.requests.length,1);f.assertClean();
});

test('an idle request missing its completion event is retired safely and a later refresh can recover',()=>{
  const f=fixture();f.run();
  f.requests[0].sub.status='DONE';f.pendingRequests.length=0;f.advance(31000);
  assert.equal(f.run(false).state,'QueryFailed');f.assertClean();
  assert.equal(f.run().state,'Started');assert.equal(f.drain([]).state,'Available');f.assertClean();
});

test('a completed result can be refreshed without retaining temporary student datasets',()=>{
  const f=fixture();f.run();assert.equal(f.drain().items.length,3);f.assertClean();
  f.run();assert.equal(f.drain([pending('NEW')]).items.length,1);f.assertClean();
  assert.equal(f.requests.length,8);
  const observation=f.context.__oneClickAbsencePendingReadV1;
  assert.equal(observation.current,null);assert.equal(observation.jobs.length,0);
  assert.equal(JSON.stringify([...observation.items]).includes('PRIVATE'),false);
});

test('background source has only the two verified read endpoints and no menu, browser or task mutations',()=>{
  assert.doesNotMatch(source,/ActivateTarget|MaximizeTarget|BringToFront|setSelectedTabItem|openMenuItem|\.click\(|setAppProperty|EventBus|\.addFilter|\.removeFilter|setRequestEncoder|requestApproval|subStsChg/);
  const endpoints=[...source.matchAll(/'\/(\w+)\.do'/g)].map(match=>match[1]);
  assert.deepEqual(endpoints,['executeneislogout','swc_cmm_at00_000','eds_eaa_ae03_002']);
});

test('actual C# reader rejects incomplete snapshots and selects only one exact authenticated Nice target',
  {timeout:120_000}, async()=>{
    const directory=await mkdtemp(join(tmpdir(),'oneclick-absence-reader-'));
    const root=fileURLToPath(new URL('../',import.meta.url));
    const xml=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;');
    try {
      await writeFile(join(directory,'Probe.csproj'),`<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup><Compile Include="${xml(resolve(root,'NiceAbsencePendingReader.cs'))}" Link="NiceAbsencePendingReader.cs" /></ItemGroup>
      </Project>`);
      await writeFile(join(directory,'Program.cs'),String.raw`
using System.Text.Json;
using BrowserThumbnailPrototype;

void Check(bool value,string message) {if(!value) throw new Exception(message);}
AbsencePendingReadResult Parse(string json) => NiceAbsencePendingReader.Parse(JsonDocument.Parse(json).RootElement,"TARGET-A");
foreach(var json in new[]{"null","[]","{}","{\"state\":0}","{\"state\":\"Unknown\"}"})
  Check(Parse(json).State==AbsencePendingReadState.Busy,"Malformed state was accepted.");
foreach(var state in Enum.GetValues<AbsencePendingReadState>().Where(state=>state!=AbsencePendingReadState.Available)) {
  var result=Parse(JsonSerializer.Serialize(new {state=state.ToString(),scope="secret",items=new[]{"secret"}}));
  Check(result.State==state && result.Scope is null && result.Items is null,"Unavailable snapshot leaked input data.");
}
foreach(var json in new[]{"{\"state\":\"Available\"}","{\"state\":\"Available\",\"scope\":\" \" ,\"items\":[]}",
  "{\"state\":\"Available\",\"scope\":\"scope\",\"items\":[\"GOOD\",null]}",
  "{\"state\":\"Available\",\"scope\":\"scope\",\"items\":[42]}",
  "{\"state\":\"Available\",\"scope\":\"scope\",\"items\":[\" \" ]}"})
  Check(Parse(json).State==AbsencePendingReadState.SnapshotUnavailable,"Incomplete snapshot was accepted.");
Check(Parse(JsonSerializer.Serialize(new{state="Available",scope=new string('s',2049),items=Array.Empty<string>()})).Items is null,"Oversized scope accepted.");
Check(Parse(JsonSerializer.Serialize(new{state="Available",scope="scope",items=new[]{new string('i',2049)}})).Items is null,"Oversized item accepted.");
var available=Parse("{\"state\":\"Available\",\"scope\":\"scope\",\"items\":[\"A\",\"B\",\"C\"]}");
Check(available.State==AbsencePendingReadState.Available && available.Items!.Count==3
  && available.Items.All(item=>item.Summary==string.Empty) && available.SourceId=="TARGET-A","Complete snapshot lost keys.");
var office=new EducationOffice("jbe.neis.go.kr","jbe");
DevToolsDiscovery.Targets=[];
Check((await NiceAbsencePendingReader.ReadAsync(9223,office,default)).State==AbsencePendingReadState.PageMissing,"Missing page accepted.");
DevToolsDiscovery.Targets=[new("A","page","http://jbe.neis.go.kr/"),new("B","page","https://jbe.neis.go.kr.example.com/")];
Check((await NiceAbsencePendingReader.ReadAsync(9223,office,default)).State==AbsencePendingReadState.PageMissing,"Wrong origin accepted.");
DevToolsDiscovery.Targets=[new("A","page","https://jbe.neis.go.kr/"),new("B","page","https://jbe.neis.go.kr/")];
Check((await NiceAbsencePendingReader.ReadAsync(9223,office,default)).State==AbsencePendingReadState.MultiplePages,"Ambiguous pages accepted.");
Check(DevToolsSession.Connections==0,"Reader connected to an ambiguous or wrong page.");
DevToolsDiscovery.Targets=[new("TARGET-A","page","https://JBE.NEIS.GO.KR/"),new("FRAME","iframe","https://jbe.neis.go.kr/")];
DevToolsSession.Results.Enqueue(JsonDocument.Parse("{\"state\":\"Started\"}").RootElement.Clone());
DevToolsSession.Results.Enqueue(JsonDocument.Parse("{\"state\":\"Available\",\"scope\":\"scope\",\"items\":[\"A\"]}").RootElement.Clone());
var read=await NiceAbsencePendingReader.ReadAsync(9223,office,default);
Check(read.State==AbsencePendingReadState.Available && read.Items!.Count==1 && read.SourceId=="TARGET-A","Successful poll failed.");
Check(DevToolsSession.Connections==1 && DevToolsSession.Resumes==1 && DevToolsSession.Evaluations==2 && DevToolsSession.Disposals==1,"Session lifecycle failed.");
Console.WriteLine("PASS: exact target, unavailable snapshot, complete three-item snapshot, successful polling, privacy, cleanup");

namespace BrowserThumbnailPrototype {
  internal sealed record EducationOffice(string NiceDomain,string Code);
  internal sealed record NotificationSourceItem(string Id,string Summary);
  internal sealed record DevToolsTarget(string Id,string Type,string Url);
  internal static class DevToolsDiscovery {
    internal static IReadOnlyList<DevToolsTarget> Targets=[];
    internal static Task<IReadOnlyList<DevToolsTarget>> GetTargetsAsync(int port,CancellationToken token)=>Task.FromResult(Targets);
  }
  internal sealed class DevToolsSession : IAsyncDisposable {
    internal static int Connections,Resumes,Evaluations,Disposals;
    internal static Queue<JsonElement> Results=new();
    internal static Task<DevToolsSession> ConnectAsync(int port,string id,CancellationToken token) {Connections++;return Task.FromResult(new DevToolsSession());}
    internal Task ResumeBackgroundPageAsync(CancellationToken token) {Resumes++;return Task.CompletedTask;}
    internal Task<JsonElement> EvaluateAsync(string script,CancellationToken cancellationToken) {Evaluations++;return Task.FromResult(Results.Dequeue());}
    public ValueTask DisposeAsync() {Disposals++;return ValueTask.CompletedTask;}
  }
}`);
      const result=await promisify(execFile)('dotnet',['run','--project',join(directory,'Probe.csproj'),'--configuration','Release'],
        {timeout:110_000,maxBuffer:1024*1024}).catch(error=>{throw new Error(error.stdout+'\n'+error.stderr);});
      assert.match(result.stdout,/PASS: exact target, unavailable snapshot, complete three-item snapshot, successful polling, privacy, cleanup/);
    } finally {
      assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-absence-reader-'));
      await rm(directory,{recursive:true,force:true});
    }
  });
