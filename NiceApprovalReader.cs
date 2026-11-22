using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal enum NiceApprovalReadState
{
    Available, PageMissing, MultiplePages, ScopeUnavailable, Busy, QueryFailed, CountUnavailable,
}

internal sealed record NiceApprovalReadResult(
    int? Count, string? Scope, NiceApprovalReadState State, string? SourceId = null);

internal static class NiceApprovalReader
{
    public static async Task<NiceApprovalReadResult> ReadAsync(int port, EducationOffice office,
        CancellationToken cancellationToken)
    {
        var targets = (await DevToolsDiscovery.GetTargetsAsync(port, cancellationToken))
            .Where(target => target.Type == "page"
                && Uri.TryCreate(target.Url, UriKind.Absolute, out var uri)
                && uri.Scheme == Uri.UriSchemeHttps
                && string.Equals(uri.Host, office.NiceDomain, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (targets.Length == 0) return new(null, null, NiceApprovalReadState.PageMissing);
        if (targets.Length != 1) return new(null, null, NiceApprovalReadState.MultiplePages);
        await using var session = await DevToolsSession.ConnectAsync(port, targets[0].Id, cancellationToken);
        await session.ResumeBackgroundPageAsync(cancellationToken);
        var requestId = Guid.NewGuid().ToString("N");
        var pending = true;
        try
        {
            var value = await session.EvaluateAsync(Script(office.NiceDomain, office.Code, true, requestId),
                cancellationToken: cancellationToken);
            pending = IsStarted(value);
            for (var attempt = 0; pending && attempt < 100; attempt++)
            {
                await Task.Delay(200, cancellationToken);
                value = await session.EvaluateAsync(Script(office.NiceDomain, office.Code, false, requestId),
                    cancellationToken: cancellationToken);
                pending = IsStarted(value);
            }
            return Parse(value, targets[0].Id);
        }
        finally
        {
            if (pending)
            {
                // The independent cleanup token also covers cancellation while the
                // first evaluation is returning. A lease prevents retiring another read.
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                try
                {
                    await session.EvaluateAsync(CancelScript(office.NiceDomain, requestId),
                        cancellationToken: cleanup.Token);
                }
                catch { /* The browser may already have navigated or disconnected. */ }
            }
        }
    }

    private static bool IsStarted(JsonElement value) => value.ValueKind == JsonValueKind.Object
        && value.TryGetProperty("state", out var state) && state.ValueKind == JsonValueKind.String
        && state.GetString() == "Started";

    internal static NiceApprovalReadResult Parse(JsonElement value, string sourceId)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("state", out var stateValue)
            || stateValue.ValueKind != JsonValueKind.String
            || !Enum.TryParse<NiceApprovalReadState>(stateValue.GetString(), out var state) || !Enum.IsDefined(state))
            return new(null, null, NiceApprovalReadState.CountUnavailable, sourceId);
        if (state != NiceApprovalReadState.Available) return new(null, null, state, sourceId);
        if (!value.TryGetProperty("count", out var count) || count.ValueKind != JsonValueKind.Number
            || !count.TryGetInt32(out var number) || number < 0
            || !value.TryGetProperty("scope", out var scope) || scope.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(scope.GetString()) || scope.GetString()!.Length > 2048)
            return new(null, null, NiceApprovalReadState.CountUnavailable, sourceId);
        return new(number, scope.GetString(), state, sourceId);
    }

    internal static string CancelScript(string officeDomain, string requestId) => $$"""
        (() => {
          if (location.protocol !== 'https:' || location.hostname !== {{JsonSerializer.Serialize(officeDomain)}}) return;
          const observation = globalThis.__oneClickNiceApprovalReadV1;
          if (observation?.requestId === {{JsonSerializer.Serialize(requestId)}} && observation.inFlight)
            observation.cancel?.();
        })()
        """;

    // The normal Index submission uses /approval.do with no search or menu input,
    // JSON media type, and the dsApproval response. Its global module/submit filters
    // supply ordinary authentication headers/data. Use a private response dataset:
    // Index's initial zero and an earlier successful response are never a new read.
    internal static string Script(string officeDomain, string officeCode, bool startQuery, string? requestId = null) => $$"""
        (() => {
          const stateKey = '__oneClickNiceApprovalReadV1';
          const result = state => ({state});
          const retire = state => { globalThis[stateKey]?.cancel?.(); return result(state); };
          try {
            const host = {{JsonSerializer.Serialize(officeDomain)}};
            const office = {{JsonSerializer.Serialize(officeCode)}};
            const startQuery = {{(startQuery ? "true" : "false")}};
            const requestId = {{JsonSerializer.Serialize(requestId)}};
            if (location.protocol !== 'https:' || location.hostname !== host || document.readyState !== 'complete')
              return retire('CountUnavailable');
            if (String(location.pathname).toLowerCase().endsWith('/executeneislogout.do')
                || String(document.body?.innerText || '').replace(/\s/g,'').includes('나이스를로그아웃하였습니다'))
              return retire('ScopeUnavailable');
            const platform = globalThis.cpr?.core?.Platform?.INSTANCE;
            if (!platform?.getAllRunningAppInstances) return retire('CountUnavailable');
            const roots = Object.values(platform.getAllRunningAppInstances()).filter(app => !app.disposed
              && app.app?.id === 'app/com/main/Index');
            if (roots.length !== 1) return retire('ScopeUnavailable');
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
              if (!account || !school || account.length > 512 || school.length > 512) return null;
              return {account,school,org:text(user.getValue('orgCd')),orgKind:text(user.getValue('orgScCd'))};
            };
            const who = identity();
            if (!who) return retire('ScopeUnavailable');
            const signature = JSON.stringify(who), scope = JSON.stringify([office,who.account,who.school,who.org,who.orgKind]);
            const sameIdentity = () => {
              try {
                const currentRoots = Object.values(platform.getAllRunningAppInstances()).filter(app => !app.disposed
                  && app.app?.id === 'app/com/main/Index');
                return location.protocol === 'https:' && location.hostname === host
                  && currentRoots.length === 1 && currentRoots[0] === root && JSON.stringify(identity()) === signature;
              } catch { return false; }
            };
            let observation = previous;
            if (observation && (observation.root !== root || observation.signature !== signature)) {
              observation.cancel?.();
              globalThis[stateKey] = undefined;
              return result('ScopeUnavailable');
            }
            if (observation?.inFlight && Date.now()-observation.startedAt >= 20000) observation.expire?.();
            if (!startQuery) {
              if (!observation || (requestId && observation.requestId !== requestId)) return result('QueryFailed');
              if (observation.inFlight) return result('Started');
              return observation.state === 'Available'
                ? {state:'Available',count:observation.count,scope} : result(observation.state);
            }
            if (observation?.inFlight) return result('Busy');
            const original = root.lookup?.('subApproval');
            if (!original) return result('CountUnavailable');
            const endpoint = new URL(String(original.action || ''), location.href);
            if (endpoint.origin !== location.origin || endpoint.pathname !== '/approval.do'
                || endpoint.search || endpoint.hash || endpoint.username || endpoint.password
                || original.mediaType !== 'application/json') return result('CountUnavailable');
            if (!['IDLE','DONE'].includes(original.status)) return result('Busy');
            const api = globalThis.cpr;
            if (typeof api?.protocols?.Submission !== 'function' || typeof api?.data?.DataSet !== 'function'
                || typeof root.register !== 'function' || typeof root.unregister !== 'function')
              return result('CountUnavailable');
            const nonce = '__oneClickNiceApproval_'+Date.now()+'_'+Math.random().toString(36).slice(2);
            observation = {root,util,signature,scope,requestId:requestId || nonce,startedAt:Date.now(),
              inFlight:true,state:'Started',count:null,current:null,timer:null};
            globalThis[stateKey] = observation;
            const release = abort => {
              if (observation.timer !== null) { clearTimeout(observation.timer); observation.timer = null; }
              const current = observation.current;
              observation.current = null;
              if (!current) return;
              for (const [name,handler] of current.listeners) {
                try { current.sub.removeEventListener(name,handler); } catch {}
              }
              if (abort) { try { current.sub.abort?.(); } catch {} }
              try { root.unregister(current.sub); } catch {}
              try { current.sub.dispose(); } catch {}
              try { current.output?.dispose(); } catch {}
            };
            const finish = (state,count=null,abort=false) => {
              if (!observation.inFlight) return;
              observation.inFlight = false;
              observation.state = state;
              observation.count = state === 'Available' ? count : null;
              release(abort);
            };
            observation.cancel = () => finish('ScopeUnavailable',null,true);
            observation.expire = () => finish('QueryFailed',null,true);
            const readCount = value => {
              if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
              const number = Number(value);
              return Number.isSafeInteger(number) && number >= 0 && number <= 2147483647 ? number : null;
            };
            try {
              const sub = new api.protocols.Submission(nonce);
              const current = {sub,output:null,listeners:[],received:false,succeeded:false,failed:false,responseCount:null};
              observation.current = current;
              const output = current.output = new api.data.DataSet(nonce+'_output');
              if (typeof sub.addResponseData !== 'function' || typeof sub.addEventListener !== 'function'
                  || typeof sub.removeEventListener !== 'function' || typeof sub.getRequestData !== 'function'
                  || typeof sub.isSuccess !== 'function' || typeof sub.send !== 'function') {
                finish('CountUnavailable'); return result('CountUnavailable');
              }
              output.parseData({columns:['menuNm','menuId','pgeId','callPage','apvlCnt'].map(name => ({name})),rows:[]});
              sub.action = '/approval.do';
              sub.mediaType = 'application/json';
              sub.method = 'post';
              sub.withCredentials = true;
              sub.timeout = 18000;
              sub.addResponseData(output,false,'dsApproval');
              const listen = (name,handler) => {current.listeners.push([name,handler]);sub.addEventListener(name,handler);};
              listen('before-submit',event => {
                const supplied = sub.getRequestData('_AUTHDATA')?.data;
                if (!sameIdentity() || !supplied?.getValue
                    || (who.org && text(supplied.getValue('orgCd')) !== who.org)
                    || (who.orgKind && text(supplied.getValue('orgScCd')) !== who.orgKind)) {
                  current.failed = true;
                  event.preventDefault();
                  finish(sameIdentity() ? 'QueryFailed' : 'ScopeUnavailable');
                }
              });
              listen('receive',() => {
                try {
                  if (!sameIdentity()) { current.failed = true; return; }
                  const xhr = sub.xhr;
                  if (xhr?.readyState !== 4 || xhr.status !== 200) { current.failed = true; return; }
                  const response = JSON.parse(xhr.responseText);
                  if (!response || typeof response !== 'object' || Array.isArray(response)
                      || (response.ErrorCode !== undefined && ![0,'0',''].includes(response.ErrorCode))) {
                    current.failed = true; return;
                  }
                  const data = response.dsApproval, rows = Array.isArray(data) ? data : data?.rows;
                  if (!Array.isArray(rows) || rows.length > 32 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
                    current.failed = true; return;
                  }
                  const matches = rows.filter(row => row.menuId === 'AMWAM40012');
                  if (matches.length !== 1) { current.failed = true; return; }
                  const row = matches[0];
                  if ((row.menuNm !== undefined && row.menuNm !== '미결/협조함')
                      || (row.pgeId !== undefined && row.pgeId !== 'wam_woapm02_m00')
                      || (row.callPage !== undefined && row.callPage !== 'edu/cm/wam/woa/pm/wam_woapm02_m00')) {
                    current.failed = true; return;
                  }
                  current.responseCount = readCount(row.apvlCnt);
                  current.received = current.responseCount !== null;
                } catch { current.failed = true; }
              });
              listen('submit-success',() => {current.succeeded = true;});
              for (const name of ['submit-error','error-status','submit-timeout'])
                listen(name,() => {current.failed = true;});
              listen('submit-done',() => {
                if (!observation.inFlight || observation.current !== current) return;
                try {
                  if (!sameIdentity()) { finish('ScopeUnavailable'); return; }
                  if (Date.now()-observation.startedAt >= 20000 || current.failed || !current.received
                      || !current.succeeded || !sub.isSuccess()) { finish('QueryFailed'); return; }
                  const size = output.getRowCount();
                  if (!Number.isInteger(size) || size < 1 || size > 32) { finish('CountUnavailable'); return; }
                  const matches = [];
                  for (let row=0;row<size;row++) if (output.getValue(row,'menuId') === 'AMWAM40012') matches.push(row);
                  if (matches.length !== 1 || readCount(output.getValue(matches[0],'apvlCnt')) !== current.responseCount) {
                    finish('CountUnavailable'); return;
                  }
                  finish('Available',current.responseCount);
                } catch { finish('CountUnavailable'); }
              });
              root.register(sub);
              observation.timer = setTimeout(observation.expire,20000);
              const sent = sub.send();
              if (sent && typeof sent.catch === 'function') sent.catch(() => finish('QueryFailed',null,true));
              if (sent === false) finish('QueryFailed',null,true);
            } catch { finish('QueryFailed',null,true); }
            return observation.inFlight ? result('Started') : observation.state === 'Available'
              ? {state:'Available',count:observation.count,scope} : result(observation.state);
          } catch { return retire('CountUnavailable'); }
        })()
        """;
}
