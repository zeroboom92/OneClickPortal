using System.Text.Json;
using System.Collections.Concurrent;

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
    private const int SessionExtensionThresholdSeconds = 20 * 60;
    private static readonly TimeSpan SessionExtensionRetryDelay = TimeSpan.FromMinutes(5);
    private static readonly ConcurrentDictionary<string, DateTime> LastSessionExtensionAttemptUtc = new();

    private readonly int _devToolsPort;
    private readonly EducationOffice _educationOffice;
    private readonly Action<string> _reportProgress;
    private readonly Action? _prepareBrowserWindowForBackground;

    public PortalWorkflowController(
        int devToolsPort,
        EducationOffice educationOffice,
        Action<string> reportProgress,
        Action? prepareBrowserWindowForBackground = null)
    {
        _devToolsPort = devToolsPort;
        _educationOffice = educationOffice;
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
                    _educationOffice.NiceDomain,
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
                    _educationOffice.EdufineDomain,
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

    public async Task PrepareApplicationTargetsAsync(CancellationToken cancellationToken = default)
    {
        AppLogger.Info("Connection", "업무 시스템 준비 시작");
        await TryCloseVisiblePortalNoticeAsync(cancellationToken);

        _reportProgress("나이스를 미리 여는 중");
        var niceTarget = await EnsureApplicationTargetAsync(
            _educationOffice.NiceDomain,
            "나이스",
            "나이스",
            _educationOffice.NiceUri,
            cancellationToken);
        await using (var niceSession = await DevToolsSession.ConnectAsync(
            _devToolsPort,
            niceTarget.Id,
            cancellationToken))
        {
            await WaitForNiceReadyAsync(niceSession, cancellationToken);
            await TryCloseVisibleNiceNoticeDialogAsync(niceSession, cancellationToken);
        }
        AppLogger.Info("Connection", "나이스 준비 완료");

        _reportProgress("K-에듀파인을 미리 여는 중");
        var edufineTarget = await EnsureApplicationTargetAsync(
            _educationOffice.EdufineDomain,
            "에듀파인",
            "K-에듀파인",
            _educationOffice.EdufineUri,
            cancellationToken);
        await using (var edufineSession = await DevToolsSession.ConnectAsync(
            _devToolsPort,
            edufineTarget.Id,
            cancellationToken))
        {
            await WaitForEdufineReadyAsync(edufineSession, cancellationToken);
        }
        AppLogger.Info("Connection", "K-에듀파인 준비 완료");

        _reportProgress("나이스와 K-에듀파인 준비 완료");
        AppLogger.Info("Connection", "업무 시스템 준비 완료");
    }

    public async Task ExtendExpiringSessionsAsync(CancellationToken cancellationToken = default)
    {
        AppLogger.Info("SessionRefresh", "나이스·K-에듀파인 세션 남은 시간 확인 시작");
        var targets = await DevToolsDiscovery.GetTargetsAsync(_devToolsPort, cancellationToken);
        await ExtendApplicationSessionAsync(targets, "나이스", _educationOffice.NiceDomain, cancellationToken);
        await ExtendApplicationSessionAsync(targets, "K-에듀파인", _educationOffice.EdufineDomain, cancellationToken);
    }

    private async Task ExtendApplicationSessionAsync(
        IReadOnlyCollection<DevToolsTarget> targets,
        string systemName,
        string domain,
        CancellationToken cancellationToken)
    {
        var isNice = string.Equals(domain, _educationOffice.NiceDomain, StringComparison.OrdinalIgnoreCase);
        var target = FindPageTarget(targets, domain);
        if (target is null)
        {
            AppLogger.Info("SessionRefresh", $"{systemName}: 열린 화면이 없어 확인을 건너뜁니다.");
            return;
        }

        try
        {
            await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
            var snapshot = await ReadSessionSnapshotAsync(session, cancellationToken);
            if (snapshot.RemainingSeconds is null)
            {
                AppLogger.Info(
                    "SessionRefresh",
                    $"{systemName}: 남은 시간 표시를 확인하지 못해 안전하게 건너뜁니다. "
                    + $"(시간 후보 {snapshot.TimerCandidateCount}, 연장 후보 {snapshot.ExtensionControlCount})");
                return;
            }

            if (snapshot.RemainingSeconds > SessionExtensionThresholdSeconds)
            {
                AppLogger.Info("SessionRefresh", $"{systemName}: 남은 시간이 20분을 초과해 연장하지 않습니다.");
                return;
            }

            if (!snapshot.ExtensionControlFound)
            {
                AppLogger.Info(
                    "SessionRefresh",
                    $"{systemName}: 남은 시간이 20분 이하이지만 공식 연장 버튼을 찾지 못해 페이지를 새로고침하지 않습니다.");
                return;
            }

            if (LastSessionExtensionAttemptUtc.TryGetValue(domain, out var lastAttempt)
                && DateTime.UtcNow - lastAttempt < SessionExtensionRetryDelay)
            {
                AppLogger.Info("SessionRefresh", $"{systemName}: 최근 연장 시도 후 5분이 지나지 않아 다시 누르지 않습니다.");
                return;
            }

            LastSessionExtensionAttemptUtc[domain] = DateTime.UtcNow;
            var niceCategoryClickDispatched = false;
            if (isNice)
            {
                niceCategoryClickDispatched = await session.EvaluateBooleanAsync(
                    NiceSessionExtensionClickScript(),
                    userGesture: true,
                    cancellationToken);
                if (!niceCategoryClickDispatched)
                {
                    AppLogger.Info(
                        "SessionRefresh",
                        "나이스: 선택된 카테고리 버튼이 바뀌어 세션 연장 클릭을 안전하게 건너뜁니다.");
                    return;
                }
            }
            else
            {
                await session.ClickAsync(
                    snapshot.ExtensionControlX!.Value,
                    snapshot.ExtensionControlY!.Value,
                    cancellationToken);
            }

            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(8);
            while (DateTime.UtcNow < deadline)
            {
                await Task.Delay(750, cancellationToken);
                var confirmed = await ReadSessionSnapshotAsync(session, cancellationToken);
                if (confirmed.RemainingSeconds is int remaining
                    && remaining > SessionExtensionThresholdSeconds)
                {
                    AppLogger.Info("SessionRefresh", $"{systemName}: 세션을 연장했습니다.");
                    return;
                }
            }

            if (isNice && niceCategoryClickDispatched)
            {
                AppLogger.Info(
                    "SessionRefresh",
                    "나이스: 선택된 카테고리를 다시 눌러 세션 연장을 요청했습니다. "
                    + "백그라운드 탭의 시간 표시는 탭을 다시 열 때 갱신됩니다.");
                return;
            }

            AppLogger.Info(
                "SessionRefresh",
                $"{systemName}: 연장 버튼은 실행했지만 남은 시간 초기화는 화면에서 확인하지 못했습니다.");
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            AppLogger.Error("SessionRefresh", $"{systemName}: 세션 확인 실패", exception);
        }
    }

    private static async Task<SessionSnapshot> ReadSessionSnapshotAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        var json = await session.EvaluateStringAsync(SessionInspectionScript(), cancellationToken);
        if (string.IsNullOrWhiteSpace(json))
        {
            return new SessionSnapshot(null, false, null, null, 0, 0);
        }

        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        double? controlX = null;
        double? controlY = null;
        if (root.TryGetProperty("extensionControlRect", out var rect)
            && rect.ValueKind == JsonValueKind.Object)
        {
            controlX = rect.GetProperty("x").GetDouble() + rect.GetProperty("width").GetDouble() / 2;
            controlY = rect.GetProperty("y").GetDouble() + rect.GetProperty("height").GetDouble() / 2;
        }

        return new SessionSnapshot(
            root.TryGetProperty("remainingSeconds", out var remaining) && remaining.ValueKind == JsonValueKind.Number
                ? remaining.GetInt32()
                : null,
            root.TryGetProperty("extensionControlFound", out var found) && found.GetBoolean(),
            controlX,
            controlY,
            root.TryGetProperty("timerCandidateCount", out var timerCount) ? timerCount.GetInt32() : 0,
            root.TryGetProperty("extensionControlCount", out var controlCount) ? controlCount.GetInt32() : 0);
    }

    private static string SessionInspectionScript()
    {
        return """
            (()=>{
              const visible=e=>{
                if(!e)return false;
                const r=e.getBoundingClientRect(),s=getComputedStyle(e);
                return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&s.display!=='none'&&s.visibility!=='hidden'
                  &&!e.disabled&&e.getAttribute?.('aria-disabled')!=='true';
              };
              const text=e=>((e.innerText||e.textContent||e.value||'')+'').trim();
              const searchableText=e=>[text(e),e.getAttribute?.('aria-label')||'',e.title||'']
                .filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
              const timeKeyword=/(남은\s*시간|잔여\s*시간|세션\s*(?:만료|종료|남은)|자동\s*로그아웃|로그아웃\s*(?:예정|잔여시간))/;
              const extensionText=/^(연장|연장하기|시간\s*연장|세션\s*연장|로그인\s*연장|접속\s*연장)$/;
              const parseSeconds=value=>{
                const korean=value.match(/(\d{1,3})\s*분(?:\s*(\d{1,2})\s*초)?/);
                if(korean&&Number(korean[2]||0)<60)return Number(korean[1])*60+Number(korean[2]||0);
                const three=value.match(/(?:^|\D)(\d{1,2}):(\d{2}):(\d{2})(?:\D|$)/);
                if(three&&Number(three[2])<60&&Number(three[3])<60)
                  return Number(three[1])*3600+Number(three[2])*60+Number(three[3]);
                const two=value.match(/(?:^|\D)(\d{1,3}):(\d{2})(?:\D|$)/);
                return two&&Number(two[2])<60?Number(two[1])*60+Number(two[2]):null;
              };
              const rawTimers=[];

              // K-에듀파인(cpr)과 나이스의 실제 세션 컨트롤을 우선 사용한다.
              // 두 시스템 모두 화면 문자열보다 생성된 컨트롤 ID가 안정적이다.
              const officialTimers=[
                ...document.querySelectorAll("[id$='staUseTime'],[id$='optTime'],[aria-label='세션 종료 시간']")
              ];
              for(const e of new Set(officialTimers)){
                if(!visible(e))continue;
                const value=searchableText(e);
                const seconds=parseSeconds(value);
                if(seconds!==null)rawTimers.push({e,seconds,official:true});
              }

              if(rawTimers.length===0){
                for(const e of document.querySelectorAll('output,span,div,p,label')){
                  if(!visible(e))continue;
                  const value=searchableText(e);
                  if(value.length>0&&value.length<=180&&timeKeyword.test(value)){
                    const seconds=parseSeconds(value);
                    if(seconds!==null)rawTimers.push({e,seconds,official:false});
                  }
                }
              }

              const timerCandidates=rawTimers.some(candidate=>candidate.official)
                ? rawTimers.filter(candidate=>candidate.official)
                : rawTimers.filter(candidate=>
                    !rawTimers.some(other=>other!==candidate&&candidate.e.contains(other.e)));
              let extensionControl=null;
              let extensionControlCount=0;
              if(timerCandidates.length===1){
                const officialNiceControl=[...document.querySelectorAll('.btn-asd.selected')]
                  .filter(e=>{
                    if(!visible(e))return false;
                    const r=e.getBoundingClientRect();
                    const atScreenEdge=r.x<90||r.right>innerWidth-90;
                    return atScreenEdge&&r.width<=60&&r.height<=60;
                  });
                const officialEdufineControl=[...document.querySelectorAll("[id$='btnUseTimeExtn']")]
                  .filter(visible);
                if(officialNiceControl.length===1){
                  extensionControl=officialNiceControl[0];
                  extensionControlCount=1;
                }else if(officialEdufineControl.length===1){
                  extensionControl=officialEdufineControl[0];
                  extensionControlCount=1;
                }else{
                  // 나이스는 10분 남았을 때 공식 확인창에 '연장' 버튼을 표시한다.
                  // 확인창은 상단 타이머의 조상이 아니므로 문서 전체의 표시된 버튼에서 찾는다.
                  const controls=[...new Set([...document.querySelectorAll(
                    'button,a,input[type="button"],input[type="submit"],[role="button"],.cl-button')]
                    .filter(e=>visible(e)&&extensionText.test(text(e).replace(/\s+/g,' '))))];
                  extensionControlCount=controls.length;
                  if(controls.length===1)extensionControl=controls[0];
                }
              }
              const rect=extensionControl?.getBoundingClientRect();
              return JSON.stringify({
                remainingSeconds:timerCandidates.length===1?timerCandidates[0].seconds:null,
                extensionControlFound:!!extensionControl,
                extensionControlRect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,
                timerCandidateCount:timerCandidates.length,
                extensionControlCount
              });
            })()
            """;
    }

    private static string NiceSessionExtensionClickScript()
    {
        return """
            (()=>{
              const visible=e=>{
                if(!e)return false;
                const r=e.getBoundingClientRect(),s=getComputedStyle(e);
                return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'
                  &&!e.disabled&&e.getAttribute?.('aria-disabled')!=='true';
              };
              const controls=[...document.querySelectorAll('.btn-asd.selected')]
                .filter(e=>{
                  if(!visible(e))return false;
                  const r=e.getBoundingClientRect();
                  const atScreenEdge=r.x<90||r.right>innerWidth-90;
                  return atScreenEdge&&r.width<=60&&r.height<=60;
                });
              if(controls.length!==1)return false;
              controls[0].click();
              return true;
            })()
            """;
    }

    private sealed record SessionSnapshot(
        int? RemainingSeconds,
        bool ExtensionControlFound,
        double? ExtensionControlX,
        double? ExtensionControlY,
        int TimerCandidateCount,
        int ExtensionControlCount);

    private async Task<WorkflowResult> OpenSystemHomeAsync(
        string displayName,
        string domain,
        string portalButtonName,
        Func<DevToolsSession, CancellationToken, Task> waitUntilReady,
        CancellationToken cancellationToken)
    {
        _reportProgress($"{displayName}: 화면 준비 중");
        var portalSearchText = string.Equals(
            domain,
            _educationOffice.EdufineDomain,
            StringComparison.OrdinalIgnoreCase)
            ? "에듀파인"
            : "나이스";
        var directUri = string.Equals(
            domain,
            _educationOffice.EdufineDomain,
            StringComparison.OrdinalIgnoreCase)
            ? _educationOffice.EdufineUri
            : _educationOffice.NiceUri;
        var target = await EnsureApplicationTargetAsync(
            domain,
            portalSearchText,
            portalButtonName,
            directUri,
            cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await waitUntilReady(session, cancellationToken);
        if (string.Equals(domain, _educationOffice.NiceDomain, StringComparison.OrdinalIgnoreCase))
        {
            await TryCloseVisibleNiceNoticeDialogAsync(session, cancellationToken);
        }
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
            _educationOffice.NiceDomain,
            "나이스",
            "나이스",
            _educationOffice.NiceUri,
            cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await WaitForNiceReadyAsync(session, cancellationToken);
        await session.ActivateTargetAsync(cancellationToken);
        await PrepareActivatedTargetForBackgroundAsync(cancellationToken);
        await TryCloseVisibleNiceNoticeDialogAsync(session, cancellationToken);

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
            _educationOffice.EdufineDomain,
            "에듀파인",
            "K-에듀파인",
            _educationOffice.EdufineUri,
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

        if (!EdgeIntegrationPolicy.IsWxsClientRegistered())
        {
            throw new InvalidOperationException(
                "WXSClient가 설치되어 있지 않습니다. K-에듀파인 설치가이드에서 프로그램 설치를 완료해 주세요.");
        }

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
            _educationOffice.EdufineDomain,
            "에듀파인",
            "K-에듀파인",
            _educationOffice.EdufineUri,
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
        string portalSearchText,
        string displayName,
        Uri directUri,
        CancellationToken cancellationToken)
    {
        var targets = await DevToolsDiscovery.GetTargetsAsync(_devToolsPort, cancellationToken);
        var existing = FindPageTarget(targets, domain);
        if (existing is not null)
        {
            return existing;
        }

        var portalTargets = targets
            .Where(target => target.Type is "page" or "iframe"
                && target.Url.Contains(_educationOffice.PortalDomain, StringComparison.OrdinalIgnoreCase))
            .OrderBy(target => target.Type == "page" ? 0 : 1)
            .ToList();
        var clicked = false;
        foreach (var portal in portalTargets)
        {
            try
            {
                await using var portalSession = await DevToolsSession.ConnectAsync(
                    _devToolsPort,
                    portal.Id,
                    cancellationToken);
                clicked = await portalSession.EvaluateBooleanAsync(
                    ClickPortalApplicationScript(portalSearchText),
                    userGesture: true,
                    cancellationToken);
                if (clicked)
                {
                    AppLogger.Info("Connection", $"업무포털에서 {displayName} 항목을 찾아 실행했습니다.");
                    break;
                }
            }
            catch (Exception exception) when (
                !cancellationToken.IsCancellationRequested
                && exception is InvalidOperationException or TimeoutException)
            {
                AppLogger.Info("Connection", $"업무포털의 {displayName} 항목 탐색을 계속합니다: {exception.Message}");
            }
        }

        if (clicked)
        {
            existing = await WaitForApplicationTargetAsync(
                domain,
                TimeSpan.FromSeconds(15),
                cancellationToken);
            if (existing is not null)
            {
                return existing;
            }

            AppLogger.Info("Connection", $"업무포털에서 {displayName}을 실행했지만 새 탭을 확인하지 못했습니다.");
        }
        else
        {
            AppLogger.Info("Connection", $"업무포털에서 {displayName} 항목을 찾지 못했습니다.");
        }

        _reportProgress($"{displayName}: 공식 주소로 여는 중");
        await DevToolsSession.CreateTargetAsync(_devToolsPort, directUri, cancellationToken);
        existing = await WaitForApplicationTargetAsync(
            domain,
            TimeSpan.FromSeconds(45),
            cancellationToken);
        if (existing is not null)
        {
            AppLogger.Info("Connection", $"{displayName}을 공식 주소로 열었습니다.");
            return existing;
        }

        throw new TimeoutException($"{displayName} 화면이 열리지 않았습니다. 로그인 또는 보안 프로그램 상태를 확인해 주세요.");
    }

    private async Task TryCloseVisiblePortalNoticeAsync(CancellationToken cancellationToken)
    {
        try
        {
            await CloseVisiblePortalNoticeAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            AppLogger.Info(
                "Workflow",
                $"업무포털 공지창 자동 닫기를 건너뛰고 다음 단계로 진행합니다: {exception.Message}");
        }
    }

    private async Task CloseVisiblePortalNoticeAsync(CancellationToken cancellationToken)
    {
        var targets = await DevToolsDiscovery.GetTargetsAsync(_devToolsPort, cancellationToken);
        var portalTargets = targets
            .Where(target => target.Type == "page"
                && target.Url.Contains(_educationOffice.PortalDomain, StringComparison.OrdinalIgnoreCase))
            .ToList();
        foreach (var target in portalTargets)
        {
            await using var session = await DevToolsSession.ConnectAsync(
                _devToolsPort,
                target.Id,
                cancellationToken);
            const string noticeVisibleExpression = """
                (()=>{
                  const normalize=value=>(value||'').replace(/\s+/g,' ').trim();
                  const visible=element=>{
                    if(!element)return false;
                    const rect=element.getBoundingClientRect();
                    const view=element.ownerDocument?.defaultView;
                    const style=view?.getComputedStyle(element);
                    return rect.width>0&&rect.height>0&&rect.x>=0&&rect.y>=0
                      &&style?.display!=='none'&&style?.visibility!=='hidden';
                  };
                  const documents=[];
                  const visit=currentDocument=>{
                    if(!currentDocument||documents.includes(currentDocument))return;
                    documents.push(currentDocument);
                    for(const frame of currentDocument.querySelectorAll('iframe,frame')){
                      try{visit(frame.contentDocument);}catch{}
                    }
                  };
                  visit(document);
                  return documents.some(currentDocument=>{
                    const elements=[...currentDocument.querySelectorAll('label,span,div,p')];
                    const day=elements.some(element=>visible(element)&&normalize(element.textContent).includes('오늘하루 이창 열지 않기'));
                    const week=elements.some(element=>visible(element)&&normalize(element.textContent).includes('1주일동안 열지 않기'));
                    return day&&week;
                  });
                })()
                """;
            if (!await session.EvaluateBooleanAsync(
                    noticeVisibleExpression,
                    cancellationToken: cancellationToken))
            {
                continue;
            }

            AppLogger.Info("Workflow", "업무포털 공지창을 확인했습니다.");
            const string selectWeekExpression = """
                (()=>{
                  const normalize=value=>(value||'').replace(/\s+/g,' ').trim();
                  const visible=element=>{
                    if(!element)return false;
                    const rect=element.getBoundingClientRect();
                    const view=element.ownerDocument?.defaultView;
                    const style=view?.getComputedStyle(element);
                    return rect.width>0&&rect.height>0&&rect.x>=0&&rect.y>=0
                      &&style?.display!=='none'&&style?.visibility!=='hidden';
                  };
                  const visit=currentDocument=>{
                    const elements=[...currentDocument.querySelectorAll('label,span,div,p')];
                    const week=elements
                      .filter(element=>visible(element)&&normalize(element.textContent).includes('1주일동안 열지 않기'))
                      .sort((left,right)=>left.children.length-right.children.length)[0];
                    if(week){
                      const label=week.closest('label');
                      const container=label||week.parentElement;
                      const checkbox=label?.querySelector('input[type="checkbox"]')
                        ||container?.querySelector('input[type="checkbox"],[role="checkbox"],.cl-checkbox');
                      if(checkbox){
                        const checked=checkbox.checked===true||checkbox.getAttribute?.('aria-checked')==='true'
                          ||checkbox.classList?.contains('cl-checked');
                        if(!checked)checkbox.click();
                      }else{
                        (week.closest('label,[role="checkbox"],.cl-checkbox')||week).click();
                      }
                      return true;
                    }
                    for(const frame of currentDocument.querySelectorAll('iframe,frame')){
                      try{if(frame.contentDocument&&visit(frame.contentDocument))return true;}catch{}
                    }
                    return false;
                  };
                  return visit(document);
                })()
                """;
            var weekSelected = await session.EvaluateBooleanAsync(
                selectWeekExpression,
                userGesture: true,
                cancellationToken);
            if (!weekSelected)
            {
                AppLogger.Info("Workflow", "업무포털 공지창의 1주일 숨김 선택 항목을 찾지 못했습니다.");
            }

            await Task.Delay(150, cancellationToken);
            const string closeNoticeExpression = """
                (()=>{
                  const normalize=value=>(value||'').replace(/\s+/g,' ').trim();
                  const visible=element=>{
                    if(!element)return false;
                    const rect=element.getBoundingClientRect();
                    const view=element.ownerDocument?.defaultView;
                    const style=view?.getComputedStyle(element);
                    return rect.width>0&&rect.height>0&&rect.x>=0&&rect.y>=0
                      &&style?.display!=='none'&&style?.visibility!=='hidden';
                  };
                  const visit=currentDocument=>{
                    const elements=[...currentDocument.querySelectorAll('label,span,div,p')];
                    const week=elements
                      .filter(element=>visible(element)&&normalize(element.textContent).includes('1주일동안 열지 않기'))
                      .sort((left,right)=>left.children.length-right.children.length)[0];
                    if(week){
                      let scope=week.closest('[role="dialog"],.modal,[class*="popup"],[class*="layer"]');
                      if(!scope){
                        for(let current=week.parentElement;current;current=current.parentElement){
                          const text=normalize(current.innerText||current.textContent);
                          if(text.includes('오늘하루 이창 열지 않기')&&text.includes('1주일동안 열지 않기')
                            &&text.includes('닫기')){scope=current;break;}
                        }
                      }
                      scope=scope||currentDocument.body;
                      const close=[...scope.querySelectorAll('button,a,[role="button"],span,div')]
                        .filter(element=>visible(element)&&normalize(element.innerText||element.textContent)==='닫기')
                        .sort((left,right)=>left.children.length-right.children.length)[0];
                      if(!close)return false;
                      (close.closest('button,a,[role="button"]')||close).click();
                      return true;
                    }
                    for(const frame of currentDocument.querySelectorAll('iframe,frame')){
                      try{if(frame.contentDocument&&visit(frame.contentDocument))return true;}catch{}
                    }
                    return false;
                  };
                  return visit(document);
                })()
                """;
            if (!await session.EvaluateBooleanAsync(
                    closeNoticeExpression,
                    userGesture: true,
                    cancellationToken))
            {
                AppLogger.Info(
                    "Workflow",
                    "업무포털 공지창의 닫기 버튼을 찾지 못해 자동 닫기를 건너뜁니다.");
                continue;
            }

            await Task.Delay(300, cancellationToken);
            var noticeStillVisible = await session.EvaluateBooleanAsync(
                noticeVisibleExpression,
                cancellationToken: cancellationToken);
            if (noticeStillVisible)
            {
                AppLogger.Info(
                    "Workflow",
                    "업무포털 공지창이 바로 닫히지 않아 기다리지 않고 다음 단계로 진행합니다.");
            }
            else
            {
                AppLogger.Info("Workflow", weekSelected
                    ? "업무포털 공지창을 1주일 동안 표시하지 않도록 닫았습니다."
                    : "업무포털 공지창을 닫았습니다.");
            }
        }
    }

    private async Task<DevToolsTarget?> WaitForApplicationTargetAsync(
        string domain,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(300, cancellationToken);
            var targets = await DevToolsDiscovery.GetTargetsAsync(_devToolsPort, cancellationToken);
            var target = FindPageTarget(targets, domain);
            if (target is not null)
            {
                return target;
            }
        }

        return null;
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
        const string expression = "(()=>{if(document.readyState!=='complete')return false;"
            + "const docs=[];const add=d=>{if(!d||docs.includes(d))return;docs.push(d);"
            + "for(const f of d.querySelectorAll('iframe,frame')){try{add(f.contentDocument)}catch{}}};add(document);"
            + "return docs.some(d=>[...d.querySelectorAll('.cl-text')].some(e=>{const t=(e.textContent||'').trim();"
            + "return t==='복무'||t.startsWith('복무 ');})||(d.body?.innerText||'').includes('나이스'));})()";
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
        const string expression = "(()=>{if(document.readyState!=='complete')return false;"
            + "const docs=[];const add=d=>{if(!d||docs.includes(d))return;docs.push(d);"
            + "for(const f of d.querySelectorAll('iframe,frame')){try{add(f.contentDocument)}catch{}}};add(document);"
            + "return docs.some(d=>!!d.querySelector(\"[id$='cboJobList.comboedit:input']\")"
            + "||/(업무관리|학교회계)/.test(d.body?.innerText||''));})()";
        return WaitForConditionAsync(
            session,
            expression,
            TimeSpan.FromSeconds(45),
            cancellationToken,
            "K-에듀파인 업무 화면을 준비하는 시간이 초과되었습니다.");
    }

    private static async Task TryCloseVisibleNiceNoticeDialogAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        try
        {
            await CloseVisibleNiceNoticeDialogAsync(session, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            AppLogger.Info(
                "Workflow",
                $"나이스 공지사항 자동 닫기를 건너뛰고 다음 단계로 진행합니다: {exception.Message}");
        }
    }

    private static async Task CloseVisibleNiceNoticeDialogAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        const string noticeVisibleExpression = """
            (()=>{
              const normalize=value=>(value||'').replace(/\s+/g,' ').trim();
              const visible=element=>{
                if(!element)return false;
                const rect=element.getBoundingClientRect();
                const view=element.ownerDocument?.defaultView;
                const style=view?.getComputedStyle(element);
                return rect.width>0&&rect.height>0&&rect.x>=0&&rect.y>=0
                  &&style?.display!=='none'&&style?.visibility!=='hidden';
              };
              const documents=[];
              const visit=currentDocument=>{
                if(!currentDocument||documents.includes(currentDocument))return;
                documents.push(currentDocument);
                for(const frame of currentDocument.querySelectorAll('iframe,frame')){
                  try{visit(frame.contentDocument);}catch{}
                }
              };
              visit(document);
              return documents.some(currentDocument=>{
                const dialogs=[...currentDocument.querySelectorAll('.cl-dialog,[role="dialog"],.modal,[class*="popup"]')];
                if(dialogs.some(dialog=>{
                  const text=normalize(dialog.innerText||dialog.textContent);
                  return visible(dialog)&&text.includes('공지사항')&&text.includes('전달사항내용조회');
                }))return true;
                const elements=[...currentDocument.querySelectorAll('.cl-text,h1,h2,h3,span,div')];
                const noticeTitle=elements.some(element=>visible(element)&&normalize(element.textContent)==='공지사항');
                const detailTitle=elements.some(element=>visible(element)&&normalize(element.textContent)==='전달사항내용조회');
                return noticeTitle&&detailTitle;
              });
            })()
            """;

        if (!await session.EvaluateBooleanAsync(
                noticeVisibleExpression,
                cancellationToken: cancellationToken))
        {
            return;
        }

        AppLogger.Info("Workflow", "나이스 공지사항 안내창을 확인했습니다.");
        const string closeElementExpression = """
            (()=>{
              const normalize=value=>(value||'').replace(/\s+/g,' ').trim();
              const visible=element=>{
                if(!element)return false;
                const rect=element.getBoundingClientRect();
                const view=element.ownerDocument?.defaultView;
                const style=view?.getComputedStyle(element);
                return rect.width>0&&rect.height>0&&rect.x>=0&&rect.y>=0
                  &&style?.display!=='none'&&style?.visibility!=='hidden'
                  &&!element.disabled&&element.getAttribute?.('aria-disabled')!=='true';
              };
              const documents=[];
              const visit=currentDocument=>{
                if(!currentDocument||documents.includes(currentDocument))return;
                documents.push(currentDocument);
                for(const frame of currentDocument.querySelectorAll('iframe,frame')){
                  try{visit(frame.contentDocument);}catch{}
                }
              };
              visit(document);
              for(const currentDocument of documents){
                const dialogs=[...currentDocument.querySelectorAll('.cl-dialog,[role="dialog"],.modal,[class*="popup"]')];
                let scope=dialogs.find(dialog=>{
                  const text=normalize(dialog.innerText||dialog.textContent);
                  return visible(dialog)&&text.includes('공지사항')&&text.includes('전달사항내용조회');
                });
                if(!scope){
                  const elements=[...currentDocument.querySelectorAll('.cl-text,h1,h2,h3,span,div')];
                  const noticeTitle=elements.find(element=>visible(element)&&normalize(element.textContent)==='공지사항');
                  const detailTitle=elements.find(element=>visible(element)&&normalize(element.textContent)==='전달사항내용조회');
                  if(!noticeTitle||!detailTitle)continue;
                  scope=noticeTitle.closest('.cl-dialog,[role="dialog"],.modal,[class*="popup"]')||currentDocument.body;
                }
                const actions=[...scope.querySelectorAll('.cl-button,button,a,[role="button"],input[type="button"],input[type="submit"],.cl-dialog-close')]
                  .filter(visible);
                return actions.find(action=>normalize(action.innerText||action.textContent||action.value)==='닫기')
                  ||actions.find(action=>action.classList?.contains('cl-dialog-close'))
                  ||actions.find(action=>/^(닫기|close)$/i.test(normalize(action.getAttribute?.('aria-label')||action.title)))
                  ||null;
              }
              return null;
            })()
            """;

        var syntheticClickExpression = "(()=>{const element=(" + closeElementExpression
            + ");if(!element)return false;element.click();return true;})()";
        if (await session.EvaluateBooleanAsync(
                syntheticClickExpression,
                userGesture: true,
                cancellationToken))
        {
            try
            {
                await WaitForConditionAsync(
                    session,
                    $"!({noticeVisibleExpression})",
                    TimeSpan.FromSeconds(2),
                    cancellationToken,
                    "나이스 공지사항 안내창의 DOM 닫기를 재시도합니다.");
                AppLogger.Info("Workflow", "나이스 공지사항 안내창을 닫았습니다.");
                return;
            }
            catch (TimeoutException)
            {
                AppLogger.Info("Workflow", "나이스 공지사항 안내창을 실제 마우스 입력으로 다시 닫습니다.");
            }
        }

        await ClickElementCenterAsync(
            session,
            closeElementExpression,
            "나이스 공지사항 안내창의 닫기 버튼을 찾지 못했습니다.",
            TimeSpan.FromSeconds(5),
            cancellationToken);
        await WaitForConditionAsync(
            session,
            $"!({noticeVisibleExpression})",
            TimeSpan.FromSeconds(10),
            cancellationToken,
            "나이스 공지사항 안내창이 닫히는 시간이 초과되었습니다.");
        AppLogger.Info("Workflow", "나이스 공지사항 안내창을 닫았습니다.");
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
            catch (TimeoutException exception) when (
                attempt < 3 && exception is not DevToolsCommandTimeoutException)
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
            + "const r=e.getBoundingClientRect();let x=r.x,y=r.y;let view=e.ownerDocument?.defaultView;"
            + "while(view&&view!==window){const frame=view.frameElement;if(!frame)break;const fr=frame.getBoundingClientRect();"
            + "x+=fr.x;y+=fr.y;view=frame.ownerDocument?.defaultView;}return {x,y,w:r.width,h:r.height};})()";
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

    private static string ClickPortalApplicationScript(string keyword)
    {
        var value = JsonSerializer.Serialize(keyword);
        return $$"""
            (()=>{
              const keyword={{value}};
              const normalize=value=>(value||'').replace(/\s+/g,' ').trim();
              const visible=element=>{
                if(!element)return false;
                const rect=element.getBoundingClientRect();
                const view=element.ownerDocument?.defaultView;
                const style=view?.getComputedStyle(element);
                return rect.width>0&&rect.height>0&&rect.x>=0&&rect.y>=0
                  &&style?.display!=='none'&&style?.visibility!=='hidden'
                  &&!element.disabled&&element.getAttribute?.('aria-disabled')!=='true';
              };
              const elementText=element=>normalize(
                element.innerText||element.textContent||element.value
                ||element.getAttribute?.('aria-label')||element.title||element.alt||'');
              const actionableSelector='a,button,[role="button"],[onclick],input[type="button"],input[type="submit"],.menuBtn';
              const searchableSelector=actionableSelector+',[aria-label],[title],img[alt]';
              const documents=[];
              const visit=documentToVisit=>{
                if(!documentToVisit||documents.includes(documentToVisit))return;
                documents.push(documentToVisit);
                for(const frame of documentToVisit.querySelectorAll('iframe,frame')){
                  try{visit(frame.contentDocument);}catch{}
                }
              };
              visit(document);
              const candidates=[];
              for(const currentDocument of documents){
                for(const element of currentDocument.querySelectorAll(searchableSelector)){
                  if(!visible(element))continue;
                  const text=elementText(element);
                  if(!text||text.length>80||!text.includes(keyword))continue;
                  const action=element.matches(actionableSelector)?element:element.closest(actionableSelector);
                  if(!visible(action))continue;
                  const actionText=elementText(action);
                  const compact=actionText.replace(/[\s‐‑‒–—―-]/g,'');
                  const exact=compact===keyword||compact===`K${keyword}`;
                  const score=(exact?100:0)+(element===action?20:0)-actionText.length;
                  const previous=candidates.find(candidate=>candidate.action===action);
                  if(!previous)candidates.push({action,score});
                  else if(score>previous.score)previous.score=score;
                }
              }
              candidates.sort((left,right)=>right.score-left.score);
              const best=candidates[0]?.action;
              if(!best)return false;
              best.scrollIntoView?.({block:'center',inline:'center'});
              best.click();
              return true;
            })()
            """;
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
