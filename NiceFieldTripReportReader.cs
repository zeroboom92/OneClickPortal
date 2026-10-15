using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal enum FieldTripReportReadState
{
    Available, PageMissing, MultiplePages, ReportPageMissing, ScopeUnavailable,
    Busy, QueryFailed, SnapshotUnavailable,
}

internal sealed record FieldTripReportReadResult(
    IReadOnlyList<NotificationSourceItem>? Items, string? Scope,
    FieldTripReportReadState State, string? SourceId = null);

internal static class NiceFieldTripReportReader
{
    public static async Task<FieldTripReportReadResult> ReadAsync(int port, EducationOffice office,
        CancellationToken cancellationToken, bool refresh = true)
    {
        var targets = (await DevToolsDiscovery.GetTargetsAsync(port, cancellationToken))
            .Where(target => target.Type == "page"
                && Uri.TryCreate(target.Url, UriKind.Absolute, out var uri)
                && uri.Scheme == Uri.UriSchemeHttps
                && string.Equals(uri.Host, office.NiceDomain, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (targets.Length == 0) return new(null, null, FieldTripReportReadState.PageMissing);
        if (targets.Length != 1) return new(null, null, FieldTripReportReadState.MultiplePages);
        await using var session = await DevToolsSession.ConnectAsync(port, targets[0].Id, cancellationToken);
        await session.ResumeBackgroundPageAsync(cancellationToken);
        var value = await session.EvaluateAsync(Script(office.NiceDomain, office.Code, refresh),
            cancellationToken: cancellationToken);
        for (var attempt = 0; IsStarted(value) && attempt < 40; attempt++)
        {
            await Task.Delay(250, cancellationToken);
            value = await session.EvaluateAsync(Script(office.NiceDomain, office.Code, false),
                cancellationToken: cancellationToken);
        }
        return Parse(value, targets[0].Id);
    }

    private static bool IsStarted(JsonElement value) => value.ValueKind == JsonValueKind.Object
        && value.TryGetProperty("state", out var state) && state.GetString() == "Started";

    internal static FieldTripReportReadResult Parse(JsonElement value, string sourceId)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("state", out var stateValue)
            || stateValue.ValueKind != JsonValueKind.String
            || !Enum.TryParse<FieldTripReportReadState>(stateValue.GetString(), out var state) || !Enum.IsDefined(state))
            return new(null, null, FieldTripReportReadState.Busy, sourceId);
        if (state != FieldTripReportReadState.Available) return new(null, null, state, sourceId);
        if (!value.TryGetProperty("scope", out var scopeValue) || scopeValue.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(scopeValue.GetString()) || scopeValue.GetString()!.Length > 2048
            || !value.TryGetProperty("items", out var rows) || rows.ValueKind != JsonValueKind.Array)
            return new(null, null, FieldTripReportReadState.SnapshotUnavailable, sourceId);
        List<NotificationSourceItem> items = [];
        foreach (var row in rows.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(row.GetString())
                || row.GetString()!.Length > 2048)
                return new(null, null, FieldTripReportReadState.SnapshotUnavailable, sourceId);
            items.Add(new(row.GetString()!, string.Empty));
        }
        return new(items.AsReadOnly(), scopeValue.GetString(), state, sourceId);
    }

    // Verified on the official report-management app, 2026-10-15. Read only the report key
    // and status columns. Query through the site's own 조회 button, never 승인요청.
    internal static string Script(string officeDomain, string officeCode, bool startQuery)
    {
        return $$"""
            (() => {
              try {
                const host = {{JsonSerializer.Serialize(officeDomain)}};
                const office = {{JsonSerializer.Serialize(officeCode)}};
                const startQuery = {{(startQuery ? "true" : "false")}};
                const result = state => ({state});
                if (location.protocol !== 'https:' || location.hostname !== host
                    || document.readyState !== 'complete') return result('SnapshotUnavailable');
                if (String(location.pathname).toLowerCase().endsWith('/executeneislogout.do')
                    || String(document.body?.innerText || '').replace(/\s/g,'').includes('나이스를로그아웃하였습니다'))
                  return result('ScopeUnavailable');
                const platform = globalThis.cpr?.core?.Platform?.INSTANCE;
                if (!platform?.getAllRunningAppInstances) return result('ReportPageMissing');
                const apps = Object.values(platform.getAllRunningAppInstances());
                const owners = apps.filter(a => !a.disposed
                  && a.app?.id === 'edu/sa/eds/eaa/ae/eds_eaaae02_m01');
                if (owners.length !== 1) return result(owners.length ? 'Busy' : 'ReportPageMissing');
                const app = owners[0], data = app.lookup('dsStdntListForRlt');
                const search = app.lookup('dmSearch'), user = app.lookup('dmUserInfo');
                const sub = app.lookup('subStdntList'), button = app.lookup('btnSearch');
                const grid = app.lookup('grdMain');
                if (!data || !search || !user || !sub || !button || !grid
                    || grid.dataSet !== data || button.value !== '조회')
                  return result('SnapshotUnavailable');
                const action = new URL(sub.action, location.href);
                if (action.protocol !== 'https:' || action.hostname !== host
                    || action.pathname !== '/eds_eaa_ae02_002.do') return result('SnapshotUnavailable');
                const required = ['ousExperLrnRltId','shlCd','ayr','eduActPrcsStsCd','atrzStsCd','atrzStsNm'];
                if (!required.every(name => data.getColumnNames().includes(name))) return result('SnapshotUnavailable');
                const account = String(user.getValue('userId') || '').trim();
                const school = String(search.getValue('shlCd') || '').trim();
                const year = String(search.getValue('ayr') || '').trim();
                if (!account || !school || !year) return result('ScopeUnavailable');
                const liveUser = globalThis.createCommonUtil?.().Auth?.getUserInfo(app);
                if (!liveUser || String(liveUser.getValue('userId') || '') !== account)
                  return result('ScopeUnavailable');
                // Report IDs include their own school/year. Scope deliberately excludes the
                // current class filter so choosing 全体/another class cannot repeat a report.
                const scope = JSON.stringify([office, account, school]);
                const query = JSON.stringify(search.getDatas());
                const stateKey = '__oneClickFieldTripReportReadV1';
                let observation = globalThis[stateKey];
                if (observation && (observation.app.disposed || observation.sub.disposed)) {
                  observation.cleanup?.();
                  observation = globalThis[stateKey] = undefined;
                }
                // Validation can stop a click before any request starts. Retire an old
                // observer only after the framework confirms its request is no longer busy.
                // A genuinely outstanding request is never sent again on a later timer tick.
                if (observation?.inFlight && Date.now() - observation.startedAt > 30000
                    && ['IDLE','DONE'].includes(observation.sub.status)) {
                  observation.cleanup?.();
                  observation.inFlight = false;
                  observation.done = true;
                  observation.success = false;
                }
                const sameOwner = observation?.app === app && observation?.sub === sub
                  && observation?.scope === scope && observation?.query === query;
                const shown = element => {
                  if (!element) return false;
                  const rect = element.getBoundingClientRect();
                  if (rect.width <= 0 || rect.height <= 0) return false;
                  for (let p = element; p; p = p.parentElement) {
                    const s = getComputedStyle(p);
                    if (p.hidden || s.display === 'none' || s.visibility === 'hidden') return false;
                  }
                  return true;
                };
                if ([...document.querySelectorAll('[role="dialog"],.cl-dialog')].some(shown)
                    || grid.getCheckRowIndices().length > 0) return result('Busy');
                if (startQuery) {
                  if (observation?.inFlight || !['IDLE','DONE'].includes(sub.status)) return result('Busy');
                  if (!button.enabled || !grid.readOnly) return result('Busy');
                  // Never clear edits on another task or on the report being prepared.
                  observation = {app,sub,scope,query,inFlight:true,success:false,done:false,startedAt:Date.now()};
                  globalThis[stateKey] = observation;
                  const success = () => { observation.success = true; };
                  const failure = () => { observation.success = false; };
                  const cleanup = () => {
                    sub.removeEventListener('submit-success', success);
                    sub.removeEventListener('submit-error', failure);
                    sub.removeEventListener('submit-done', done);
                  };
                  const done = () => {
                    observation.inFlight = false;
                    observation.done = true;
                    observation.success = observation.success && sub.isSuccess();
                    cleanup();
                  };
                  observation.cleanup = cleanup;
                  sub.addEventListener('submit-success', success);
                  sub.addEventListener('submit-error', failure);
                  sub.addEventListener('submit-done', done);
                  try { button.click(); }
                  catch { failure(); done(); return result('QueryFailed'); }
                  return result('Started');
                }
                if (!sameOwner) return result('SnapshotUnavailable');
                if (observation.inFlight) return result('Started');
                if (!observation.done || !observation.success || !sub.isSuccess()
                    || !['IDLE','DONE'].includes(sub.status)) return result('QueryFailed');
                const items = [], seen = new Set();
                for (let row = 0; row < data.getRowCount(); row++) {
                  const key = String(data.getValue(row,'ousExperLrnRltId') || '').trim();
                  const rowSchool = String(data.getValue(row,'shlCd') || '').trim();
                  const rowYear = String(data.getValue(row,'ayr') || '').trim();
                  if (!key || rowSchool !== school || rowYear !== year) return result('SnapshotUnavailable');
                  const approval = String(data.getValue(row,'atrzStsCd') ?? '');
                  const label = String(data.getValue(row,'atrzStsNm') || '').trim();
                  const process = String(data.getValue(row,'eduActPrcsStsCd') || '');
                  if (label !== '미상신' || !['','00'].includes(approval) || !['01','02'].includes(process)) continue;
                  const id = JSON.stringify([rowSchool,rowYear,key]);
                  if (!seen.has(id)) { seen.add(id); items.push(id); }
                }
                return {state:'Available',scope,items};
              } catch { return {state:'SnapshotUnavailable'}; }
            })()
            """;
    }
}
