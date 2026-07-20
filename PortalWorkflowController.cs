using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal enum PortalTaskKind
{
    NiceHome,
    Leave,
    BusinessTrip,
    EdufineHome,
    Draft,
    PurchaseRequest,
}

internal sealed record WorkflowResult(
    string Message,
    IntPtr ForegroundWindow = default,
    bool KeepActivatedBrowser = false);

internal sealed class PortalWorkflowController
{
    private const string PortalDomain = "jbe.eduptl.kr";
    private const string NiceDomain = "jbe.neis.go.kr";
    private const string EdufineDomain = "klef.jbe.go.kr";

    private readonly int _devToolsPort;
    private readonly Action<string> _reportProgress;
    private readonly Action? _prepareBrowserWindowForBackground;

    public PortalWorkflowController(
        int devToolsPort,
        Action<string> reportProgress,
        Action? prepareBrowserWindowForBackground = null)
    {
        _devToolsPort = devToolsPort;
        _reportProgress = reportProgress;
        _prepareBrowserWindowForBackground = prepareBrowserWindowForBackground;
    }

    public async Task<WorkflowResult> RunAsync(PortalTaskKind taskKind, CancellationToken cancellationToken = default)
    {
        AppLogger.Info("Workflow", $"{taskKind} 시작");
        try
        {
            var result = await (taskKind switch
            {
                PortalTaskKind.NiceHome => OpenSystemHomeAsync(
                    "나이스",
                    NiceDomain,
                    "나이스",
                    WaitForNiceReadyAsync,
                    cancellationToken),
                PortalTaskKind.Leave => OpenNiceApplicationAsync(
                    "복무",
                    "개인근무상황관리",
                    "근무상황신청",
                    cancellationToken),
                PortalTaskKind.BusinessTrip => OpenNiceApplicationAsync(
                    "출장",
                    "개인출장관리",
                    "출장신청",
                    cancellationToken),
                PortalTaskKind.EdufineHome => OpenSystemHomeAsync(
                    "K-에듀파인",
                    EdufineDomain,
                    "K-에듀파인",
                    WaitForEdufineReadyAsync,
                    cancellationToken),
                PortalTaskKind.Draft => OpenDraftAsync(cancellationToken),
                PortalTaskKind.PurchaseRequest => OpenPurchaseRequestAsync(cancellationToken),
                _ => throw new ArgumentOutOfRangeException(nameof(taskKind)),
            });
            AppLogger.Info("Workflow", $"{taskKind} 완료");
            return result;
        }
        catch (Exception exception)
        {
            AppLogger.Error("Workflow", $"{taskKind} 실패", exception);
            throw;
        }
    }

    public async Task WarmUpAsync(CancellationToken cancellationToken = default)
    {
        AppLogger.Info("WarmUp", "업무 시스템 준비 시작");

        _reportProgress("연결: 나이스를 미리 여는 중");
        var niceTarget = await EnsureApplicationTargetAsync(NiceDomain, "나이스", cancellationToken);
        await using (var niceSession = await DevToolsSession.ConnectAsync(_devToolsPort, niceTarget.Id, cancellationToken))
        {
            await WaitForNiceReadyAsync(niceSession, cancellationToken);
        }
        AppLogger.Info("WarmUp", "나이스 준비 완료");

        _reportProgress("연결: K-에듀파인을 미리 여는 중");
        var edufineTarget = await EnsureApplicationTargetAsync(EdufineDomain, "K-에듀파인", cancellationToken);
        await using (var edufineSession = await DevToolsSession.ConnectAsync(_devToolsPort, edufineTarget.Id, cancellationToken))
        {
            await WaitForEdufineReadyAsync(edufineSession, cancellationToken);
        }
        AppLogger.Info("WarmUp", "K-에듀파인 준비 완료");

        _reportProgress("연결: 나이스와 K-에듀파인 준비 완료");
        AppLogger.Info("WarmUp", "업무 시스템 준비 완료");
    }

    public async Task<bool> RefreshNiceAsync(CancellationToken cancellationToken = default)
    {
        AppLogger.Info("NiceRefresh", "나이스 자동 갱신 확인 시작");
        var target = await EnsureApplicationTargetAsync(NiceDomain, "나이스", cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        var openDialog = await GetVisibleNiceRequestDialogAsync(session, cancellationToken);
        if (!string.IsNullOrEmpty(openDialog))
        {
            AppLogger.Info("NiceRefresh", $"{openDialog} 입력창이 열려 있어 자동 갱신을 건너뜁니다.");
            return false;
        }

        await session.ReloadAsync(cancellationToken);
        await WaitForNiceReadyAsync(session, cancellationToken);
        AppLogger.Info("NiceRefresh", "나이스 자동 갱신 완료");
        return true;
    }

    private async Task<WorkflowResult> OpenSystemHomeAsync(
        string displayName,
        string domain,
        string portalButtonName,
        Func<DevToolsSession, CancellationToken, Task> waitUntilReady,
        CancellationToken cancellationToken)
    {
        _reportProgress($"{displayName}: 화면 준비 중");
        var target = await EnsureApplicationTargetAsync(domain, portalButtonName, cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await waitUntilReady(session, cancellationToken);
        await PrepareBrowserForUserAsync(session, cancellationToken);
        return new WorkflowResult(
            $"{displayName} 화면을 열었습니다.",
            KeepActivatedBrowser: true);
    }

    private async Task<WorkflowResult> OpenNiceApplicationAsync(
        string displayName,
        string menuName,
        string dialogTitle,
        CancellationToken cancellationToken)
    {
        _reportProgress($"{displayName}: 나이스 연결 확인 중");
        var target = await EnsureApplicationTargetAsync(
            NiceDomain,
            "나이스",
            cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await WaitForNiceReadyAsync(session, cancellationToken);
        await session.ActivateTargetAsync(cancellationToken);
        await PrepareActivatedTargetForBackgroundAsync(cancellationToken);

        var openDialog = await GetVisibleNiceRequestDialogAsync(session, cancellationToken);
        if (string.Equals(openDialog, dialogTitle, StringComparison.Ordinal))
        {
            await PrepareBrowserForUserAsync(session, cancellationToken);
            return new WorkflowResult(
                $"이미 열려 있는 {displayName} 입력 화면을 표시했습니다. 내용을 계속 입력해 주세요.",
                KeepActivatedBrowser: true);
        }

        if (!string.IsNullOrEmpty(openDialog))
        {
            _reportProgress($"{displayName}: 열려 있는 {openDialog} 입력창 닫는 중");
            await CloseVisibleNiceRequestDialogAsync(session, openDialog, cancellationToken);
        }

        _reportProgress($"{displayName}: 복무 메뉴 여는 중");
        await EnsureNiceDutyMenuExpandedAsync(session, cancellationToken);

        _reportProgress($"{displayName}: {menuName} 이동 중");
        await ClickNiceMenuAsync(session, menuName, cancellationToken);
        await Task.Delay(750, cancellationToken);
        await WaitForConditionAsync(
            session,
            NiceControlVisibleExpression("신청"),
            TimeSpan.FromSeconds(30),
            cancellationToken,
            $"{menuName} 화면의 신청 버튼을 준비하는 시간이 초과되었습니다.");

        _reportProgress($"{displayName}: 신청 입력창 준비 중");
        await ClickNiceControlAsync(
            session,
            "신청",
            $"{menuName} 화면에서 신청 버튼을 찾지 못했습니다.",
            cancellationToken);

        await WaitForVisibleTextAsync(session, dialogTitle, TimeSpan.FromSeconds(20), cancellationToken);

        await PrepareBrowserForUserAsync(session, cancellationToken);
        return new WorkflowResult(
            $"{displayName} 입력 화면을 열었습니다. 내용을 입력한 뒤 승인요청은 직접 눌러 주세요.",
            KeepActivatedBrowser: true);
    }

    private async Task<WorkflowResult> OpenDraftAsync(CancellationToken cancellationToken)
    {
        _reportProgress("기안: K-에듀파인 연결 확인 중");
        var target = await EnsureApplicationTargetAsync(
            EdufineDomain,
            "K-에듀파인",
            cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await WaitForEdufineReadyAsync(session, cancellationToken);
        await session.ActivateTargetAsync(cancellationToken);
        await PrepareActivatedTargetForBackgroundAsync(cancellationToken);

        _reportProgress("기안: 업무관리로 전환 중");
        await SelectEdufineJobAsync(session, "업무관리", 0, cancellationToken);
        await ClickEdufineTopMenuAsync(session, "문서관리", cancellationToken);

        _reportProgress("기안: 공용서식으로 이동 중");
        await ClickEdufineMegaMenuAsync(session, "공용서식", cancellationToken);
        await WaitForTextAsync(
            session,
            "표준서식(결재4인,협조4인)",
            TimeSpan.FromSeconds(20),
            cancellationToken,
            searchFrames: true);
        await Task.Delay(750, cancellationToken);

        var existingWindows = BrowserWindowFinder
            .FindVisibleWindowsByProcess("WXSClient")
            .Select(window => window.Handle)
            .ToHashSet();

        _reportProgress("기안: 표준서식 편집기 실행 중");
        var opened = await session.EvaluateBooleanAsync(
            ClickExactTextInFramesScript("표준서식(결재4인,협조4인)"),
            userGesture: true,
            cancellationToken);
        if (!opened)
        {
            throw new InvalidOperationException("표준서식(결재4인,협조4인)을 찾지 못했습니다.");
        }

        var editorWindow = await WaitForEditorWindowAsync(existingWindows, cancellationToken);
        return new WorkflowResult(
            "기안 표준서식을 열었습니다. 내용을 입력한 뒤 결재올림은 직접 눌러 주세요.",
            editorWindow);
    }

    private async Task<WorkflowResult> OpenPurchaseRequestAsync(CancellationToken cancellationToken)
    {
        _reportProgress("품의: K-에듀파인 연결 확인 중");
        var target = await EnsureApplicationTargetAsync(
            EdufineDomain,
            "K-에듀파인",
            cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await WaitForEdufineReadyAsync(session, cancellationToken);
        await session.ActivateTargetAsync(cancellationToken);
        await PrepareActivatedTargetForBackgroundAsync(cancellationToken);

        _reportProgress("품의: 학교회계로 전환 중");
        await SelectEdufineJobAsync(session, "학교회계", 2, cancellationToken);
        await ClickEdufineTopMenuAsync(session, "사업관리", cancellationToken);

        _reportProgress("품의: 품의등록으로 이동 중");
        await ClickEdufineMegaMenuAsync(session, "품의등록", cancellationToken);
        await WaitForAllTextsAsync(
            session,
            new[] { "품의등록", "예산내역", "품목내역", "결재요청" },
            TimeSpan.FromSeconds(30),
            cancellationToken);

        await PrepareBrowserForUserAsync(session, cancellationToken);
        return new WorkflowResult(
            "품의등록 화면을 열었습니다. 내용을 입력한 뒤 결재요청은 직접 눌러 주세요.",
            KeepActivatedBrowser: true);
    }

    private static async Task PrepareBrowserForUserAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        await session.BringToFrontAsync(cancellationToken);
    }

    private async Task PrepareActivatedTargetForBackgroundAsync(CancellationToken cancellationToken)
    {
        _prepareBrowserWindowForBackground?.Invoke();
        await Task.Delay(100, cancellationToken);
    }

    private async Task<DevToolsTarget> EnsureApplicationTargetAsync(
        string domain,
        string portalButtonName,
        CancellationToken cancellationToken)
    {
        var targets = await DevToolsDiscovery.GetTargetsAsync(_devToolsPort, cancellationToken);
        var existing = FindPageTarget(targets, domain);
        if (existing is not null)
        {
            return existing;
        }

        var portal = FindPageTarget(targets, PortalDomain)
            ?? throw new InvalidOperationException("로그인된 업무포털 탭을 찾지 못했습니다.");
        await using (var portalSession = await DevToolsSession.ConnectAsync(_devToolsPort, portal.Id, cancellationToken))
        {
            var clicked = await portalSession.EvaluateBooleanAsync(
                ClickPortalApplicationScript(portalButtonName),
                userGesture: true,
                cancellationToken);
            if (!clicked)
            {
                throw new InvalidOperationException($"업무포털에서 {portalButtonName} 버튼을 찾지 못했습니다.");
            }
        }

        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(300, cancellationToken);
            targets = await DevToolsDiscovery.GetTargetsAsync(_devToolsPort, cancellationToken);
            existing = FindPageTarget(targets, domain);
            if (existing is not null)
            {
                return existing;
            }
        }

        throw new TimeoutException($"{portalButtonName} 화면이 열리지 않았습니다. 로그인 또는 보안 프로그램 상태를 확인해 주세요.");
    }

    private static DevToolsTarget? FindPageTarget(IEnumerable<DevToolsTarget> targets, string domain)
    {
        return targets.FirstOrDefault(target =>
            target.Type == "page"
            && target.Url.Contains(domain, StringComparison.OrdinalIgnoreCase));
    }

    private static Task WaitForNiceReadyAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        const string expression = "document.readyState==='complete'&&[...document.querySelectorAll('.cl-text')].some(e=>"
            + "(e.textContent||'').trim().startsWith('복무 '))";
        return WaitForConditionAsync(
            session,
            expression,
            TimeSpan.FromSeconds(45),
            cancellationToken,
            "나이스 기본 메뉴를 준비하는 시간이 초과되었습니다.");
    }

    private static Task WaitForEdufineReadyAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        const string expression = "document.readyState==='complete'&&!!document.querySelector(\"[id$='cboJobList.comboedit:input']\")";
        return WaitForConditionAsync(
            session,
            expression,
            TimeSpan.FromSeconds(45),
            cancellationToken,
            "K-에듀파인 업무 화면을 준비하는 시간이 초과되었습니다.");
    }

    private static async Task EnsureNiceDutyMenuExpandedAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            if (await IsNiceMenuVisibleAsync(session, "개인근무상황관리", cancellationToken))
            {
                return;
            }

            await ClickNiceMenuAsync(session, "복무", cancellationToken);
            try
            {
                await WaitForConditionAsync(
                    session,
                    NiceMenuVisibleExpression("개인근무상황관리"),
                    TimeSpan.FromSeconds(12),
                    cancellationToken,
                    "나이스 복무 하위 메뉴를 여는 시간이 초과되었습니다.");
                return;
            }
            catch (TimeoutException) when (attempt < 3)
            {
                AppLogger.Info("Workflow", $"나이스 복무 메뉴 열기를 재시도합니다. ({attempt}/3)");
                await Task.Delay(750, cancellationToken);
            }
        }

        throw new TimeoutException("나이스 복무 하위 메뉴를 열지 못했습니다.");
    }

    private static async Task ClickNiceMenuAsync(
        DevToolsSession session,
        string menuName,
        CancellationToken cancellationToken)
    {
        var value = JsonSerializer.Serialize(menuName + " ");
        var elementExpression = "(()=>{const n=" + value + ";const t=[...document.querySelectorAll('.cl-text')].find(e=>{"
            + "const r=e.getBoundingClientRect();const s=getComputedStyle(e);return (e.textContent||'').trim().startsWith(n)"
            + "&&r.width>0&&r.height>0&&r.x>=0&&s.display!=='none'&&s.visibility!=='hidden';});"
            + "return t?(t.closest('a')||t):null;})()";
        await ClickElementCenterAsync(
            session,
            elementExpression,
            $"나이스에서 {menuName} 메뉴를 찾지 못했습니다.",
            TimeSpan.FromSeconds(15),
            cancellationToken);
    }

    private static Task<bool> IsNiceMenuVisibleAsync(
        DevToolsSession session,
        string menuName,
        CancellationToken cancellationToken)
    {
        return session.EvaluateBooleanAsync(NiceMenuVisibleExpression(menuName), cancellationToken: cancellationToken);
    }

    private static async Task<string> GetVisibleNiceRequestDialogAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        const string expression = "(()=>{const names=['근무상황신청','출장신청'];const visible=e=>{"
            + "const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.x>=0&&r.y>=0"
            + "&&s.display!=='none'&&s.visibility!=='hidden';};for(const e of document.querySelectorAll('.cl-dialog-header .cl-text,h1.cl-text')){"
            + "const t=(e.textContent||'').trim();if(names.includes(t)&&visible(e))return t;}return '';})()";
        return await session.EvaluateStringAsync(expression, cancellationToken) ?? string.Empty;
    }

    private static async Task CloseVisibleNiceRequestDialogAsync(
        DevToolsSession session,
        string dialogTitle,
        CancellationToken cancellationToken)
    {
        var title = JsonSerializer.Serialize(dialogTitle);
        var elementExpression = "(()=>{const n=" + title + ";const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);"
            + "return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&s.display!=='none'&&s.visibility!=='hidden';};"
            + "const h=[...document.querySelectorAll('.cl-dialog-header .cl-text,h1.cl-text')].find(e=>"
            + "(e.textContent||'').trim()===n&&visible(e));if(!h)return null;const d=h.closest('.cl-dialog');if(!d)return null;"
            + "return d.querySelector('.cl-dialog-header .cl-dialog-close')||d.querySelector('.cl-dialog-close')"
            + "||[...d.querySelectorAll('.cl-button')].find(e=>(e.textContent||'').trim()==='닫기'&&visible(e));"
            + "})()";
        await ClickElementCenterAsync(
            session,
            elementExpression,
            $"열려 있는 {dialogTitle} 입력창의 닫기 버튼을 찾지 못했습니다.",
            TimeSpan.FromSeconds(5),
            cancellationToken);

        await WaitForConditionAsync(
            session,
            $"!(()=>{{const n={title};const visible=e=>{{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}};return [...document.querySelectorAll('.cl-dialog-header .cl-text,h1.cl-text')].some(e=>(e.textContent||'').trim()===n&&visible(e));}})()",
            TimeSpan.FromSeconds(10),
            cancellationToken,
            $"{dialogTitle} 입력창이 닫히는 시간이 초과되었습니다.");
        AppLogger.Info("Workflow", $"{dialogTitle} 입력창을 닫았습니다.");
    }

    private static async Task SelectEdufineJobAsync(
        DevToolsSession session,
        string jobName,
        int jobIndex,
        CancellationToken cancellationToken)
    {
        const string inputSelector = "[id$='cboJobList.comboedit:input']";
        const string buttonSelector = "[id$='cboJobList.dropbutton']";
        await WaitForConditionAsync(
            session,
            $"!!document.querySelector({JsonSerializer.Serialize(inputSelector)})",
            TimeSpan.FromSeconds(20),
            cancellationToken);
        var current = await session.EvaluateStringAsync(
            $"document.querySelector({JsonSerializer.Serialize(inputSelector)})?.value ?? ''",
            cancellationToken);
        if (string.Equals(current, jobName, StringComparison.Ordinal))
        {
            return;
        }

        await ClickElementCenterAsync(
            session,
            $"document.querySelector({JsonSerializer.Serialize(buttonSelector)})",
            "K-에듀파인 업무 선택 상자를 찾지 못했습니다.",
            TimeSpan.FromSeconds(20),
            cancellationToken);

        for (var count = 0; count < 6; count++)
        {
            await session.PressKeyAsync("ArrowUp", "ArrowUp", 38, cancellationToken);
        }

        for (var count = 0; count < jobIndex; count++)
        {
            await session.PressKeyAsync("ArrowDown", "ArrowDown", 40, cancellationToken);
        }

        await session.PressKeyAsync("Enter", "Enter", 13, cancellationToken);
        await WaitForConditionAsync(
            session,
            $"document.querySelector({JsonSerializer.Serialize(inputSelector)})?.value === {JsonSerializer.Serialize(jobName)}",
            TimeSpan.FromSeconds(25),
            cancellationToken);
        await Task.Delay(800, cancellationToken);
    }

    private static async Task ClickEdufineTopMenuAsync(
        DevToolsSession session,
        string menuName,
        CancellationToken cancellationToken)
    {
        var name = JsonSerializer.Serialize(menuName);
        var elementExpression = "(()=>{const n=" + name + ";const v=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.x>=0};"
            + "const xs=[...document.querySelectorAll('[id*=\"TopFrame\"][id*=\"btnMenu_\"]')].filter(e=>(e.textContent||'').trim()===n&&v(e));"
            + "return xs.find(x=>x.id.endsWith(':icontext'))||xs[0]||null;})()";
        await ClickElementCenterAsync(
            session,
            elementExpression,
            $"K-에듀파인 상단에서 {menuName} 메뉴를 찾지 못했습니다.",
            TimeSpan.FromSeconds(15),
            cancellationToken);

        await Task.Delay(800, cancellationToken);
    }

    private static async Task ClickEdufineMegaMenuAsync(
        DevToolsSession session,
        string menuName,
        CancellationToken cancellationToken)
    {
        var name = JsonSerializer.Serialize(menuName);
        var elementExpression = "(()=>{const n=" + name + ";const v=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.x>=0};"
            + "const xs=[...document.querySelectorAll('[id*=\"pdvMegaMenu\"]')].filter(e=>(e.textContent||'').trim()===n&&v(e));"
            + "return xs.find(x=>x.id.endsWith(':text'))||xs.at(-1)||null;})()";
        await ClickElementCenterAsync(
            session,
            elementExpression,
            $"K-에듀파인에서 {menuName} 메뉴를 찾지 못했습니다.",
            TimeSpan.FromSeconds(20),
            cancellationToken);
    }

    private static async Task ClickElementCenterAsync(
        DevToolsSession session,
        string elementExpression,
        string errorMessage,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var rectExpression = "(()=>{const e=(" + elementExpression + ");if(!e)return null;"
            + "const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()";
        var deadline = DateTime.UtcNow + timeout;
        Exception? lastException = null;
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var rect = await session.EvaluateAsync(rectExpression, cancellationToken: cancellationToken);
                if (rect.ValueKind == JsonValueKind.Object)
                {
                    var x = rect.GetProperty("x").GetDouble() + rect.GetProperty("w").GetDouble() / 2;
                    var y = rect.GetProperty("y").GetDouble() + rect.GetProperty("h").GetDouble() / 2;
                    await session.ClickAsync(x, y, cancellationToken);
                    return;
                }
            }
            catch (InvalidOperationException exception)
            {
                lastException = exception;
                AppLogger.Info("Workflow", "화면 요소가 다시 그려져 탐색을 재시도합니다.");
            }

            await Task.Delay(200, cancellationToken);
        }

        throw new InvalidOperationException(errorMessage, lastException);
    }

    private static async Task<IntPtr> WaitForEditorWindowAsync(
        HashSet<IntPtr> existingWindows,
        CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(60);
        BrowserWindowItem? fallback = null;
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var windows = BrowserWindowFinder
                .FindVisibleWindowsByProcess("WXSClient")
                .Where(window => window.Title.Contains("표준서식", StringComparison.Ordinal))
                .ToList();
            var newWindow = windows.FirstOrDefault(window => !existingWindows.Contains(window.Handle));
            if (newWindow is not null)
            {
                return newWindow.Handle;
            }

            fallback ??= windows.FirstOrDefault();
            await Task.Delay(300, cancellationToken);
        }

        if (fallback is not null)
        {
            return fallback.Handle;
        }

        throw new TimeoutException("기안 편집기 창이 열리지 않았습니다. WXSClient 설치 상태를 확인해 주세요.");
    }

    private static async Task ClickNiceControlAsync(
        DevToolsSession session,
        string text,
        string errorMessage,
        CancellationToken cancellationToken)
    {
        var value = JsonSerializer.Serialize(text);
        var elementExpression = "(()=>{const n=" + value + ";const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);"
            + "return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&s.display!=='none'&&s.visibility!=='hidden';};"
            + "const xs=[...document.querySelectorAll('.cl-button,button,a')].filter(e=>(e.textContent||'').trim()===n&&visible(e));"
            + "return xs.find(e=>e.classList.contains('btn-primary')&&e.classList.contains('cl-button'))"
            + "||xs.find(e=>e.classList.contains('cl-button'))||xs[0]||null;})()";
        var clickExpression = "(()=>{const e=(" + elementExpression + ");if(!e)return false;e.click();return true;})()";
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(20);
        Exception? lastException = null;
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                if (await session.EvaluateBooleanAsync(clickExpression, userGesture: true, cancellationToken))
                {
                    return;
                }
            }
            catch (InvalidOperationException exception)
            {
                lastException = exception;
                AppLogger.Info("Workflow", "나이스 버튼 클릭을 재시도합니다.");
            }

            await Task.Delay(250, cancellationToken);
        }

        throw new InvalidOperationException(errorMessage, lastException);
    }

    private static Task WaitForVisibleTextAsync(
        DevToolsSession session,
        string text,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var value = JsonSerializer.Serialize(text);
        var expression = "(()=>{const n=" + value + ";return [...document.querySelectorAll('*')].some(e=>{"
            + "const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.x>=0&&r.y>=0"
            + "&&s.display!=='none'&&s.visibility!=='hidden'&&(e.textContent||'').trim()===n;});})()";
        return WaitForConditionAsync(session, expression, timeout, cancellationToken);
    }

    private static Task WaitForTextAsync(
        DevToolsSession session,
        string text,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        bool searchFrames = false)
    {
        var expression = searchFrames
            ? TextExistsInFramesExpression(text)
            : $"(document.body?.innerText ?? '').includes({JsonSerializer.Serialize(text)})";
        return WaitForConditionAsync(session, expression, timeout, cancellationToken);
    }

    private static Task WaitForAllTextsAsync(
        DevToolsSession session,
        IReadOnlyCollection<string> texts,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var conditions = texts.Select(text =>
            $"(document.body?.innerText ?? '').includes({JsonSerializer.Serialize(text)})");
        return WaitForConditionAsync(
            session,
            string.Join(" && ", conditions),
            timeout,
            cancellationToken);
    }

    private static async Task WaitForConditionAsync(
        DevToolsSession session,
        string expression,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        string timeoutMessage = "업무 화면을 불러오는 시간이 초과되었습니다.")
    {
        var deadline = DateTime.UtcNow + timeout;
        Exception? lastException = null;
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                if (await session.EvaluateBooleanAsync(expression, cancellationToken: cancellationToken))
                {
                    return;
                }
            }
            catch (InvalidOperationException exception)
            {
                lastException = exception;
                AppLogger.Info("Workflow", "페이지 상태 확인을 재시도합니다.");
            }

            await Task.Delay(250, cancellationToken);
        }

        throw new TimeoutException(timeoutMessage, lastException);
    }

    private static string ClickPortalApplicationScript(string applicationName)
    {
        var value = JsonSerializer.Serialize(applicationName);
        return "(()=>{const n=" + value + ";const a=[...document.querySelectorAll('a.menuBtn,a')].find(e=>"
            + "(e.textContent||'').trim()===n&&e.getBoundingClientRect().width>0);if(!a)return false;a.click();return true;})()";
    }

    private static string NiceMenuVisibleExpression(string menuName)
    {
        var value = JsonSerializer.Serialize(menuName + " ");
        return "(()=>{const n=" + value + ";return [...document.querySelectorAll('.cl-text')].some(e=>{"
            + "const r=e.getBoundingClientRect(),s=getComputedStyle(e);return (e.textContent||'').trim().startsWith(n)"
            + "&&r.width>0&&r.height>0&&r.x>=0&&s.display!=='none'&&s.visibility!=='hidden';});})()";
    }

    private static string NiceControlVisibleExpression(string text)
    {
        var value = JsonSerializer.Serialize(text);
        return "(()=>{const n=" + value + ";return [...document.querySelectorAll('.cl-button,button,a')].some(e=>{"
            + "const r=e.getBoundingClientRect(),s=getComputedStyle(e);return (e.textContent||'').trim()===n"
            + "&&r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&s.display!=='none'&&s.visibility!=='hidden';});})()";
    }

    private static string TextExistsInFramesExpression(string text)
    {
        var value = JsonSerializer.Serialize(text);
        return "(()=>{const n=" + value + ";const visit=d=>{if((d.body?.innerText||'').includes(n))return true;"
            + "for(const f of d.querySelectorAll('iframe,frame')){try{if(f.contentDocument&&visit(f.contentDocument))return true;}catch{}}"
            + "return false;};return visit(document);})()";
    }

    private static string ClickExactTextInFramesScript(string text)
    {
        var value = JsonSerializer.Serialize(text);
        return "(()=>{const n=" + value + ";const visit=d=>{const xs=[...d.querySelectorAll('*')].filter(e=>(e.textContent||'').trim()===n);"
            + "const e=xs.sort((a,b)=>a.children.length-b.children.length)[0];if(e){(e.closest('a,button')||e).click();return true;}"
            + "for(const f of d.querySelectorAll('iframe,frame')){try{if(f.contentDocument&&visit(f.contentDocument))return true;}catch{}}"
            + "return false;};return visit(document);})()";
    }
}
