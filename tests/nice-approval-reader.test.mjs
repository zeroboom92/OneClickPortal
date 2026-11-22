import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';

const source = fs.readFileSync(new URL('../NiceApprovalReader.cs', import.meta.url), 'utf8');
const template = source.split('internal static string Script(')[1].split('=> $$"""')[1].split('""";')[0];
const cancelTemplate = source.split('internal static string CancelScript(')[1].split('=> $$"""')[1].split('""";')[0];
const host = 'jbe.neis.go.kr';
const office = 'P10';
const interpolate = (template,start,id) => template
  .replaceAll('{{JsonSerializer.Serialize(officeDomain)}}',JSON.stringify(host))
  .replaceAll('{{JsonSerializer.Serialize(officeCode)}}',JSON.stringify(office))
  .replaceAll('{{(startQuery ? "true" : "false")}}',String(start))
  .replaceAll('{{JsonSerializer.Serialize(requestId)}}',JSON.stringify(id));
const approval = (count='3',extra={}) => ({menuId:'AMWAM40012',menuNm:'미결/협조함',
  pgeId:'wam_woapm02_m00',callPage:'edu/cm/wam/woa/pm/wam_woapm02_m00',apvlCnt:count,...extra});

function fixture(options={}) {
  let now=1000;
  const requests=[], registered=new Set(), timers=new Map(), reads=[];
  const user={userId:'ACCOUNT-A',instCd:'SCHOOL-A',orgCd:'ORG-A',orgScCd:'S'};
  const original={action:'/approval.do',mediaType:'application/json',status:'IDLE',
    send(){throw new Error('The site submission must remain untouched.');},...options.original};
  const existingRows=Object.freeze([Object.freeze(approval('0'))]);
  const root={disposed:false,app:{id:'app/com/main/Index'},lookup(name){
    assert.equal(name,'subApproval','Only the original submission contract may be inspected.');
    return original;
  },register(value){registered.add(value);},unregister(value){registered.delete(value);}};
  const apps={root};
  class DataSet {
    constructor(id){this.id=id;this.rows=[];this.disposed=false;}
    parseData({columns,rows}){this.columns=columns.map(c=>c.name);this.rows=rows;}
    getRowCount(){return this.rows.length;}
    getValue(row,name){
      reads.push(name);assert.ok(['menuId','apvlCnt'].includes(name));return this.rows[row][name];
    }
    dispose(){this.disposed=true;}
  }
  class Submission {
    constructor(id){this.id=id;this.listeners=new Map();this.status='IDLE';this.succeeded=true;this.input=new Map();}
    addResponseData(data,append,alias){assert.equal(append,false);assert.equal(alias,'dsApproval');this.output=data;}
    getRequestData(name){return this.input.get(name);}
    addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
    removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
    emit(name){
      const event={control:this,preventDefault:()=>{this.prevented=true;}};
      for(const fn of [...(this.listeners.get(name)??[])])fn(event);
    }
    isSuccess(){return this.succeeded;}
    send(){
      assert.ok(registered.has(this));assert.equal(this.action,'/approval.do');
      assert.equal(this.mediaType,'application/json');assert.equal(this.method,'post');
      assert.equal(this.withCredentials,true);assert.equal(this.timeout,18000);
      assert.equal(this.input.size,0,'The reader must not invent request auth or query data.');
      // The actual global module/submit filter supplies auth before local observers.
      if(!options.missingAuthFilter)this.input.set('_AUTHDATA',{data:{getValue(name){
        return options.wrongAuth?'OTHER':user[name];
      }}});
      this.emit('before-submit');
      if(this.prevented)return false;
      if(options.sendThrows)throw new Error('Network failure');
      this.status='SENDING';requests.push(this);
      if(options.sendFalse)return false;
      return true;
    }
    abort(){this.aborted=true;this.status='DONE';this.emit('submit-done');}
    dispose(){this.disposed=true;}
  }
  class ClockDate extends Date {static now(){return now;}}
  const location={protocol:'https:',hostname:host,origin:`https://${host}`,pathname:'/jsp/main.jsp',href:`https://${host}/jsp/main.jsp`};
  const document={readyState:'complete',body:{innerText:''}};
  const context=vm.createContext({location,document,URL,Date:ClockDate,Math,
    cpr:{data:{DataSet},protocols:{Submission},core:{Platform:{INSTANCE:{getAllRunningAppInstances:()=>apps}}}},
    createCommonUtil:()=>({Auth:{getUserInfo:owner=>{assert.equal(owner,root);return {getValue:name=>user[name]};}}}),
    setTimeout(fn,delay){const id=timers.size+1;timers.set(id,{fn,at:now+delay});return id;},
    clearTimeout(id){timers.delete(id);},
    fetch(){throw new Error('Direct fetch is forbidden.');},XMLHttpRequest(){throw new Error('Direct XHR is forbidden.');},
  });
  return {context,user,root,apps,original,existingRows,requests,registered,timers,location,document,reads,
    run(start=true,id='READ-A'){
      return JSON.parse(JSON.stringify(vm.runInContext(interpolate(template,start,id),context,{timeout:1000})));
    },
    cancel(id='READ-A'){vm.runInContext(interpolate(cancelTemplate,false,id),context,{timeout:1000});},
    complete(rows=[approval()],extra={}){
      const sub=requests.at(-1);assert.ok(sub);
      sub.xhr={readyState:extra.readyState??4,status:extra.http??200,
        responseText:extra.raw??JSON.stringify(extra.response??{ErrorCode:0,dsApproval:rows})};
      sub.output.rows=extra.datasetRows??rows;
      sub.succeeded=extra.success??true;sub.status='DONE';
      if(extra.receive!==false)sub.emit('receive');
      if(extra.error)sub.emit('submit-error');
      if(extra.successEvent!==false)sub.emit('submit-success');
      if(extra.done!==false)sub.emit('submit-done');
      sub.status='IDLE';return sub;
    },
    advance(ms,fire=true){now+=ms;if(fire)for(const {fn,at} of [...timers.values()])if(at<=now)fn();},
    clean(){
      assert.equal(registered.size,0);assert.equal(timers.size,0);
      for(const sub of requests){assert.equal(sub.disposed,true);assert.equal(sub.output.disposed,true);
        assert.equal([...sub.listeners.values()].reduce((n,v)=>n+v.size,0),0);}
      assert.equal(this.context.__oneClickNiceApprovalReadV1?.current??null,null);
      assert.deepEqual(existingRows,[approval('0')]);
    },
  };
}

test('reads only a fresh successful isolated approval response, including real zero',()=>{
  for(const count of ['0','3',0,2147483647]){
    const f=fixture();assert.equal(f.run().state,'Started');
    assert.equal(f.run(false).state,'Started','Initial display zero must not become a completed read.');
    f.complete([approval(count),{menuId:'AMWAM40013',apvlCnt:'999',privateText:'PRIVATE-DOCUMENT'}]);
    assert.deepEqual(f.run(false),{state:'Available',count:Number(count),
      scope:JSON.stringify([office,'ACCOUNT-A','SCHOOL-A','ORG-A','S'])});
    assert.equal(JSON.stringify(f.context.__oneClickNiceApprovalReadV1).includes('PRIVATE-DOCUMENT'),false);
    f.clean();
  }
});

test('each new check sends a new request and ignores previous success and site initial zero',()=>{
  const f=fixture();f.run();f.complete([approval('5')]);assert.equal(f.run(false).count,5);f.clean();
  assert.equal(f.run(true,'READ-B').state,'Started');assert.equal(f.run(false,'READ-B').state,'Started');
  assert.equal(f.requests.length,2);f.complete([approval('6')]);assert.equal(f.run(false,'READ-B').count,6);f.clean();
});

test('does not duplicate pending reads, compete with the site query, or cancel a different lease',()=>{
  const f=fixture();f.run();assert.equal(f.run(true,'READ-B').state,'Busy');assert.equal(f.requests.length,1);
  f.cancel('READ-B');assert.equal(f.requests[0].aborted,undefined);f.complete();f.clean();
  const active=fixture({original:{status:'SENDING'}});assert.equal(active.run().state,'Busy');assert.equal(active.requests.length,0);
});

test('requires the ordinary auth filter and rejects mismatched organization',()=>{
  for(const options of [{missingAuthFilter:true},{wrongAuth:true}]){
    const f=fixture(options);assert.equal(f.run().state,'QueryFailed');assert.equal(f.requests.length,0);f.clean();
  }
});

test('only the exact authenticated host and official approval endpoint may be read',()=>{
  for(const action of ['https://other.invalid/approval.do','/approval.do?x=1','/approval.do#x',
    '/requestApproval.do','https://user:pass@jbe.neis.go.kr/approval.do']){
    const f=fixture({original:{action}});assert.equal(f.run().state,'CountUnavailable');assert.equal(f.requests.length,0);
  }
  for(const change of [f=>f.location.protocol='http:',f=>f.location.hostname='jbe.neis.go.kr.example.com',
    f=>f.document.readyState='loading',f=>f.original.mediaType='text/plain']){
    const f=fixture();change(f);assert.equal(f.run().state,'CountUnavailable');assert.equal(f.requests.length,0);
  }
});

test('fails closed for HTTP, transport, login, framework, incomplete and stale failures',()=>{
  for(const extra of [{http:500},{http:302},{readyState:3},{raw:'<html>login</html>'},
    {response:{ErrorCode:-1,dsApproval:[approval('0')]}},{response:{success:false}},
    {receive:false},{successEvent:false},{success:false},{error:true}]){
    const f=fixture();f.run();f.complete([approval()],extra);assert.equal(f.run(false).state,'QueryFailed');f.clean();
  }
  const old=fixture();old.run();old.advance(21000,false);old.complete();assert.equal(old.run(false).state,'QueryFailed');old.clean();
});

test('rejects missing, duplicate, invalid, and conflicting approval values without partial count',()=>{
  for(const rows of [[],[{menuId:'AMWAM40013',apvlCnt:'1'}],[approval(),approval()],
    [approval('')],[approval('-1')],[approval('1,000')],[approval('1e2')],[approval('1.2')],
    [approval(null)],[approval(true)],[approval(2147483648)],[approval('3',{menuNm:'공람함'})],
    [approval('3',{pgeId:'other'})],[approval('3',{callPage:'other'})],[approval(),null]]){
    const f=fixture();f.run();f.complete(rows);assert.equal(f.run(false).state,'QueryFailed');f.clean();
  }
  for(const datasetRows of [[],[approval('9')],[approval(),approval()]]){
    const f=fixture();f.run();f.complete([approval()],{datasetRows});assert.equal(f.run(false).state,'CountUnavailable');f.clean();
  }
});

test('response row objects and arrays support only the verified count output',()=>{
  const f=fixture();f.run();f.complete([approval('4')],{response:{ErrorCode:'0',dsApproval:{rows:[approval('4')]}}});
  assert.equal(f.run(false).count,4);assert.deepEqual([...new Set(f.reads)].sort(),['apvlCnt','menuId']);f.clean();
});

test('account, school, organization, root disposal, and ambiguous roots invalidate in-flight data',()=>{
  for(const change of [f=>f.user.userId='ACCOUNT-B',f=>f.user.instCd='SCHOOL-B',f=>f.user.orgCd='ORG-B',
    f=>f.root.disposed=true,f=>f.apps.second={disposed:false,app:{id:'app/com/main/Index'}}]){
    const f=fixture();f.run();change(f);f.complete();assert.equal(f.run(false).state,'ScopeUnavailable');f.clean();
  }
  const missing=fixture();missing.user.userId='';assert.equal(missing.run().state,'ScopeUnavailable');assert.equal(missing.requests.length,0);
});

test('timeout, cancellation, thrown send, and framework cancellation release private resources',()=>{
  for(const mode of ['timeout','cancel','sendThrows','sendFalse']){
    const f=fixture({[mode]:true});f.run();
    if(mode==='timeout')f.advance(20000);if(mode==='cancel')f.cancel();
    assert.equal(f.run(false).state,mode==='cancel'?'ScopeUnavailable':'QueryFailed');f.clean();
    if(mode==='timeout'||mode==='cancel')assert.equal(f.requests[0].aborted,true);
  }
});

test('an identity switch while polling retires the owned request and stale completion cannot revive it',()=>{
  const f=fixture();f.run();const old=f.requests[0];f.user.userId='ACCOUNT-B';
  assert.equal(f.run(false).state,'ScopeUnavailable');assert.equal(old.aborted,true);f.clean();
  assert.equal(f.run(true,'READ-B').state,'Started');old.emit('submit-success');old.emit('submit-done');
  assert.equal(f.run(false,'READ-B').state,'Started');f.complete([approval('2')]);
  assert.equal(f.run(false,'READ-B').count,2);f.clean();
});

test('reader never mutates menus, existing submissions, global filters, workflow, or user controls',()=>{
  assert.doesNotMatch(source,/ActivateTarget|MaximizeTarget|BringToFront|setSelectedTabItem|openMenuItem|\.click\(|EventBus|\.addFilter|\.removeFilter|setRequestEncoder|fetch\(|XMLHttpRequest|requestApproval/);
  assert.match(source,/CancelScript\(office\.NiceDomain, requestId\)/);
  assert.match(source,/TimeSpan\.FromSeconds\(2\)/);
  assert.match(source,/uri\.Scheme == Uri\.UriSchemeHttps/);
  assert.match(source,/targets\.Length != 1/);
});

test('actual C# parser, exact page selection, polling and cancellation preserve ownership',
  {timeout:120000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'oneclick-nice-approval-reader-'));
    const projectRoot=fileURLToPath(new URL('../',import.meta.url));
    const xml=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;');
    try{
      await writeFile(join(directory,'Probe.csproj'),`<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup><Compile Include="${xml(resolve(projectRoot,'NiceApprovalReader.cs'))}" Link="NiceApprovalReader.cs" /></ItemGroup>
      </Project>`);
      await writeFile(join(directory,'Program.cs'),String.raw`
using System.Text.Json;
using BrowserThumbnailPrototype;
void Check(bool value,string message){if(!value)throw new Exception(message);}
NiceApprovalReadResult Parse(string json)=>NiceApprovalReader.Parse(JsonDocument.Parse(json).RootElement,"TARGET-A");
foreach(var json in new[]{"null","[]","{}","{\"state\":0}","{\"state\":\"Unknown\"}",
  "{\"state\":\"Available\"}","{\"state\":\"Available\",\"count\":-1,\"scope\":\"s\"}",
  "{\"state\":\"Available\",\"count\":\"3\",\"scope\":\"s\"}",
  "{\"state\":\"Available\",\"count\":1.5,\"scope\":\"s\"}",
  "{\"state\":\"Available\",\"count\":1,\"scope\":\" \"}"})
  Check(Parse(json).State==NiceApprovalReadState.CountUnavailable,"Malformed result accepted.");
foreach(var state in Enum.GetValues<NiceApprovalReadState>().Where(state=>state!=NiceApprovalReadState.Available)){
  var result=Parse(JsonSerializer.Serialize(new{state=state.ToString(),scope="private",count=42}));
  Check(result.State==state&&result.Count is null&&result.Scope is null,"Failed response retained private data.");
}
Check(Parse(JsonSerializer.Serialize(new{state="Available",count=0,scope=new string('x',2049)})).Count is null,"Long scope accepted.");
Check(Parse("{\"state\":\"Available\",\"count\":0,\"scope\":\"scope\"}").Count==0,"Real zero rejected.");
var office=new EducationOffice("jbe.neis.go.kr","P10");
DevToolsDiscovery.Targets=[];
Check((await NiceApprovalReader.ReadAsync(9222,office,default)).State==NiceApprovalReadState.PageMissing,"Missing page accepted.");
DevToolsDiscovery.Targets=[new("A","page","http://jbe.neis.go.kr/"),new("B","page","https://jbe.neis.go.kr.example.com/")];
Check((await NiceApprovalReader.ReadAsync(9222,office,default)).State==NiceApprovalReadState.PageMissing,"Wrong host accepted.");
DevToolsDiscovery.Targets=[new("A","page","https://jbe.neis.go.kr/"),new("B","page","https://jbe.neis.go.kr/")];
Check((await NiceApprovalReader.ReadAsync(9222,office,default)).State==NiceApprovalReadState.MultiplePages,"Ambiguous pages accepted.");
Check(DevToolsSession.Connections==0,"Connected to ambiguous or wrong page.");
DevToolsDiscovery.Targets=[new("TARGET-A","page","https://JBE.NEIS.GO.KR/"),new("FRAME","iframe","https://jbe.neis.go.kr/")];
DevToolsSession.Enqueue("{\"state\":\"Started\"}");
DevToolsSession.Enqueue("{\"state\":\"Available\",\"count\":3,\"scope\":\"scope\"}");
var available=await NiceApprovalReader.ReadAsync(9222,office,default);
Check(available.Count==3&&available.SourceId=="TARGET-A"&&DevToolsSession.Scripts.Count==2,"Polling failed.");
Check(DevToolsSession.Disposals==1&&DevToolsSession.Resumes==1,"Session cleanup failed.");
var firstScript=DevToolsSession.Scripts[0];
var marker="const requestId = ";var start=firstScript.IndexOf(marker)+marker.Length;
var lease=firstScript[start..firstScript.IndexOf(';',start)];
Check(DevToolsSession.Scripts[1].Contains("const requestId = "+lease),"Polling lease changed.");
DevToolsSession.Scripts.Clear();
using var cancellation=new CancellationTokenSource();
DevToolsSession.OnEvaluate=(script,token)=>{if(DevToolsSession.Scripts.Count==1)cancellation.Cancel();};
DevToolsSession.Enqueue("{\"state\":\"Started\"}");DevToolsSession.Enqueue("null");
try{await NiceApprovalReader.ReadAsync(9222,office,cancellation.Token);throw new Exception("Cancellation was ignored.");}
catch(OperationCanceledException){}
Check(DevToolsSession.Scripts.Count==2&&DevToolsSession.Scripts[1].Contains("observation?.requestId ==="),"Owned cleanup script was not run.");
Check(DevToolsSession.CleanupTokenActive,"Cleanup reused canceled operation token.");
Check(DevToolsSession.Disposals==2,"Canceled session was not disposed.");
DevToolsSession.OnEvaluate=null;DevToolsSession.Scripts.Clear();
DevToolsSession.Enqueue("{\"state\":\"Busy\"}");
Check((await NiceApprovalReader.ReadAsync(9222,office,default)).State==NiceApprovalReadState.Busy,"Busy read failed.");
Check(DevToolsSession.Scripts.Count==1,"Busy caller canceled someone else's read.");
Console.WriteLine("PASS: parser, exact target, fresh polling, privacy, independent cancellation cleanup, lease ownership");
namespace BrowserThumbnailPrototype{
  internal sealed record EducationOffice(string NiceDomain,string Code);
  internal sealed record DevToolsTarget(string Id,string Type,string Url);
  internal static class DevToolsDiscovery{
    internal static IReadOnlyList<DevToolsTarget> Targets=[];
    internal static Task<IReadOnlyList<DevToolsTarget>> GetTargetsAsync(int port,CancellationToken token)=>Task.FromResult(Targets);
  }
  internal sealed class DevToolsSession:IAsyncDisposable{
    internal static int Connections,Resumes,Disposals;
    internal static Queue<JsonElement> Results=new();
    internal static List<string> Scripts=[];
    internal static Action<string,CancellationToken>? OnEvaluate;
    internal static bool CleanupTokenActive;
    internal static void Enqueue(string json)=>Results.Enqueue(JsonDocument.Parse(json).RootElement.Clone());
    internal static Task<DevToolsSession> ConnectAsync(int port,string id,CancellationToken token){Connections++;return Task.FromResult(new DevToolsSession());}
    internal Task ResumeBackgroundPageAsync(CancellationToken token){Resumes++;return Task.CompletedTask;}
    internal Task<JsonElement> EvaluateAsync(string script,CancellationToken cancellationToken){
      Scripts.Add(script);OnEvaluate?.Invoke(script,cancellationToken);
      if(script.Contains("observation?.requestId ==="))CleanupTokenActive=!cancellationToken.IsCancellationRequested;
      return Task.FromResult(Results.Dequeue());
    }
    public ValueTask DisposeAsync(){Disposals++;return ValueTask.CompletedTask;}
  }
}
`);
      const result=await promisify(execFile)('dotnet',['run','--project',join(directory,'Probe.csproj'),'--configuration','Release'],
        {timeout:110000,maxBuffer:1024*1024}).catch(error=>{throw new Error(error.stdout+'\n'+error.stderr);});
      assert.match(result.stdout,/PASS: parser, exact target, fresh polling, privacy, independent cancellation cleanup, lease ownership/);
    }finally{
      assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('oneclick-nice-approval-reader-'));
      await rm(directory,{recursive:true,force:true});
    }
  });
