using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal enum AbsencePendingReadState
{
    Available, PageMissing, MultiplePages, ScopeUnavailable, Busy, QueryFailed,
    SnapshotUnavailable, NotAuthorized,
}

internal sealed record AbsencePendingReadResult(
    IReadOnlyList<NotificationSourceItem>? Items, string? Scope,
    AbsencePendingReadState State, string? SourceId = null);

internal static class NiceAbsencePendingReader
{
    public static async Task<AbsencePendingReadResult> ReadAsync(int port, EducationOffice office,
        CancellationToken cancellationToken, bool refresh = true)
    {
        var targets = (await DevToolsDiscovery.GetTargetsAsync(port, cancellationToken))
            .Where(target => target.Type == "page"
                && Uri.TryCreate(target.Url, UriKind.Absolute, out var uri)
                && uri.Scheme == Uri.UriSchemeHttps
                && string.Equals(uri.Host, office.NiceDomain, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (targets.Length == 0) return new(null, null, AbsencePendingReadState.PageMissing);
        if (targets.Length != 1) return new(null, null, AbsencePendingReadState.MultiplePages);
        await using var session = await DevToolsSession.ConnectAsync(port, targets[0].Id, cancellationToken);
        await session.ResumeBackgroundPageAsync(cancellationToken);
        var value = await session.EvaluateAsync(Script(office.NiceDomain, office.Code, refresh),
            cancellationToken: cancellationToken);
        for (var attempt = 0; IsStarted(value) && attempt < 120; attempt++)
        {
            await Task.Delay(250, cancellationToken);
            value = await session.EvaluateAsync(Script(office.NiceDomain, office.Code, false),
                cancellationToken: cancellationToken);
        }
        return Parse(value, targets[0].Id);
    }

    private static bool IsStarted(JsonElement value) => value.ValueKind == JsonValueKind.Object
        && value.TryGetProperty("state", out var state) && state.ValueKind == JsonValueKind.String
        && state.GetString() == "Started";

    internal static AbsencePendingReadResult Parse(JsonElement value, string sourceId)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("state", out var stateValue)
            || stateValue.ValueKind != JsonValueKind.String
            || !Enum.TryParse<AbsencePendingReadState>(stateValue.GetString(), out var state) || !Enum.IsDefined(state))
            return new(null, null, AbsencePendingReadState.Busy, sourceId);
        if (state != AbsencePendingReadState.Available) return new(null, null, state, sourceId);
        if (!value.TryGetProperty("scope", out var scopeValue) || scopeValue.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(scopeValue.GetString()) || scopeValue.GetString()!.Length > 2048
            || !value.TryGetProperty("items", out var rows) || rows.ValueKind != JsonValueKind.Array)
            return new(null, null, AbsencePendingReadState.SnapshotUnavailable, sourceId);
        List<NotificationSourceItem> items = [];
        foreach (var row in rows.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(row.GetString())
                || row.GetString()!.Length > 2048)
                return new(null, null, AbsencePendingReadState.SnapshotUnavailable, sourceId);
            items.Add(new(row.GetString()!, string.Empty));
        }
        return new(items.AsReadOnly(), scopeValue.GetString(), state, sourceId);
    }

    // Official 2026-10-22 contracts: Swc Util.doAuthList and the absence-list
    // submission. All maps, datasets and submissions below are private temporary
    // objects. No menu, MDI selection, existing search, grid or browser state changes.
    internal static string Script(string officeDomain, string officeCode, bool startQuery) => $$"""
        (() => {
          try {
            const host = {{JsonSerializer.Serialize(officeDomain)}};
            const office = {{JsonSerializer.Serialize(officeCode)}};
            const startQuery = {{(startQuery ? "true" : "false")}};
            const stateKey = '__oneClickAbsencePendingReadV1';
            const result = state => ({state});
            if (location.protocol !== 'https:' || location.hostname !== host
                || document.readyState !== 'complete') return result('SnapshotUnavailable');
            if (String(location.pathname).toLowerCase().endsWith('/executeneislogout.do')
                || String(document.body?.innerText || '').replace(/\s/g,'').includes('나이스를로그아웃하였습니다'))
              return result('ScopeUnavailable');
            const platform = globalThis.cpr?.core?.Platform?.INSTANCE;
            if (!platform?.getAllRunningAppInstances) return result('SnapshotUnavailable');
            const roots = Object.values(platform.getAllRunningAppInstances()).filter(app => !app.disposed
              && app.app?.id === 'app/com/main/Index');
            if (roots.length !== 1) return result('ScopeUnavailable');
            const root = roots[0];
            const previous = globalThis[stateKey];
            const util = previous?.root === root && previous.util
              ? previous.util : globalThis.createCommonUtil?.();
            const text = value => String(value ?? '').trim();
            const identity = () => {
              if (root.disposed) return null;
              const user = util?.Auth?.getUserInfo(root);
              if (!user?.getValue) return null;
              const account = text(user.getValue('userId')), school = text(user.getValue('instCd'));
              const lowerYear = text(user.getValue('ayr')), upperYear = text(user.getValue('Ayr'));
              const year = lowerYear || upperYear, course = text(user.getValue('shlCrseScCd'));
              const schoolKind = text(user.getValue('shlKndScCd'));
              if (!account || !school || !/^\d{4}$/.test(year) || Number(year) < 2000 || Number(year) > 2100
                  || (lowerYear && upperYear && lowerYear !== upperYear) || !schoolKind
                  || !['2','3','4','5'].includes(course)) return null;
              return {account,school,year,course,schoolKind,
                orgCd:text(user.getValue('orgCd')),orgScCd:text(user.getValue('orgScCd'))};
            };
            const who = identity();
            if (!who) return result('ScopeUnavailable');
            const signature = JSON.stringify(who), scope = JSON.stringify([office,who.account,who.school]);
            const sameIdentity = () => JSON.stringify(identity()) === signature;
            let observation = globalThis[stateKey];
            if (observation && (observation.root.disposed || observation.root !== root
                || observation.signature !== signature)) {
              observation.cancel?.();
              observation = globalThis[stateKey] = undefined;
            }
            // A framework validation/cancel can finish without submit-done. Retire
            // that observer only after the framework confirms no request is active.
            if (observation?.inFlight && Date.now()-observation.startedAt > 30000
                && ['IDLE','DONE'].includes(observation.current?.sub.status)) observation.expire?.();
            if (!startQuery) {
              if (!observation) return result('SnapshotUnavailable');
              if (observation.inFlight) return result('Started');
              return observation.state === 'Available'
                ? {state:'Available',scope,items:[...observation.items]} : result(observation.state);
            }
            if (observation?.inFlight) return result('Busy');
            const menu = root.lookup?.('dsAllMenu');
            const needed = ['MENU_ID','MENU_NM','V_MENU_ID','V_UP_MENU_ID','CALL_PAGE','SHOW_YN',
              'menuUseYn','inqAccesAuthYn','menuId','pgeId','pgePathNm','ayr','shlDptCd',
              'shlDptWrkCd','rptdYn','dataAuthScCd','dataAuthAplcnYn'];
            if (!menu?.getColumnNames || !menu.getRowCount || !menu.getValue || !menu.getRowData
                || !needed.every(name => menu.getColumnNames().includes(name)))
              return result('SnapshotUnavailable');
            const candidates = [];
            for (let row = 0; row < menu.getRowCount(); row++) {
              if (menu.getValue(row,'MENU_ID') !== 'AMEDS40531'
                  || text(menu.getValue(row,'MENU_NM')) !== '결석신고서관리'
                  || menu.getValue(row,'CALL_PAGE') !== 'edu/sa/eds/eaa/ae/eds_eaaae03_m01'
                  || menu.getValue(row,'SHOW_YN') !== 'Y' || menu.getValue(row,'menuUseYn') !== 'Y'
                  || menu.getValue(row,'inqAccesAuthYn') !== 'Y') continue;
              const path = [], visited = new Set();
              let current = row;
              for (let depth = 0; depth < 4 && current >= 0; depth++) {
                const key = menu.getValue(current,'V_MENU_ID');
                if (!key || visited.has(key)) break;
                visited.add(key);
                path.unshift(text(menu.getValue(current,'MENU_NM')));
                const parent = menu.getValue(current,'V_UP_MENU_ID'), matches = [];
                for (let index = 0; index < menu.getRowCount(); index++)
                  if (menu.getValue(index,'V_MENU_ID') === parent) matches.push(index);
                current = matches.length === 1 ? matches[0] : -1;
              }
              if (JSON.stringify(path) === JSON.stringify(['학급담임','교육활동신청관리','출결관리','결석신고서관리']))
                candidates.push(row);
            }
            if (candidates.length !== 1) return result('NotAuthorized');
            const menuAuth = menu.getRowData(candidates[0]);
            if (!menuAuth || text(menuAuth.MENU_ID) !== 'AMEDS40531' || !text(menuAuth.V_MENU_ID))
              return result('NotAuthorized');
            const api = globalThis.cpr;
            if (typeof api?.protocols?.Submission !== 'function' || typeof api?.data?.DataMap !== 'function'
                || typeof api?.data?.DataSet !== 'function' || typeof root.register !== 'function'
                || typeof root.unregister !== 'function') return result('SnapshotUnavailable');
            const commandTypes = {
              '2':[['swcOrgAyr','ayr'],['swcOrgGrd','grd'],['swcOrgClsCd','clsCd']],
              '3':[['swcOrgAyr','ayr'],['swcOrgDghtCrseScCd','dghtCrseScCd'],['swcOrgGrd','grd'],['swcOrgClsCd','clsCd']],
              '4':[['swcOrgAyr','ayr'],['swcOrgDghtCrseScCd','dghtCrseScCd'],['swcOrgOrdGrdDddepCd','ordGrdDddepCd'],['swcOrgClsCd','clsCd']],
              '5':[['swcOrgAyr','ayr'],['swcOrgShlCrseScCdExcl','shlCrseScCd'],['swcOrgGrd','grd'],['swcOrgClsCd','clsCd']]
            };
            const commands = commandTypes[who.course];
            const nextYear = Number(who.year) + 1;
            const lastFebruary = nextYear % 4 === 0 && (nextYear % 100 !== 0 || nextYear % 400 === 0) ? '29' : '28';
            const searchColumns = ['ayr','ordScCd','grd','dddepCd','ordGrdDddepCd','clsCd','stuInvlNo',
              'actScCd','shlCd','atteYmd','enrScCd','shlKndScCd','stuFlnm','clsNm','clsNo',
              'eduActPrcsStsCd','shlCrseScCd','dghtCrseScCd','orgCd','onlAplyYn','atrzStsCd',
              'abeBgngDt','abeEndDt','ayrAuthType'];
            const base = Object.fromEntries(searchColumns.map(name => [name,'']));
            Object.assign(base,{shlCd:who.school,ayr:who.year,shlKndScCd:who.schoolKind,
              shlCrseScCd:who.course,abeBgngDt:who.year+'0301',abeEndDt:String(nextYear)+'02'+lastFebruary});
            const nonce = '__oneClickAbsence_'+Date.now()+'_'+Math.random().toString(36).slice(2);
            observation = {root,util,signature,scope,state:'Started',inFlight:true,items:new Set(),
              jobs:[{kind:'auth',depth:0,search:base}],current:null,sequence:0,groups:0,requests:0,
              startedAt:Date.now()};
            globalThis[stateKey] = observation;
            const release = () => {
              const current = observation.current;
              observation.current = null;
              if (!current) return;
              for (const [name,handler] of current.listeners) {
                try { current.sub.removeEventListener(name,handler); } catch {}
              }
              try { root.unregister(current.sub); } catch {}
              try { current.sub.dispose(); } catch {}
              for (const data of current.data) { try { data.dispose?.(); } catch {} }
            };
            const finish = state => {
              observation.state = state;
              observation.inFlight = false;
              observation.jobs.length = 0;
              if (state !== 'Available') observation.items.clear();
              release();
            };
            observation.expire = () => finish('QueryFailed');
            observation.cancel = () => {
              try { observation.current?.sub.abort?.(); } catch {}
              finish('ScopeUnavailable');
            };
            const map = (name,values) => {
              const data = new api.data.DataMap(name);
              data.parseData({columns:Object.keys(values).map(name => ({name})),rows:[]});
              data.build(values);
              return data;
            };
            const dataset = (name,columns,rows=[]) => {
              const data = new api.data.DataSet(name);
              data.parseData({columns:columns.map(name => ({name})),rows});
              return data;
            };
            const count = data => {
              const size = data.getRowCount();
              if (!Number.isInteger(size) || size < 0 || size > 10000) throw new Error('InvalidRows');
              return size;
            };
            const dispatch = () => {
              if (!observation.inFlight) return;
              if (!sameIdentity()) { finish('ScopeUnavailable'); return; }
              if (Date.now()-observation.startedAt > 25000 || ++observation.requests > 128) {
                finish('QueryFailed'); return;
              }
              const job = observation.jobs.shift();
              if (!job) { finish(observation.groups ? 'Available' : 'NotAuthorized'); return; }
              try {
                const id = nonce+'_'+(++observation.sequence);
                const sub = new api.protocols.Submission(id);
                const auth = map(id+'_auth',menuAuth), input = map(id+'_search',job.search);
                const current = {sub,data:[auth,input],listeners:[],received:false,responseCount:null,
                  failed:false,job,output:null};
                observation.current = current;
                if (typeof sub.addRequestData !== 'function' || typeof sub.addResponseData !== 'function'
                    || typeof sub.addEventListener !== 'function' || typeof sub.removeEventListener !== 'function'
                    || typeof sub.getRequestData !== 'function' || typeof sub.isSuccess !== 'function'
                    || typeof sub.userAttr !== 'function' || typeof sub.send !== 'function') {
                  finish('SnapshotUnavailable'); return;
                }
                sub.action = job.kind === 'auth' ? '/swc_cmm_at00_000.do' : '/eds_eaa_ae03_002.do';
                sub.mediaType = 'application/json';
                sub.withCredentials = true;
                // Keep the framework's ordinary data envelope. The live site's
                // requests use it; the unused encoder helpers in module/submit do not.
                // Official module/submit copies this authorized menu row to _AUTHDATA.
                // It does not change the selected EmbeddedApp's AUTH_DATA.
                sub.userAttr('_menuAuthChk','Y');
                sub.addRequestData(auth,'AUTHDATA');
                sub.addRequestData(input,'dmSearch');
                if (['1','2','3','4'].includes(text(menuAuth.rptdYn))) sub.addRequestData(input,'_SWCDATA');
                let alias;
                if (job.kind === 'auth') {
                  const [command,field] = commands[job.depth];
                  alias = 'ds'+command[0].toUpperCase()+command.slice(1);
                  const rights = dataset(id+'_rights',['authType','tenseType','cmdType','refValue','bindColumn','firstCdType'],
                    commands.map(([cmdType,bindColumn],index) => ({
                      authType:'YES',tenseType:['12','13','16','17'].includes(who.schoolKind)?'PRESENT':'ALL',
                      cmdType,refValue:index<job.depth?(job.search[bindColumn] || ''):'',bindColumn,firstCdType:null})));
                  current.data.push(rights);
                  sub.addRequestData(rights,'dsSwcAuthList','all');
                  for (const [cmdType] of commands) {
                    const name = 'ds'+cmdType[0].toUpperCase()+cmdType.slice(1);
                    const output = dataset(id+'_'+cmdType,['cd','nm','ayrAuthType']);
                    output.alterColumnLayout = 'merge';
                    current.data.push(output);
                    sub.addResponseData(output,false,name);
                    if (name === alias) current.output = output;
                  }
                  const information = map(id+'_information',{authType:'',shlCd:'',ayr:'',dghtIndctYn:'',
                    ordIndctYn:'',dddepIndctYn:'',ordDddepIndctYn:'',dghtOrdDddepIndctYn:''});
                  current.data.push(information);
                  sub.addResponseData(information,false,'dmSwcIndctInfo');
                } else {
                  alias = 'dsStdntListForAbe';
                  const classes = dataset(id+'_classes',['cd','nm','sorSeqSn','clsCd','clsCdNm'],job.classes);
                  current.data.push(classes);
                  sub.addRequestData(classes,'dsClsCd','all');
                  current.output = dataset(id+'_output',['shlCd','ayr','abeDclrId','eduActPrcsStsCd']);
                  current.data.push(current.output);
                  sub.addResponseData(current.output,false,alias);
                }
                const listen = (name,handler) => {current.listeners.push([name,handler]);sub.addEventListener(name,handler);};
                listen('before-submit',event => {
                  const supplied = sub.getRequestData('_AUTHDATA')?.data;
                  if (!sameIdentity() || text(supplied?.getValue('MENU_ID')) !== 'AMEDS40531'
                      || text(supplied?.getValue('V_MENU_ID')) !== text(menuAuth.V_MENU_ID)) {
                    current.failed = true;
                    event.preventDefault();
                    finish(sameIdentity()?'SnapshotUnavailable':'ScopeUnavailable');
                  }
                });
                listen('receive',() => {
                  try {
                    const response = JSON.parse(sub.xhr.responseText);
                    if (!response || typeof response !== 'object' || Array.isArray(response)
                        || (response.ErrorCode !== undefined && ![0,'0',''].includes(response.ErrorCode))) {
                      current.failed = true; return;
                    }
                    const rows = response[alias];
                    const records = Array.isArray(rows) ? rows : rows?.rows;
                    if (!Array.isArray(records)) { current.failed = true; return; }
                    current.received = true;
                    current.responseCount = records.length;
                  } catch { current.failed = true; }
                });
                listen('submit-error',() => {current.failed=true;});
                listen('submit-done',() => {
                  if (!observation.inFlight || observation.current !== current) return;
                  try {
                    if (!sameIdentity()) { finish('ScopeUnavailable'); return; }
                    if (current.failed || !current.received || !sub.isSuccess()) { finish('QueryFailed'); return; }
                    const output = current.output, size = count(output);
                    if (size !== current.responseCount) { finish('SnapshotUnavailable'); return; }
                    if (job.kind === 'auth') {
                      const [command,field] = commands[job.depth];
                      const values = [], seen = new Set();
                      for (let row=0;row<size;row++) {
                        const code = text(output.getValue(row,'cd'));
                        if (!code || ['00','%'].includes(code)) continue;
                        if (seen.has(code)) { finish('SnapshotUnavailable'); return; }
                        seen.add(code);
                        values.push({code,row});
                      }
                      if (job.depth === 0) {
                        const year = values.find(item => item.code === who.year);
                        if (!year) { finish('NotAuthorized'); return; }
                        const search = {...job.search,ayrAuthType:text(output.getValue(year.row,'ayrAuthType'))};
                        observation.jobs.push({kind:'auth',depth:1,search});
                      } else if (job.depth === commands.length-1) {
                        const classes = values.map(({code}) => ({cd:code,nm:'',sorSeqSn:'',clsCd:code,clsCdNm:''}));
                        if (classes.length) {
                          if (++observation.groups > 64) { finish('SnapshotUnavailable'); return; }
                          observation.jobs.push({kind:'list',search:{...job.search,clsCd:'00'},classes});
                        }
                      } else {
                        for (const {code} of values) {
                          const search = {...job.search,[field]:code};
                          if (command === 'swcOrgOrdGrdDddepCd') {
                            const parts = code.split('/');
                            if (parts.length !== 3 || parts.some(value => !value)) { finish('SnapshotUnavailable'); return; }
                            [search.ordScCd,search.grd,search.dddepCd] = parts;
                          }
                          observation.jobs.push({kind:'auth',depth:job.depth+1,search});
                        }
                      }
                    } else {
                      for (let row=0;row<size;row++) {
                        const school=text(output.getValue(row,'shlCd')),year=text(output.getValue(row,'ayr'));
                        const key=text(output.getValue(row,'abeDclrId')),status=text(output.getValue(row,'eduActPrcsStsCd'));
                        if (!key || key.length>1024 || school !== who.school || year !== who.year
                            || !['01','02','03'].includes(status)) { finish('SnapshotUnavailable'); return; }
                        if (status === '01') observation.items.add(JSON.stringify([school,year,key]));
                      }
                    }
                    release();
                    dispatch();
                  } catch { finish('SnapshotUnavailable'); }
                });
                root.register(sub);
                sub.send();
              } catch { finish('SnapshotUnavailable'); }
            };
            dispatch();
            return observation.inFlight ? result('Started') : observation.state === 'Available'
              ? {state:'Available',scope,items:[...observation.items]} : result(observation.state);
          } catch { return {state:'SnapshotUnavailable'}; }
        })()
        """;
}
