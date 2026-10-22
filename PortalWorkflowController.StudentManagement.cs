using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal sealed partial class PortalWorkflowController
{
    private static string StudentManagementTitle(PortalTaskKind kind) => kind switch
    {
        PortalTaskKind.FieldTripApplicationManagement => "교외체험학습신청서관리",
        PortalTaskKind.AbsenceReportManagement => "결석신고서관리",
        PortalTaskKind.FieldTripReportManagement => "교외체험학습보고서관리",
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    private async Task<WorkflowResult> OpenStudentManagementAsync(
        PortalTaskKind kind, CancellationToken cancellationToken)
    {
        var title = StudentManagementTitle(kind);
        var target = await GetFieldTripNiceTargetAsync(cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await session.ResumeBackgroundPageAsync(cancellationToken);
        await WaitForNiceReadyAsync(session, cancellationToken);
        await session.ActivateTargetAsync(cancellationToken);
        await session.MaximizeTargetWindowAsync(cancellationToken);
        await PrepareActivatedTargetForBackgroundAsync(cancellationToken);
        _reportProgress($"{title} 여는 중");

        var state = await session.EvaluateStringAsync(
            StudentManagementNavigationScript(_educationOffice.NiceDomain, kind, allowOpen: false),
            cancellationToken);
        if (state == "Missing")
        {
            // Use the site's ordinary authorized menu handler only once. A delayed
            // permission check must not create duplicate menu requests or tabs.
            state = await session.EvaluateStringAsync(
                StudentManagementNavigationScript(_educationOffice.NiceDomain, kind, allowOpen: true),
                cancellationToken);
        }
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (state is "Started" or "Opening" or "Loading" or "Missing")
        {
            if (DateTime.UtcNow >= deadline)
                throw new TimeoutException($"{title} 화면을 여는 시간이 초과되었습니다.");
            await Task.Delay(250, cancellationToken);
            state = await session.EvaluateStringAsync(
                StudentManagementNavigationScript(_educationOffice.NiceDomain, kind, allowOpen: false),
                cancellationToken);
        }
        if (state != "Selected")
            throw new InvalidOperationException(state switch
            {
                "Busy" => "열린 나이스 대화상자나 진행 중인 화면 전환을 확인한 뒤 다시 눌러 주세요.",
                "Ambiguous" => $"{title} 화면이나 학급담임 메뉴가 여러 개라 이동할 대상을 정할 수 없습니다.",
                "MenuMissing" => $"학급담임의 {title} 메뉴를 확인하지 못했습니다.",
                _ => $"{title} 화면으로 이동하지 못했습니다. 나이스 연결 상태를 확인해 주세요.",
            });

        await QueryStudentManagementAsync(kind, cancellationToken);
        await PrepareBrowserForUserAsync(session, cancellationToken);
        return new WorkflowResult($"{title} 조회가 완료되었습니다. 최종 상신은 직접 진행합니다.",
            KeepActivatedBrowser: true);
    }

    internal async Task QueryStudentManagementAsync(PortalTaskKind kind, CancellationToken cancellationToken)
    {
        var title = StudentManagementTitle(kind);
        var target = await GetFieldTripNiceTargetAsync(cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await session.ResumeBackgroundPageAsync(cancellationToken);
        _reportProgress($"{title} 조회하는 중");
        var state = await session.EvaluateStringAsync(
            StudentManagementQueryScript(_educationOffice.NiceDomain, kind, startQuery: true),
            cancellationToken);
        var deadline = DateTime.UtcNow.AddSeconds(30);
        var queryStarted = state == "Started";
        while (state is "Started" or "Loading")
        {
            if (DateTime.UtcNow >= deadline)
                throw new TimeoutException($"{title} 조회 완료를 확인하지 못했습니다. 나이스의 처리 상태를 확인해 주세요.");
            await Task.Delay(250, cancellationToken);
            state = await session.EvaluateStringAsync(
                StudentManagementQueryScript(_educationOffice.NiceDomain, kind, startQuery: !queryStarted),
                cancellationToken);
            if (state == "Started") queryStarted = true;
        }
        if (state != "Complete")
            throw new InvalidOperationException(state switch
            {
                "Busy" => "나이스에서 선택하거나 편집 중인 내용 또는 진행 중인 조회가 있습니다. 내용을 확인한 뒤 다시 눌러 주세요.",
                "Loading" => $"{title}의 조회 조건이 아직 준비되지 않았습니다. 화면을 확인한 뒤 다시 눌러 주세요.",
                "ScopeChanged" => "조회 중 계정이나 조회 조건이 변경되었습니다. 현재 내용을 확인한 뒤 다시 눌러 주세요.",
                "QueryFailed" => $"{title} 조회가 완료되지 않았습니다. 나이스에 표시된 안내를 확인해 주세요.",
                "Ambiguous" => $"{title} 화면이 여러 개라 조회할 대상을 정할 수 없습니다.",
                _ => $"{title}의 조회 화면을 확인하지 못했습니다. 나이스 연결 상태를 확인해 주세요.",
            });
    }

    // Only the verified CPR menu contracts are used. Existing tabs are selected
    // through their normal cancellable event; the ordinary menu handler checks permission.
    internal static string StudentManagementNavigationScript(
        string officeDomain, PortalTaskKind kind, bool allowOpen) => $$"""
        (() => {
          try {
            const host = {{JsonSerializer.Serialize(officeDomain)}};
            const kind = {{JsonSerializer.Serialize(kind.ToString())}};
            const allowOpen = {{(allowOpen ? "true" : "false")}};
            const configurations = {
              FieldTripApplicationManagement: {appId:'edu/sa/eds/eaa/ae/eds_eaaae01_m01',menuId:'AMEDS40501',title:'교외체험학습신청서관리',parent:'교외체험학습관리'},
              AbsenceReportManagement: {appId:'edu/sa/eds/eaa/ae/eds_eaaae03_m01',menuId:'AMEDS40531',title:'결석신고서관리',parent:'출결관리'},
              FieldTripReportManagement: {appId:'edu/sa/eds/eaa/ae/eds_eaaae02_m01',menuId:'AMEDS40511',title:'교외체험학습보고서관리',parent:'교외체험학습관리'}
            };
            const config = configurations[kind];
            if (!config || location.protocol !== 'https:' || location.hostname !== host
                || document.readyState !== 'complete') return 'Unavailable';
            const platform = globalThis.cpr?.core?.Platform?.INSTANCE;
            if (!platform?.getAllRunningAppInstances) return 'Unavailable';
            const apps = Object.values(platform.getAllRunningAppInstances()).filter(app => !app.disposed);
            const roots = apps.filter(app => app.app?.id === 'app/com/main/Index');
            if (roots.length !== 1) return 'Ambiguous';
            const root = roots[0], mdi = root.lookup('mdiCn');
            if (!mdi?.getTabItems || !mdi.getSelectedTabItem || !mdi.setSelectedTabItem) return 'Unavailable';
            const tabs = mdi.getTabItems().filter(tab => tab.content?.app?.id === config.appId
              || (tab._menuKey === config.menuId && String(tab.text || '').trim() === config.title));
            const owners = apps.filter(app => app.app?.id === config.appId);
            if (tabs.length > 1 || owners.length > 1) return 'Ambiguous';
            const shown = element => {
              const rect = element.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return false;
              for (let parent = element; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                if (parent.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
              }
              return true;
            };
            const modal = () => [...document.querySelectorAll('[role="dialog"],.cl-dialog')].some(shown);
            if (tabs.length === 1) {
              const tab = tabs[0];
              if (tab.content?.app?.id && tab.content.app.id !== config.appId) return 'Ambiguous';
              if (mdi.getSelectedTabItem() !== tab) {
                if (modal()) return 'Busy';
                mdi.setSelectedTabItem(tab);
                if (mdi.getSelectedTabItem() !== tab) return 'Busy';
              }
              return owners.length ? 'Selected' : 'Opening';
            }
            if (owners.length) return 'Ambiguous';
            if (modal()) return 'Busy';
            if (!allowOpen) return 'Missing';
            const ds = root.lookup('dsAllMenu'), module = root.getModule?.();
            const auth = root.lookup('subAuth');
            if (!ds?.getColumnNames || !ds.getRowCount || !ds.getRow || !ds.getValue
                || typeof module?.openMenuItem !== 'function' || !auth) return 'Unavailable';
            const required = ['MENU_ID','MENU_NM','V_MENU_ID','V_UP_MENU_ID','CALL_PAGE',
              'SHOW_YN','menuUseYn','inqAccesAuthYn'];
            if (!required.every(name => ds.getColumnNames().includes(name))) return 'Unavailable';
            const action = new URL(auth.action, location.href);
            if (action.origin !== location.origin || action.pathname !== '/menuCheckAuth.do') return 'Unavailable';
            if (!['IDLE','DONE'].includes(auth.status)
                || root.lookup('dmMenuParam')?.getValue('strMenuParamVal')) return 'Busy';
            const candidates = [];
            for (let row = 0; row < ds.getRowCount(); row++) {
              if (ds.getValue(row,'MENU_ID') !== config.menuId
                  || String(ds.getValue(row,'MENU_NM') || '').trim() !== config.title
                  || ds.getValue(row,'CALL_PAGE') !== config.appId
                  || ds.getValue(row,'SHOW_YN') !== 'Y' || ds.getValue(row,'menuUseYn') !== 'Y'
                  || ds.getValue(row,'inqAccesAuthYn') !== 'Y') continue;
              const path = [], visited = new Set();
              let current = row;
              for (let depth = 0; depth < 4 && current >= 0; depth++) {
                const key = ds.getValue(current,'V_MENU_ID');
                if (!key || visited.has(key)) break;
                visited.add(key);
                path.unshift(String(ds.getValue(current,'MENU_NM') || '').trim());
                const parent = ds.getValue(current,'V_UP_MENU_ID'), matches = [];
                for (let index = 0; index < ds.getRowCount(); index++)
                  if (ds.getValue(index,'V_MENU_ID') === parent) matches.push(index);
                current = matches.length === 1 ? matches[0] : -1;
              }
              if (JSON.stringify(path) === JSON.stringify(['학급담임','교육활동신청관리',config.parent,config.title]))
                candidates.push(row);
            }
            if (candidates.length !== 1) return candidates.length ? 'Ambiguous' : 'MenuMissing';
            module.openMenuItem({row:ds.getRow(candidates[0])}, 'btnTlbrMn');
            return 'Started';
          } catch { return 'Unavailable'; }
        })()
        """;

    // Explicit notification clicks may refresh an editable grid only when nothing
    // is changed, checked, or being edited. No student rows are read or returned.
    internal static string StudentManagementQueryScript(
        string officeDomain, PortalTaskKind kind, bool startQuery) => $$"""
        (() => {
          try {
            const host = {{JsonSerializer.Serialize(officeDomain)}};
            const kind = {{JsonSerializer.Serialize(kind.ToString())}};
            const startQuery = {{(startQuery ? "true" : "false")}};
            const configurations = {
              FieldTripApplicationManagement: {appId:'edu/sa/eds/eaa/ae/eds_eaaae01_m01',dataId:'dsStdntListForAply',endpoint:'/eds_eaa_ae01_002.do'},
              AbsenceReportManagement: {appId:'edu/sa/eds/eaa/ae/eds_eaaae03_m01',dataId:'dsStdntListForAbe',endpoint:'/eds_eaa_ae03_002.do'},
              FieldTripReportManagement: {appId:'edu/sa/eds/eaa/ae/eds_eaaae02_m01',dataId:'dsStdntListForRlt',endpoint:'/eds_eaa_ae02_002.do'}
            };
            const config = configurations[kind];
            if (!config || location.protocol !== 'https:' || location.hostname !== host
                || document.readyState !== 'complete') return 'Unavailable';
            const platform = globalThis.cpr?.core?.Platform?.INSTANCE;
            if (!platform?.getAllRunningAppInstances) return 'Unavailable';
            const apps = Object.values(platform.getAllRunningAppInstances()).filter(app => !app.disposed);
            const roots = apps.filter(app => app.app?.id === 'app/com/main/Index');
            const owners = apps.filter(app => app.app?.id === config.appId);
            if (roots.length !== 1 || owners.length > 1) return 'Ambiguous';
            if (owners.length !== 1) return 'Missing';
            const app = owners[0], mdi = roots[0].lookup('mdiCn');
            if (!mdi?.getSelectedTabItem || mdi.getSelectedTabItem()?.content?.app?.id !== config.appId)
              return 'Busy';
            const data = app.lookup(config.dataId), grid = app.lookup('grdMain');
            const search = app.lookup('dmSearch'), user = app.lookup('dmUserInfo');
            const button = app.lookup('btnSearch'), sub = app.lookup('subStdntList');
            if (!data || !grid || !search || !user || !button || !sub) return 'Loading';
            if (grid.dataSet !== data || button.value !== '조회' || !button.click
                || !data.isModified || !grid.getCheckRowIndices || !grid.getEditRowIndex
                || !sub.addEventListener || !sub.removeEventListener || !sub.isSuccess
                || !search.getDatas || !user.getValue) return 'Unavailable';
            const action = new URL(sub.action, location.href);
            if (action.origin !== location.origin || action.pathname !== config.endpoint) return 'Unavailable';
            const filled = value => String(value ?? '').trim().length > 0;
            if (!filled(user.getValue('userId')) || !filled(search.getValue('shlCd'))
                || !filled(search.getValue('ayr'))) return 'Loading';
            const context = () => {
              if (app.disposed || sub.disposed) return null;
              const account = String(user.getValue('userId') || '').trim();
              const liveUser = globalThis.createCommonUtil?.().Auth?.getUserInfo(app);
              if (!account || !liveUser || String(liveUser.getValue('userId') || '') !== account) return null;
              return JSON.stringify([account,search.getDatas()]);
            };
            const queryContext = context();
            if (!queryContext) return 'ScopeChanged';
            const selectors = [['cmbAyr','ayr'],['cmbOrgGrd','grd'],['cmbClsCd','clsCd'],
              ['cmbShlCrseScCd','shlCrseScCd'],['cmbDghtCresScCd','dghtCrseScCd'],
              ['cmbOrdGrdDddepCd','ordGrdDddepCd']];
            for (const [controlId,field] of selectors) {
              const control = app.lookup(controlId);
              if (control && (!control.getUDCApp?.() || !filled(search.getValue(field)))) return 'Loading';
            }
            const key = '__oneClickStudentManagementQueryV1';
            let observations = globalThis[key];
            if (observations === undefined) observations = globalThis[key] = new Map();
            if (!(observations instanceof Map)) return 'Unavailable';
            for (const [owner,observation] of observations) {
              if (owner.disposed || observation.sub.disposed) {
                observation.cleanup?.();
                observations.delete(owner);
              }
            }
            let observation = observations.get(app);
            if (observation && observation.sub !== sub) {
              if (observation.inFlight && !['IDLE','DONE'].includes(observation.sub.status)) return 'Busy';
              observation.cleanup?.();
              observations.delete(app);
              observation = undefined;
            }
            // A validation-only click can emit no submission event. Retire it after
            // a timeout only when the framework confirms there is no pending request.
            if (observation?.inFlight && Date.now() - observation.startedAt > 30000
                && ['IDLE','DONE'].includes(sub.status)) {
              observation.cleanup?.();
              observation.inFlight = false;
              observation.done = true;
              observation.success = false;
            }
            const shown = element => {
              const rect = element.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return false;
              for (let parent = element; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                if (parent.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
              }
              return true;
            };
            if ([...document.querySelectorAll('[role="dialog"],.cl-dialog')].some(shown)) return 'Busy';
            if (startQuery) {
              // Cancelling a background reader does not cancel a request it already
              // sent. Preserve that observer until the request completes or a stale
              // validation-only click is confirmed idle after its timeout.
              const reader = globalThis.__oneClickFieldTripReportReadV1;
              if (reader?.app === app && reader.sub === sub && reader.inFlight) {
                if (Date.now() - reader.startedAt <= 30000 || !['IDLE','DONE'].includes(sub.status)) return 'Busy';
                reader.cleanup?.();
                reader.inFlight = false;
                reader.done = true;
                reader.success = false;
              }
              if (observation?.inFlight || !['IDLE','DONE'].includes(sub.status)) return 'Busy';
              const modified = data.isModified(), checked = grid.getCheckRowIndices();
              const editRow = grid.getEditRowIndex();
              if (typeof modified !== 'boolean' || !Array.isArray(checked)
                  || !Number.isInteger(editRow) || editRow < -1) return 'Unavailable';
              if (!button.enabled || modified || checked.length > 0 || editRow >= 0) return 'Busy';
              observation?.cleanup?.();
              observation = {app,sub,queryContext,inFlight:true,success:false,done:false,
                stale:false,startedAt:Date.now(),completedAt:null,buttonClickCount:1};
              observations.set(app,observation);
              const success = () => { observation.success = true; };
              const failure = () => { observation.success = false; };
              const cleanup = () => {
                sub.removeEventListener('submit-success',success);
                sub.removeEventListener('submit-error',failure);
                sub.removeEventListener('submit-done',done);
              };
              const done = () => {
                observation.inFlight = false;
                observation.done = true;
                observation.completedAt = Date.now();
                try {
                  observation.stale = context() !== observation.queryContext;
                  observation.success = observation.success && sub.isSuccess() && !observation.stale;
                } catch { observation.success = false; observation.stale = true; }
                cleanup();
              };
              observation.cleanup = cleanup;
              sub.addEventListener('submit-success',success);
              sub.addEventListener('submit-error',failure);
              sub.addEventListener('submit-done',done);
              try { button.click(); }
              catch { failure(); done(); return 'QueryFailed'; }
              return 'Started';
            }
            if (!observation || observation.sub !== sub) return 'Unavailable';
            if (observation.queryContext !== queryContext || observation.stale) return 'ScopeChanged';
            if (observation.inFlight) return 'Started';
            if (!observation.done || !observation.success || !sub.isSuccess()
                || !['IDLE','DONE'].includes(sub.status)) return 'QueryFailed';
            return 'Complete';
          } catch { return 'Unavailable'; }
        })()
        """;
}
