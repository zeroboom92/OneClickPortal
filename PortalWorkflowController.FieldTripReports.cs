using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal sealed partial class PortalWorkflowController
{
    internal async Task EnsureFieldTripReportReadyAsync(CancellationToken cancellationToken)
    {
        var target = await GetFieldTripNiceTargetAsync(cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await session.ResumeBackgroundPageAsync(cancellationToken);
        await WaitForNiceReadyAsync(session, cancellationToken);
        var state = await session.EvaluateStringAsync(
            FieldTripReportPreparationScript(_educationOffice.NiceDomain, allowOpen: false), cancellationToken);
        if (state == "Ready") return;
        ThrowIfFieldTripPreparationUnavailable(state);

        if (state is "Missing" or "Opening" or "Loading")
        {
            // A minimized Chromium window does not render a newly added CPR app.
            // Only missing/loading apps need this; a ready report keeps its current UI.
            await session.ActivateTargetAsync(cancellationToken);
            await session.MaximizeTargetWindowAsync(cancellationToken);
            _reportProgress("교외체험학습보고서를 먼저 확인하는 중");
            state = await session.EvaluateStringAsync(
                FieldTripReportPreparationScript(_educationOffice.NiceDomain, allowOpen: true), cancellationToken);
            ThrowIfFieldTripPreparationUnavailable(state);
        }

        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (state != "Ready")
        {
            if (DateTime.UtcNow >= deadline)
                throw new TimeoutException("교외체험학습보고서 조회 조건을 준비하는 시간이 초과되었습니다.");
            await Task.Delay(250, cancellationToken);
            state = await session.EvaluateStringAsync(
                FieldTripReportPreparationScript(_educationOffice.NiceDomain, allowOpen: false), cancellationToken);
            ThrowIfFieldTripPreparationUnavailable(state);
        }
    }

    private static void ThrowIfFieldTripPreparationUnavailable(string? state)
    {
        if (state is "Ready" or "Started" or "Missing" or "Opening" or "Loading") return;
        throw new InvalidOperationException(state switch
        {
            "Busy" => "나이스에서 진행 중인 작업이 있어 보고서 자동 확인을 잠시 미룹니다.",
            "Ambiguous" => "교외체험학습보고서관리 화면이나 학급담임 메뉴가 여러 개라 확인할 대상을 정할 수 없습니다.",
            "MenuMissing" => "학급담임의 교외체험학습보고서관리 메뉴를 확인하지 못했습니다.",
            _ => "교외체험학습보고서관리의 조회 화면을 확인하지 못했습니다.",
        });
    }

    private async Task<DevToolsTarget> GetFieldTripNiceTargetAsync(CancellationToken cancellationToken)
    {
        var targets = (await DevToolsDiscovery.GetTargetsAsync(_devToolsPort, cancellationToken))
            .Where(target => target.Type == "page"
                && Uri.TryCreate(target.Url, UriKind.Absolute, out var uri)
                && uri.Scheme == Uri.UriSchemeHttps
                && string.Equals(uri.Host, _educationOffice.NiceDomain, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (targets.Length != 1)
            throw new InvalidOperationException("로그인된 나이스 탭을 하나만 열어 주세요.");
        return targets[0];
    }

    private async Task<WorkflowResult> OpenFieldTripReportManagementAsync(CancellationToken cancellationToken)
    {
        var target = await GetFieldTripNiceTargetAsync(cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await session.ResumeBackgroundPageAsync(cancellationToken);
        await WaitForNiceReadyAsync(session, cancellationToken);
        await session.ActivateTargetAsync(cancellationToken);
        await session.MaximizeTargetWindowAsync(cancellationToken);
        await PrepareActivatedTargetForBackgroundAsync(cancellationToken);
        _reportProgress("교외체험학습보고서관리 여는 중");
        var state = await session.EvaluateStringAsync(
            FieldTripReportSelectionScript(_educationOffice.NiceDomain), cancellationToken);
        if (state is "Missing" or "Opening")
        {
            // Only a genuinely absent/loading report needs preparation. Opening an
            // existing report must not depend on whether its rows can be queried now.
            await EnsureFieldTripReportReadyAsync(cancellationToken);
            state = await session.EvaluateStringAsync(
                FieldTripReportSelectionScript(_educationOffice.NiceDomain), cancellationToken);
        }
        if (state != "Selected")
            throw new InvalidOperationException(state switch
            {
                "Busy" => "열린 나이스 대화상자나 진행 중인 화면 전환을 확인한 뒤 다시 눌러 주세요.",
                "Ambiguous" => "보고서관리 화면이 여러 개라 이동할 대상을 정할 수 없습니다.",
                _ => "교외체험학습보고서관리 화면으로 이동하지 못했습니다. 나이스 연결 상태를 확인해 주세요.",
            });
        await QueryStudentManagementAsync(PortalTaskKind.FieldTripReportManagement, cancellationToken);
        return new WorkflowResult("교외체험학습보고서관리 조회가 완료되었습니다. 최종 상신은 직접 진행합니다.",
            KeepActivatedBrowser: true);
    }

    // Selecting the site's own tab object works even when its caption is hidden or
    // outside the visible tab strip. It fires the normal cancellable selection event.
    internal static string FieldTripReportSelectionScript(string officeDomain) => $$"""
        (() => {
          try {
            const host = {{JsonSerializer.Serialize(officeDomain)}};
            const reportId = 'edu/sa/eds/eaa/ae/eds_eaaae02_m01';
            const menuId = 'AMEDS40511', title = '교외체험학습보고서관리';
            if (location.protocol !== 'https:' || location.hostname !== host
                || document.readyState !== 'complete') return 'Unavailable';
            const platform = globalThis.cpr?.core?.Platform?.INSTANCE;
            if (!platform?.getAllRunningAppInstances) return 'Unavailable';
            const apps = Object.values(platform.getAllRunningAppInstances()).filter(a => !a.disposed);
            const roots = apps.filter(a => a.app?.id === 'app/com/main/Index');
            if (roots.length !== 1) return 'Ambiguous';
            const mdi = roots[0].lookup('mdiCn');
            if (!mdi?.getTabItems || !mdi.getSelectedTabItem || !mdi.setSelectedTabItem) return 'Unavailable';
            const tabs = mdi.getTabItems().filter(t => t.content?.app?.id === reportId
              || (t._menuKey === menuId && t.text === title));
            const owners = apps.filter(a => a.app?.id === reportId);
            if (tabs.length > 1 || owners.length > 1) return 'Ambiguous';
            if (!tabs.length) return owners.length ? 'Ambiguous' : 'Missing';
            const tab = tabs[0];
            if (tab.content?.app?.id && tab.content.app.id !== reportId) return 'Ambiguous';
            const shown = element => {
              const rect = element.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return false;
              for (let p = element; p; p = p.parentElement) {
                const style = getComputedStyle(p);
                if (p.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
              }
              return true;
            };
            if (mdi.getSelectedTabItem() !== tab) {
              if ([...document.querySelectorAll('[role="dialog"],.cl-dialog')].some(shown)) return 'Busy';
              mdi.setSelectedTabItem(tab);
              if (mdi.getSelectedTabItem() !== tab) return 'Busy';
            }
            return owners.length ? 'Selected' : 'Opening';
          } catch { return 'Unavailable'; }
        })()
        """;

    // Verified against the official Index menu and report app on 2026-10-15.
    // Open the normal authorized menu once; never reload a tab or submit a report.
    internal static string FieldTripReportPreparationScript(string officeDomain, bool allowOpen) => $$"""
        (() => {
          try {
            const host = {{JsonSerializer.Serialize(officeDomain)}};
            const allowOpen = {{(allowOpen ? "true" : "false")}};
            const reportId = 'edu/sa/eds/eaa/ae/eds_eaaae02_m01';
            const menuId = 'AMEDS40511', title = '교외체험학습보고서관리';
            if (location.protocol !== 'https:' || location.hostname !== host
                || document.readyState !== 'complete') return 'Unavailable';
            const platform = globalThis.cpr?.core?.Platform?.INSTANCE;
            if (!platform?.getAllRunningAppInstances) return 'Unavailable';
            const apps = Object.values(platform.getAllRunningAppInstances()).filter(a => !a.disposed);
            const roots = apps.filter(a => a.app?.id === 'app/com/main/Index');
            if (roots.length !== 1) return 'Ambiguous';
            const root = roots[0], mdi = root.lookup('mdiCn');
            if (!mdi?.getTabItems) return 'Unavailable';
            const shown = element => {
              if (!element) return false;
              const rect = element.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return false;
              for (let p = element; p; p = p.parentElement) {
                const style = getComputedStyle(p);
                if (p.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
              }
              return true;
            };
            if ([...document.querySelectorAll('[role="dialog"],.cl-dialog')].some(shown)) return 'Busy';
            const tabs = mdi.getTabItems().filter(t => t._menuKey === menuId
              || t.content?.app?.id === reportId || t.text === title);
            const owners = apps.filter(a => a.app?.id === reportId);
            if (tabs.length > 1 || owners.length > 1) return 'Ambiguous';
            if (owners.length === 1) {
              const app = owners[0], search = app.lookup('dmSearch'), user = app.lookup('dmUserInfo');
              const button = app.lookup('btnSearch'), sub = app.lookup('subStdntList');
              const grid = app.lookup('grdMain'), data = app.lookup('dsStdntListForRlt');
              if (!search || !user || !button || !sub || !grid || !data) return 'Loading';
              const action = new URL(sub.action, location.href);
              if (action.protocol !== 'https:' || action.hostname !== host
                  || action.pathname !== '/eds_eaa_ae02_002.do' || grid.dataSet !== data
                  || button.value !== '조회') return 'Unavailable';
              const filled = value => String(value ?? '').trim().length > 0;
              if (!filled(user.getValue('userId')) || !filled(search.getValue('shlCd'))
                  || !filled(search.getValue('ayr'))) return 'Loading';
              const liveUser = globalThis.createCommonUtil?.().Auth?.getUserInfo(app);
              if (!liveUser || String(liveUser.getValue('userId') || '') !== String(user.getValue('userId') || ''))
                return 'Unavailable';
              // Removed school-course controls are absent; wait for every remaining auth selector.
              const selectors = [['cmbAyr','ayr'],['cmbOrgGrd','grd'],['cmbClsCd','clsCd'],
                ['cmbShlCrseScCd','shlCrseScCd'],['cmbDghtCresScCd','dghtCrseScCd'],
                ['cmbOrdGrdDddepCd','ordGrdDddepCd']];
              for (const [controlId, field] of selectors) {
                const control = app.lookup(controlId);
                if (control && (!control.getUDCApp?.() || !filled(search.getValue(field)))) return 'Loading';
              }
              if (!button.enabled || !grid.readOnly || grid.getCheckRowIndices().length > 0
                  || !['IDLE','DONE'].includes(sub.status)) return 'Busy';
              return 'Ready';
            }
            // A tab may exist before its embedded app is rendered. Never add it twice.
            if (tabs.length === 1) return 'Opening';
            if (!allowOpen) return 'Missing';
            const ds = root.lookup('dsAllMenu'), module = root.getModule?.();
            const auth = root.lookup('subAuth');
            if (!ds?.getColumnNames || typeof module?.openMenuItem !== 'function' || !auth) return 'Unavailable';
            const columns = ['MENU_ID','MENU_NM','V_MENU_ID','V_UP_MENU_ID','CALL_PAGE',
              'SHOW_YN','menuUseYn','inqAccesAuthYn'];
            if (!columns.every(name => ds.getColumnNames().includes(name))) return 'Unavailable';
            const authAction = new URL(auth.action, location.href);
            if (authAction.protocol !== 'https:' || authAction.hostname !== host
                || authAction.pathname !== '/menuCheckAuth.do') return 'Unavailable';
            if (!['IDLE','DONE'].includes(auth.status)
                || root.lookup('dmMenuParam')?.getValue('strMenuParamVal')) return 'Busy';
            const candidates = [];
            for (let row = 0; row < ds.getRowCount(); row++) {
              if (ds.getValue(row,'MENU_ID') !== menuId || ds.getValue(row,'MENU_NM') !== title
                  || ds.getValue(row,'CALL_PAGE') !== reportId || ds.getValue(row,'SHOW_YN') !== 'Y'
                  || ds.getValue(row,'menuUseYn') !== 'Y' || ds.getValue(row,'inqAccesAuthYn') !== 'Y') continue;
              const path = [], visited = new Set();
              let current = row;
              for (let depth = 0; depth < 4 && current >= 0; depth++) {
                const key = ds.getValue(current,'V_MENU_ID');
                if (!key || visited.has(key)) break;
                visited.add(key);
                path.unshift(ds.getValue(current,'MENU_NM'));
                const parent = ds.getValue(current,'V_UP_MENU_ID'), matches = [];
                for (let index = 0; index < ds.getRowCount(); index++)
                  if (ds.getValue(index,'V_MENU_ID') === parent) matches.push(index);
                current = matches.length === 1 ? matches[0] : -1;
              }
              if (JSON.stringify(path) === JSON.stringify(['학급담임','교육활동신청관리','교외체험학습관리',title]))
                candidates.push(row);
            }
            if (candidates.length !== 1) return candidates.length ? 'Ambiguous' : 'MenuMissing';
            // The site's ordinary menu handler performs its existing subAuth permission check.
            module.openMenuItem({row:ds.getRow(candidates[0])}, 'btnTlbrMn');
            return 'Started';
          } catch { return 'Unavailable'; }
        })()
        """;
}
