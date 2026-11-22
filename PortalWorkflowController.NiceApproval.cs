using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal sealed partial class PortalWorkflowController
{
    private async Task<WorkflowResult> OpenNiceApprovalAsync(CancellationToken cancellationToken)
    {
        var target = await GetFieldTripNiceTargetAsync(cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await session.ResumeBackgroundPageAsync(cancellationToken);
        await WaitForNiceReadyAsync(session, cancellationToken);
        await session.ActivateTargetAsync(cancellationToken);
        await session.MaximizeTargetWindowAsync(cancellationToken);
        await PrepareActivatedTargetForBackgroundAsync(cancellationToken);
        _reportProgress("나이스 미결/협조함 여는 중");

        var state = await session.EvaluateStringAsync(
            NiceApprovalNavigationScript(_educationOffice.NiceDomain, allowOpen: false), cancellationToken);
        if (state == "Missing")
            state = await session.EvaluateStringAsync(
                NiceApprovalNavigationScript(_educationOffice.NiceDomain, allowOpen: true), cancellationToken);
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (state is "Started" or "Opening" or "Missing")
        {
            if (DateTime.UtcNow >= deadline)
                throw new TimeoutException("나이스 미결/협조함 화면을 여는 시간이 초과되었습니다.");
            await Task.Delay(250, cancellationToken);
            // Opening is attempted only once, even when the app loads slowly.
            state = await session.EvaluateStringAsync(
                NiceApprovalNavigationScript(_educationOffice.NiceDomain, allowOpen: false), cancellationToken);
        }
        if (state != "Selected")
            throw new InvalidOperationException(state switch
            {
                "Busy" => "열린 나이스 대화상자나 진행 중인 화면 전환을 확인한 뒤 다시 눌러 주세요.",
                "Ambiguous" => "나이스 미결/협조함 화면이나 메뉴가 여러 개라 이동할 대상을 정할 수 없습니다.",
                "MenuMissing" => "나이스의 미결/협조함 메뉴를 확인하지 못했습니다.",
                "Expired" => "나이스 로그인 상태를 확인한 뒤 다시 연결해 주세요.",
                _ => "나이스 미결/협조함 화면으로 이동하지 못했습니다. 나이스 연결 상태를 확인해 주세요.",
            });
        await PrepareBrowserForUserAsync(session, cancellationToken);
        return new WorkflowResult("나이스 미결/협조함을 열었습니다. 문서 확인과 최종 결재는 직접 진행합니다.",
            ForegroundWindow: session.PresentedWindowHandle, KeepActivatedBrowser: true);
    }

    // Verified Index contracts: snavAppvl's ordinary item-click calls this exported
    // doOpenNoMenu with exactly (callPage, menuNm). It supplies the site's menu/auth
    // context itself. Never synthesize auth data, select documents or click approval.
    internal static string NiceApprovalNavigationScript(string officeDomain, bool allowOpen) => $$"""
        (() => {
          try {
            const host = {{JsonSerializer.Serialize(officeDomain)}};
            const allowOpen = {{(allowOpen ? "true" : "false")}};
            const appId = 'edu/cm/wam/woa/pm/wam_woapm02_m00';
            const title = '미결/협조함', menuId = 'AMWAM40012';
            if (location.protocol !== 'https:' || location.hostname !== host
                || document.readyState !== 'complete') return 'Unavailable';
            if (String(location.pathname).toLowerCase().endsWith('/executeneislogout.do')
                || String(document.body?.innerText || '').replace(/\s/g,'').includes('나이스를로그아웃하였습니다'))
              return 'Expired';
            const platform = globalThis.cpr?.core?.Platform?.INSTANCE;
            if (!platform?.getAllRunningAppInstances) return 'Unavailable';
            const apps = Object.values(platform.getAllRunningAppInstances()).filter(app => !app.disposed);
            const roots = apps.filter(app => app.app?.id === 'app/com/main/Index');
            if (roots.length !== 1) return 'Ambiguous';
            const root = roots[0], mdi = root.lookup('mdiCn');
            if (!mdi?.getTabItems || !mdi.getSelectedTabItem || !mdi.setSelectedTabItem) return 'Unavailable';
            const account = String(root.lookup('dmUserInfo')?.getValue('userId') || '').trim();
            const liveUser = globalThis.createCommonUtil?.().Auth?.getUserInfo(root);
            if (!account || String(liveUser?.getValue('userId') || '') !== account) return 'Expired';
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
            const auth = root.lookup('subAuth');
            if (!auth || !['IDLE','DONE'].includes(auth.status)
                || root.lookup('dmMenuParam')?.getValue('strMenuParamVal')) return 'Busy';
            const tabs = mdi.getTabItems().filter(tab => tab.content?.app?.id === appId
              || ((tab._menuKey === appId || tab._menuKey === menuId) && String(tab.text || '').trim() === title));
            const owners = apps.filter(app => app.app?.id === appId);
            if (tabs.length > 1 || owners.length > 1) return 'Ambiguous';
            if (tabs.length === 1) {
              const tab = tabs[0];
              if (tab.content?.app?.id && tab.content.app.id !== appId) return 'Ambiguous';
              if (mdi.getSelectedTabItem() !== tab) {
                // Preserve the site's cancellable selection handlers for dirty screens.
                mdi.setSelectedTabItem(tab);
                if (mdi.getSelectedTabItem() !== tab) return 'Busy';
              }
              return owners.length ? 'Selected' : 'Opening';
            }
            if (owners.length) return 'Ambiguous';
            if (!allowOpen) return 'Missing';
            const data = root.lookup('dsApproval'), module = root.getModule?.();
            if (!data?.getColumnNames || !data.getRowCount || !data.getValue
                || typeof module?.doOpenNoMenu !== 'function') return 'Unavailable';
            const required = ['menuNm','menuId','pgeId','callPage'];
            if (!required.every(name => data.getColumnNames().includes(name))) return 'Unavailable';
            const matches = [];
            for (let row = 0; row < data.getRowCount(); row++) {
              if (data.getValue(row,'menuId') === menuId
                  && String(data.getValue(row,'menuNm') || '').trim() === title
                  && data.getValue(row,'pgeId') === 'wam_woapm02_m00'
                  && data.getValue(row,'callPage') === appId) matches.push(row);
            }
            if (matches.length !== 1) return matches.length ? 'Ambiguous' : 'MenuMissing';
            module.doOpenNoMenu(appId, title);
            return 'Started';
          } catch { return 'Unavailable'; }
        })()
        """;
}
