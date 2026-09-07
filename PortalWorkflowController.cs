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

internal sealed class PortalSessionExpiredException : InvalidOperationException
{
    public PortalSessionExpiredException(string systemName, string message)
        : base(message)
    {
        SystemName = systemName;
    }

    public string SystemName { get; }
}

internal sealed class PortalWorkflowController
{
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
            await TryCloseVisibleEdufineNoticeAsync(edufineSession, cancellationToken);
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
            if (isNice)
            {
                if (await TryCloseVisibleNiceSecurityShutdownDialogAsync(session, cancellationToken))
                {
                    AppLogger.Info(
                        "SessionRefresh",
                        "나이스 세션 종료 안내창을 닫고 세션 확인을 중단합니다.");
                    throw new PortalSessionExpiredException(
                        "나이스",
                        "나이스 서버 세션이 종료되었습니다. Edge에서 나이스에 다시 로그인한 뒤 연결해 주세요.");
                }

                var niceExtensionResult = await session.EvaluateStringAsync(
                    NiceServerSessionExtensionScript(),
                    cancellationToken);
                if (string.Equals(niceExtensionResult, "Y", StringComparison.Ordinal))
                {
                    AppLogger.Info(
                        "SessionRefresh",
                        "나이스: 서버 세션 연장 응답 Y를 확인하고 화면 타이머를 초기화했습니다.");
                    return;
                }

                if (string.Equals(niceExtensionResult, "Y_RECENT", StringComparison.Ordinal))
                {
                    AppLogger.Info("SessionRefresh", "나이스: 최근 10분 안에 서버 세션 연장 응답 Y를 확인했습니다.");
                    return;
                }

                if (string.Equals(niceExtensionResult, "N", StringComparison.Ordinal))
                {
                    AppLogger.Info("SessionRefresh", "나이스: 서버가 세션 DB 없음(N)을 반환했습니다.");
                    throw new PortalSessionExpiredException(
                        "나이스",
                        "나이스 서버 세션 DB가 유효하지 않습니다. Edge에서 나이스에 다시 로그인한 뒤 연결해 주세요.");
                }

                if (string.Equals(niceExtensionResult, "STARTED", StringComparison.Ordinal)
                    || string.Equals(niceExtensionResult, "IN_FLIGHT", StringComparison.Ordinal))
                {
                    AppLogger.Info(
                        "SessionRefresh",
                        $"나이스: 서버 세션 연장 요청을 처리 중입니다. 상태={niceExtensionResult}");
                    return;
                }

                if (string.Equals(niceExtensionResult, "IN_FLIGHT_STALE", StringComparison.Ordinal))
                {
                    AppLogger.Info(
                        "SessionRefresh",
                        "나이스: 공식 서버 세션 요청이 10분 넘게 끝나지 않았습니다. 중복 요청은 보내지 않습니다.");
                    return;
                }

                AppLogger.Info(
                    "SessionRefresh",
                    $"나이스: 서버 세션 연장에 실패해 1분 뒤 다시 시도합니다. 상태={niceExtensionResult ?? "null"}");
                return;
            }

            var edufineState = await ReadEdufineSessionStateAsync(session, cancellationToken);
            if (edufineState.Expired || edufineState.RemainingSeconds == 0)
            {
                AppLogger.Info("SessionRefresh", "K-에듀파인: 실제 사용시간이 0:00이거나 종료 안내가 표시되었습니다.");
                throw new PortalSessionExpiredException(
                    "K-에듀파인",
                    "K-에듀파인 사용시간이 종료되었습니다. Edge에서 K-에듀파인에 다시 로그인한 뒤 연결해 주세요.");
            }

            var edufineExtensionResult = await session.EvaluateStringAsync(
                EdufineServerSessionCheckScript(),
                cancellationToken);
            if (string.Equals(edufineExtensionResult, "Y", StringComparison.Ordinal))
            {
                AppLogger.Info(
                    "SessionRefresh",
                    "K-에듀파인: 공식 sessionCheck 콜백에서 서버 생존 응답 Y를 확인했습니다.");
                return;
            }

            if (string.Equals(edufineExtensionResult, "Y_RECENT", StringComparison.Ordinal))
            {
                AppLogger.Info("SessionRefresh", "K-에듀파인: 최근 5분 안에 서버 생존 응답 Y를 확인했습니다.");
                return;
            }

            if (string.Equals(edufineExtensionResult, "N", StringComparison.Ordinal))
            {
                AppLogger.Info("SessionRefresh", "K-에듀파인: sessionCheck가 서버 세션 종료를 반환했습니다.");
                throw new PortalSessionExpiredException(
                    "K-에듀파인",
                    "K-에듀파인 서버 세션이 종료되었습니다. Edge에서 K-에듀파인에 다시 로그인한 뒤 연결해 주세요.");
            }

            if (string.Equals(edufineExtensionResult, "STARTED", StringComparison.Ordinal)
                || string.Equals(edufineExtensionResult, "IN_FLIGHT", StringComparison.Ordinal))
            {
                AppLogger.Info(
                    "SessionRefresh",
                    $"K-에듀파인: 공식 sessionCheck 요청을 처리 중입니다. 상태={edufineExtensionResult}");
                return;
            }

            if (string.Equals(edufineExtensionResult, "IN_FLIGHT_STALE", StringComparison.Ordinal))
            {
                AppLogger.Info(
                    "SessionRefresh",
                    "K-에듀파인: 공식 sessionCheck 요청이 5분 넘게 끝나지 않았습니다. 중복 요청은 보내지 않습니다.");
                return;
            }

            AppLogger.Info(
                "SessionRefresh",
                $"K-에듀파인: 서버 세션 확인에 실패해 1분 뒤 다시 확인합니다. 상태={edufineExtensionResult ?? "null"}");
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (PortalSessionExpiredException)
        {
            throw;
        }
        catch (Exception exception)
        {
            AppLogger.Error("SessionRefresh", $"{systemName}: 세션 확인 실패", exception);
        }
    }

    private static string NiceServerSessionExtensionScript()
    {
        return """
            (()=>{
              const stateKey='__oneClickNiceServerKeepAliveV2';
              const successIntervalMs=10*60*1000;
              const retryIntervalMs=60*1000;
              const staleRequestMs=10*60*1000;
              const now=Date.now();
              const jquery=globalThis.jQuery||globalThis.$;
              if(!jquery||typeof jquery.ajax!=='function')return 'NO_JQUERY';

              const getState=()=>globalThis[stateKey]||(globalThis[stateKey]={
                inFlight:false,
                startedAt:0,
                completedAt:0,
                result:null,
                reported:false,
                request:null
              });
              const mainApp=window.voMainApp;
              const canResetTimer=!!mainApp
                &&typeof mainApp.hasAppMethod==='function'
                &&mainApp.hasAppMethod('setSessionTimerInit')
                &&typeof mainApp.callAppMethod==='function';

              if(!jquery.__oneClickOriginalAjaxV2){
                const originalAjax=jquery.ajax;
                jquery.__oneClickOriginalAjaxV2=originalAjax;
                jquery.ajax=function(first,second){
                  const settings=typeof first==='string'
                    ?Object.assign({},second||{},{url:first})
                    :Object.assign({},first||{});
                  const url=String(settings.url||'');
                  if(!url.includes('/sessionExtension.do'))
                    return originalAjax.apply(this,arguments);

                  const shared=getState();
                  if(shared.inFlight)return shared.request;

                  const userSuccess=settings.success;
                  const userError=settings.error;
                  const userComplete=settings.complete;
                  const finish=result=>{
                    shared.inFlight=false;
                    shared.result=result;
                    shared.completedAt=Date.now();
                    shared.reported=false;
                    shared.request=null;
                    if(result==='Y'&&canResetTimer){
                      try{mainApp.callAppMethod('setSessionTimerInit');}catch{}
                    }
                  };

                  shared.inFlight=true;
                  shared.startedAt=Date.now();
                  shared.completedAt=0;
                  shared.result=null;
                  shared.reported=false;

                  settings.success=function(result,...rest){
                    const raw=String(result??'').trim();
                    let normalized=raw;
                    try{
                      const parsed=JSON.parse(raw);
                      if(typeof parsed==='string')normalized=parsed.trim();
                    }catch{}
                    finish(normalized==='Y'||normalized==='N'
                      ?normalized
                      :'UNEXPECTED_RESPONSE');
                    if(typeof userSuccess==='function')
                      userSuccess.apply(this,[result,...rest]);
                  };
                  settings.error=function(...args){
                    finish('NETWORK_ERROR');
                    if(typeof userError==='function')userError.apply(this,args);
                  };
                  settings.complete=function(...args){
                    if(typeof userComplete==='function')userComplete.apply(this,args);
                  };

                  try{
                    const request=originalAjax.call(this,settings);
                    shared.request=request;
                    return request;
                  }catch{
                    finish('REQUEST_EXCEPTION');
                    return null;
                  }
                };
              }

              const state=getState();
              if(state.inFlight)
                return now-state.startedAt>staleRequestMs?'IN_FLIGHT_STALE':'IN_FLIGHT';

              if(state.completedAt&&state.result){
                if(state.result==='Y'&&!state.reported){
                  state.reported=true;
                  return 'Y';
                }
                const waitMs=state.result==='Y'?successIntervalMs:retryIntervalMs;
                if(now-state.completedAt<waitMs)
                  return state.result==='Y'?'Y_RECENT':state.result;
              }

              jquery.ajax({
                async:true,
                dataType:'text',
                type:'post',
                url:'/sessionExtension.do'
              });
              return 'STARTED';
            })()
            """;
    }

    private static async Task<EdufineSessionState> ReadEdufineSessionStateAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        var json = await session.EvaluateStringAsync(EdufineSessionStateScript(), cancellationToken);
        if (string.IsNullOrWhiteSpace(json))
        {
            return new EdufineSessionState(null, false, null);
        }

        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        return new EdufineSessionState(
            root.TryGetProperty("remainingSeconds", out var remaining)
                && remaining.ValueKind == JsonValueKind.Number
                    ? remaining.GetInt32()
                    : null,
            root.TryGetProperty("expired", out var expired)
                && expired.ValueKind == JsonValueKind.True,
            root.TryGetProperty("timerText", out var timerText)
                && timerText.ValueKind == JsonValueKind.String
                    ? timerText.GetString()
                    : null);
    }

    private static string EdufineSessionStateScript()
    {
        return """
            (()=>{
              const app=globalThis.nexacro?.getApplication?.()||globalThis.application;
              const topForm=app?.mainframe?.MainVFrameSet?.TopFrame?.form?.divTopGrp?.form;
              const timerText=String(topForm?.staUseTime?.text??'').trim();
              const parseSeconds=value=>{
                const parts=value.split(':').map(part=>Number(part));
                if(parts.some(part=>!Number.isFinite(part)||part<0))return null;
                if(parts.length===2&&parts[1]<60)return parts[0]*60+parts[1];
                if(parts.length===3&&parts[1]<60&&parts[2]<60)
                  return parts[0]*3600+parts[1]*60+parts[2];
                return null;
              };
              const documents=[];
              const visit=current=>{
                if(!current||documents.includes(current))return;
                documents.push(current);
                for(const frame of current.querySelectorAll?.('iframe,frame')||[]){
                  try{visit(frame.contentDocument)}catch{}
                }
              };
              visit(document);
              const shutdownVisible=documents.some(current=>{
                const text=String(current.body?.innerText||current.body?.textContent||'')
                  .replace(/\s+/g,' ');
                return text.includes('사용시간이 종료되었습니다');
              });
              const remainingSeconds=parseSeconds(timerText);
              return JSON.stringify({
                timerText:timerText||null,
                remainingSeconds,
                expired:shutdownVisible||remainingSeconds===0
              });
            })()
            """;
    }

    private static string EdufineServerSessionCheckScript()
    {
        return """
            (()=>{
              const stateKey='__oneClickEdufineServerKeepAliveV1';
              const successIntervalMs=5*60*1000;
              const retryIntervalMs=60*1000;
              const staleRequestMs=5*60*1000;
              const now=Date.now();
              const app=globalThis.nexacro?.getApplication?.()||globalThis.application;
              const topForm=app?.gv_topFrame?.form
                ||app?.mainframe?.MainVFrameSet?.TopFrame?.form;
              if(!topForm
                ||typeof topForm.fnSessionCheck!=='function'
                ||typeof topForm.fnCallback!=='function')return 'NO_SESSION_METHOD';

              const getState=()=>globalThis[stateKey]||(globalThis[stateKey]={
                inFlight:false,
                startedAt:0,
                completedAt:0,
                result:null,
                reported:false
              });

              if(!topForm.__oneClickSessionWrappedV1){
                const originalSessionCheck=topForm.fnSessionCheck;
                const originalCallback=topForm.fnCallback;
                topForm.__oneClickSessionWrappedV1=true;
                topForm.__oneClickOriginalSessionCheckV1=originalSessionCheck;
                topForm.__oneClickOriginalCallbackV1=originalCallback;

                topForm.fnSessionCheck=function(...args){
                  const shared=getState();
                  if(shared.inFlight)return;
                  shared.inFlight=true;
                  shared.startedAt=Date.now();
                  shared.completedAt=0;
                  shared.result=null;
                  shared.reported=false;
                  try{
                    return originalSessionCheck.apply(this,args);
                  }catch(error){
                    shared.inFlight=false;
                    shared.completedAt=Date.now();
                    shared.result='REQUEST_EXCEPTION';
                    throw error;
                  }
                };

                topForm.fnCallback=function(svcID,errorCode,errorMsg){
                  if(String(svcID)==='sessionCheck'){
                    const shared=getState();
                    shared.inFlight=false;
                    shared.completedAt=Date.now();
                    shared.reported=false;
                    if(Number(errorCode)===0&&String(this.fv_aliveYn)==='Y'){
                      shared.result='Y';
                      try{this.fnResetUseEndCeckTimer?.();}catch{}
                    }else if(Number(errorCode)===0){
                      shared.result='N';
                    }else{
                      shared.result='ERROR_'+String(errorCode??'UNKNOWN');
                    }
                  }
                  return originalCallback.apply(this,arguments);
                };
              }

              const state=getState();
              if(state.inFlight)
                return now-state.startedAt>staleRequestMs?'IN_FLIGHT_STALE':'IN_FLIGHT';

              if(state.completedAt&&state.result){
                if(state.result==='Y'&&!state.reported){
                  state.reported=true;
                  return 'Y';
                }
                const waitMs=state.result==='Y'?successIntervalMs:retryIntervalMs;
                if(now-state.completedAt<waitMs)
                  return state.result==='Y'?'Y_RECENT':state.result;
              }

              try{
                topForm.fnSessionCheck();
                return 'STARTED';
              }catch{
                return getState().result||'REQUEST_EXCEPTION';
              }
            })()
            """;
    }

    private sealed record EdufineSessionState(
        int? RemainingSeconds,
        bool Expired,
        string? TimerText);

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
        var orphanedCurrentDialog = false;
        if (string.Equals(openDialog, dialogTitle, StringComparison.Ordinal))
        {
            var taskTabVisible = await session.EvaluateBooleanAsync(
                NiceTaskTabSelectedExpression(menuName),
                cancellationToken: cancellationToken);
            if (taskTabVisible)
            {
                await PrepareBrowserForUserAsync(session, cancellationToken);
                return new WorkflowResult(
                    $"이미 열려 있는 {displayName} 입력 화면을 표시했습니다. 내용을 계속 입력해 주세요.",
                    KeepActivatedBrowser: true);
            }
            orphanedCurrentDialog = true;
        }

        if (!string.IsNullOrEmpty(openDialog))
        {
            _reportProgress($"{displayName}: 열려 있는 {openDialog} 입력창 닫는 중");
            await CloseVisibleNiceRequestDialogAsync(session, openDialog, cancellationToken);
        }

        await ResetStaleNiceTaskStateAsync(
            session,
            menuName,
            "신청",
            orphanedCurrentDialog,
            cancellationToken);

        _reportProgress($"{displayName}: {menuName} 이동 중");
        await NavigateNiceMenuToControlAsync(
            session,
            menuName,
            "신청",
            cancellationToken);

        _reportProgress($"{displayName}: 신청 입력창 준비 중");
        await OpenNiceRequestDialogAsync(
            session,
            menuName,
            dialogTitle,
            $"{menuName} 화면에서 신청 버튼을 찾지 못했습니다.",
            cancellationToken);

        await PrepareBrowserForUserAsync(session, cancellationToken);
        return new WorkflowResult(
            $"{displayName} 입력 화면을 열었습니다. 내용을 입력한 뒤 승인요청은 직접 눌러 주세요.",
            KeepActivatedBrowser: true);
    }
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
        else
        {
            await TryCloseVisibleEdufineNoticeAsync(session, cancellationToken);
        }
        await PrepareBrowserForUserAsync(session, cancellationToken);
        return new WorkflowResult(
            $"{displayName} 화면을 열었습니다.",
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
        await TryCloseVisibleEdufineNoticeAsync(session, cancellationToken);

        _reportProgress("기안: 업무관리로 전환 중");
        await SelectEdufineJobAsync(session, "업무관리", cancellationToken);
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
        await TryCloseVisibleEdufineNoticeAsync(session, cancellationToken);

        _reportProgress("품의: 학교회계로 전환 중");
        await SelectEdufineJobAsync(session, "학교회계", cancellationToken);
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

    private static async Task WaitForNiceReadyAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        await EnsureNiceSessionAvailableAsync(session, cancellationToken);
        const string expression = "(()=>{if(document.readyState!=='complete')return false;"
            + "const docs=[];const add=d=>{if(!d||docs.includes(d))return;docs.push(d);"
            + "for(const f of d.querySelectorAll('iframe,frame')){try{add(f.contentDocument)}catch{}}};add(document);"
            + "return docs.some(d=>[...d.querySelectorAll('.cl-text')].some(e=>{const t=(e.textContent||'').trim();"
            + "return t==='복무'||t.startsWith('복무 ');})||!!d.querySelector('[title=\"기본메뉴 및 승인사항\"],.btn-asd.mymenu'));})()";
        await WaitForConditionAsync(
            session,
            expression,
            TimeSpan.FromSeconds(45),
            cancellationToken,
            "나이스 기본 메뉴를 준비하는 시간이 초과되었습니다.");
        await EnsureNiceSessionAvailableAsync(session, cancellationToken);
    }

    private static async Task EnsureNiceSessionAvailableAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        if (!await TryCloseVisibleNiceSecurityShutdownDialogAsync(session, cancellationToken))
        {
            return;
        }

        throw new PortalSessionExpiredException(
            "나이스",
            "나이스 세션이 정보보호 정책에 따라 종료되었습니다. Edge에서 나이스에 다시 로그인한 뒤 연결해 주세요.");
    }

    private static async Task<bool> TryCloseVisibleNiceSecurityShutdownDialogAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        var noticeVisibleExpression = NiceSecurityShutdownVisibleExpression();
        if (!await session.EvaluateBooleanAsync(
                noticeVisibleExpression,
                cancellationToken: cancellationToken))
        {
            return false;
        }

        AppLogger.Info("Workflow", "나이스 보안 종료 안내창을 확인했습니다.");
        await session.ActivateTargetAsync(cancellationToken);
        const string confirmElementExpression = """
            (()=>{
              const normalize=value=>(value||'').replace(/\s+/g,' ').trim();
              const compact=value=>normalize(value).replace(/\s/g,'');
              const visible=element=>{
                if(!element)return false;
                const rect=element.getBoundingClientRect();
                const view=element.ownerDocument?.defaultView;
                const style=view?.getComputedStyle(element);
                return rect.width>0&&rect.height>0&&rect.x>=0&&rect.y>=0
                  &&style?.display!=='none'&&style?.visibility!=='hidden'
                  &&!element.disabled&&element.getAttribute?.('aria-disabled')!=='true';
              };
              const isShutdown=element=>{
                const text=compact(element?.innerText||element?.textContent||'');
                return text.includes('정보보호를위해시스템을종료')
                  ||text.includes('세션DB정보가없어시스템을종료')
                  ||text.includes('세션이종료되었습니다')
                  ||text.includes('다시로그인하신후서비스를이용해주시기바랍니다');
              };
              const elementText=element=>normalize(
                element.innerText||element.textContent||element.value
                ||element.getAttribute?.('aria-label')||element.title||'');
              const documents=[];
              const visit=currentDocument=>{
                if(!currentDocument||documents.includes(currentDocument))return;
                documents.push(currentDocument);
                for(const frame of currentDocument.querySelectorAll('iframe,frame')){
                  try{visit(frame.contentDocument);}catch{}
                }
              };
              const popupSelector='[role="dialog"],.cl-dialog,.modal,[class*="popup"],[class*="layer"]';
              const getScopes=currentDocument=>{
                const scopes=[];
                const add=scope=>{
                  if(scope&&!scopes.includes(scope))scopes.push(scope);
                };
                for(const scope of currentDocument.querySelectorAll(popupSelector)){
                  if(visible(scope)&&isShutdown(scope))add(scope);
                }
                const message=[...currentDocument.querySelectorAll('h1,h2,h3,h4,.cl-text,span,div,p')]
                  .find(element=>visible(element)&&isShutdown(element));
                if(message){
                  add(message.closest(popupSelector));
                  if(!message.closest(popupSelector)){
                    for(let current=message.parentElement;current;current=current.parentElement){
                      if(visible(current)&&isShutdown(current)
                        &&elementText(current).includes('확인')){add(current);break;}
                    }
                  }
                }
                return scopes;
              };
              visit(document);
              for(const currentDocument of documents){
                for(const scope of getScopes(currentDocument)){
                  const actions=[...scope.querySelectorAll(
                    'button,a,[role="button"],input[type="button"],input[type="submit"],.cl-button')]
                    .filter(visible);
                  const confirm=actions.find(action=>elementText(action)==='확인');
                  if(confirm)return confirm;
                }
              }
              return null;
            })()
            """;

        var syntheticClickExpression = "(()=>{const element=(" + confirmElementExpression
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
                    "나이스 보안 종료 안내창이 닫히는 시간이 초과되었습니다.");
                AppLogger.Info("Workflow", "나이스 보안 종료 안내창을 닫았습니다.");
                return true;
            }
            catch (TimeoutException)
            {
                AppLogger.Info("Workflow", "나이스 보안 종료 안내창을 실제 마우스 입력으로 다시 닫습니다.");
            }
        }

        const string focusConfirmExpression = "(()=>{const element=(" + confirmElementExpression
            + ");if(!element)return false;element.focus?.();return true;})()";
        if (await session.EvaluateBooleanAsync(
                focusConfirmExpression,
                userGesture: true,
                cancellationToken))
        {
            try
            {
                await session.PressKeyAsync("Enter", "Enter", 13, cancellationToken);
                await WaitForConditionAsync(
                    session,
                    $"!({noticeVisibleExpression})",
                    TimeSpan.FromSeconds(2),
                    cancellationToken,
                    "나이스 세션 종료 안내창이 닫히는 시간이 초과되었습니다.");
                AppLogger.Info("Workflow", "나이스 세션 종료 안내창을 키보드 입력으로 닫았습니다.");
                return true;
            }
            catch (TimeoutException)
            {
                AppLogger.Info("Workflow", "나이스 세션 종료 안내창의 키보드 입력을 다시 시도합니다.");
            }
        }

        try
        {
            await ClickElementCenterAsync(
                session,
                confirmElementExpression,
                "나이스 세션 종료 안내창의 확인 버튼을 찾지 못했습니다.",
                TimeSpan.FromSeconds(5),
                cancellationToken);
            await WaitForConditionAsync(
                session,
                $"!({noticeVisibleExpression})",
                TimeSpan.FromSeconds(10),
                cancellationToken,
                "나이스 세션 종료 안내창이 닫히는 시간이 초과되었습니다.");
            AppLogger.Info("Workflow", "나이스 세션 종료 안내창을 닫았습니다.");
        }
        catch (TimeoutException exception)
        {
            AppLogger.Info("Workflow", $"나이스 세션 종료 안내창 닫힘을 확인하지 못했습니다: {exception.Message}");
        }
        catch (InvalidOperationException exception)
        {
            AppLogger.Info("Workflow", $"나이스 세션 종료 안내창 확인 버튼 입력에 실패했습니다: {exception.Message}");
        }

        // 세션 종료 안내창을 확인한 이상, 닫힘 확인이 실패해도 일반 연결 실패로 처리하지 않습니다.
        // 그래야 대기 중인 업무 요청을 보존하고 사용자가 재로그인할 수 있습니다.
        return true;
    }

    private static string NiceSecurityShutdownVisibleExpression()
    {
        return """
            (()=>{
              const normalize=value=>(value||'').replace(/\s+/g,' ').trim();
              const compact=value=>normalize(value).replace(/\s/g,'');
              const visible=element=>{
                if(!element)return false;
                const rect=element.getBoundingClientRect();
                const view=element.ownerDocument?.defaultView;
                const style=view?.getComputedStyle(element);
                return rect.width>0&&rect.height>0&&rect.x>=0&&rect.y>=0
                  &&style?.display!=='none'&&style?.visibility!=='hidden';
              };
              const isShutdown=element=>{
                const text=compact(element?.innerText||element?.textContent||'');
                return text.includes('정보보호를위해시스템을종료')
                  ||text.includes('세션DB정보가없어시스템을종료')
                  ||text.includes('세션이종료되었습니다')
                  ||text.includes('다시로그인하신후서비스를이용해주시기바랍니다');
              };
              const documents=[];
              const visit=currentDocument=>{
                if(!currentDocument||documents.includes(currentDocument))return;
                documents.push(currentDocument);
                for(const frame of currentDocument.querySelectorAll('iframe,frame')){
                  try{visit(frame.contentDocument);}catch{}
                }
              };
              const popupSelector='[role="dialog"],.cl-dialog,.modal,[class*="popup"],[class*="layer"]';
              visit(document);
              return documents.some(currentDocument=>{
                if([...currentDocument.querySelectorAll(popupSelector)]
                  .some(scope=>visible(scope)&&isShutdown(scope)))return true;
                return [...currentDocument.querySelectorAll('h1,h2,h3,h4,.cl-text,span,div,p')]
                  .some(element=>visible(element)&&isShutdown(element));
              });
            })()
            """;
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

    private static async Task TryCloseVisibleEdufineNoticeAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        try
        {
            await CloseVisibleEdufineNoticeAsync(session, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            AppLogger.Info(
                "Workflow",
                $"K-에듀파인 공지사항 자동 닫기를 건너뛰고 다음 단계로 진행합니다: {exception.Message}");
        }
    }

    private static async Task CloseVisibleEdufineNoticeAsync(
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
              const popupSelector='[role="dialog"],.cl-dialog,.modal,[class*="popup"],[class*="layer"],[class*="notice"],[id*="popup"],[id*="notice"]';
              visit(document);
              return documents.some(currentDocument=>{
                const scopes=[...currentDocument.querySelectorAll(popupSelector)]
                  .filter(visible)
                  .some(scope=>normalize(scope.innerText||scope.textContent).includes('공지사항'));
                if(scopes)return true;
                return [...currentDocument.querySelectorAll('h1,h2,h3,h4,.cl-text,span,div')]
                  .some(element=>visible(element)&&normalize(element.textContent)==='공지사항'
                    &&!!element.closest(popupSelector));
              });
            })()
            """;

        if (!await session.EvaluateBooleanAsync(
                noticeVisibleExpression,
                cancellationToken: cancellationToken))
        {
            return;
        }

        AppLogger.Info("Workflow", "K-에듀파인 공지사항 안내창을 확인했습니다.");
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
              const popupSelector='[role="dialog"],.cl-dialog,.modal,[class*="popup"],[class*="layer"],[class*="notice"],[id*="popup"],[id*="notice"]';
              const elementText=element=>normalize(
                element.innerText||element.textContent||element.value
                ||element.getAttribute?.('aria-label')||element.title||'');
              const isClose=element=>{
                const text=elementText(element);
                const label=normalize(element.getAttribute?.('aria-label')||element.title||'');
                const className=typeof element.className==='string'?element.className.toLowerCase():'';
                return text==='닫기'||/^(닫기|close|x)$/i.test(label)
                  ||/(^|[-_ ])(?:btn[-_ ]?)?close(?:$|[-_ ])/i.test(className)
                  ||className.includes('닫기');
              };
              const scopesFor=currentDocument=>{
                const scopes=[];
                const add=scope=>{
                  if(scope&&!scopes.includes(scope))scopes.push(scope);
                };
                for(const scope of currentDocument.querySelectorAll(popupSelector)){
                  if(visible(scope)&&elementText(scope).includes('공지사항'))add(scope);
                }
                for(const title of currentDocument.querySelectorAll('h1,h2,h3,h4,.cl-text,span,div')){
                  if(!visible(title)||normalize(title.textContent)!=='공지사항')continue;
                  add(title.closest(popupSelector));
                  if(!title.closest(popupSelector)){
                    for(let current=title.parentElement;current;current=current.parentElement){
                      if(visible(current)&&elementText(current).includes('공지사항')
                        &&elementText(current).includes('닫기')){add(current);break;}
                    }
                  }
                }
                return scopes;
              };
              visit(document);
              for(const currentDocument of documents){
                for(const scope of scopesFor(currentDocument)){
                  const actions=[...scope.querySelectorAll(
                    'button,a,[role="button"],input[type="button"],input[type="submit"],[aria-label],[title],[class*="close"],[class*="Close"]')]
                    .filter(visible)
                    .filter(isClose)
                    .sort((left,right)=>left.children.length-right.children.length);
                  if(actions.length>0)return actions[0];
                }
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
                    "K-에듀파인 공지사항 안내창의 DOM 닫기를 재시도합니다.");
                AppLogger.Info("Workflow", "K-에듀파인 공지사항 안내창을 닫았습니다.");
                return;
            }
            catch (TimeoutException)
            {
                AppLogger.Info("Workflow", "K-에듀파인 공지사항 안내창을 실제 마우스 입력으로 다시 닫습니다.");
            }
        }

        await ClickElementCenterAsync(
            session,
            closeElementExpression,
            "K-에듀파인 공지사항 안내창의 닫기 버튼을 찾지 못했습니다.",
            TimeSpan.FromSeconds(5),
            cancellationToken);
        await WaitForConditionAsync(
            session,
            $"!({noticeVisibleExpression})",
            TimeSpan.FromSeconds(10),
            cancellationToken,
            "K-에듀파인 공지사항 안내창이 닫히는 시간이 초과되었습니다.");
        AppLogger.Info("Workflow", "K-에듀파인 공지사항 안내창을 닫았습니다.");
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
            if (await IsNiceMenuVisibleAsync(
                    session,
                    "개인근무상황관리",
                    cancellationToken))
            {
                return;
            }

            await EnsureNiceBaseMenuVisibleAsync(session, cancellationToken);
            await ClickNiceDutyMenuExpandIconAsync(session, cancellationToken);
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

    private static async Task EnsureNiceBaseMenuVisibleAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        if (await IsNiceMenuVisibleAsync(session, "복무", cancellationToken))
        {
            return;
        }

        AppLogger.Info(
            "Workflow",
            "현재 작업 화면과 무관하게 나이스 기본메뉴에서 복무 메뉴를 준비합니다.");
        const string baseMenuButtonExpression =
            "(()=>[...document.querySelectorAll('.btn-asd.mymenu,[title=\"기본메뉴 및 승인사항\"]')]"
            + ".find(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);"
            + "return r.width>0&&r.height>0&&r.x>=0&&r.y>=0"
            + "&&s.display!=='none'&&s.visibility!=='hidden';})||null)()";
        await ClickElementCenterAsync(
            session,
            baseMenuButtonExpression,
            "나이스 기본메뉴 버튼을 찾지 못했습니다.",
            TimeSpan.FromSeconds(5),
            cancellationToken);
        await WaitForConditionAsync(
            session,
            NiceMenuVisibleExpression("복무"),
            TimeSpan.FromSeconds(15),
            cancellationToken,
            "나이스 기본메뉴에서 복무 메뉴를 불러오는 시간이 초과되었습니다.");
        // 기본메뉴 조회가 끝나며 사이드 메뉴 DOM이 한 번 더 그려질 수 있으므로
        // 재렌더링 직후의 사라질 요소를 클릭하지 않도록 잠시 안정화한다.
        await Task.Delay(750, cancellationToken);
    }

    private static async Task NavigateNiceMenuToControlAsync(
        DevToolsSession session,
        string menuName,
        string controlText,
        CancellationToken cancellationToken)
    {
        var attemptTimeouts = new[]
        {
            TimeSpan.FromSeconds(4),
            TimeSpan.FromSeconds(20),
        };

        for (var attempt = 0; attempt < attemptTimeouts.Length; attempt++)
        {
            var pageReadyExpression =
                $"({NiceTaskTabSelectedExpression(menuName)})"
                + $"&&({NiceTaskControlVisibleExpression(menuName, controlText)})";
            var taskTabWasVisible = await session.EvaluateBooleanAsync(
                NiceTaskTabSelectedExpression(menuName),
                cancellationToken: cancellationToken);
            await EnsureNiceDutyMenuExpandedAsync(session, cancellationToken);
            await ClickNiceMenuAsync(session, menuName, cancellationToken);

            if (taskTabWasVisible)
            {
                await WaitForConditionAsync(
                    session,
                    $"({pageReadyExpression})"
                        + $"||!({NiceTaskTabSelectedExpression(menuName)})",
                    attemptTimeouts[attempt],
                    cancellationToken,
                    $"{menuName} 화면 전환 상태를 확인하는 시간이 초과되었습니다.");
                if (await session.EvaluateBooleanAsync(
                        pageReadyExpression,
                        cancellationToken: cancellationToken))
                {
                    return;
                }

                AppLogger.Info(
                    "Workflow",
                    $"{menuName} 탭 종료를 감지해 메뉴 이동을 즉시 다시 시도합니다.");
                continue;
            }

            try
            {
                await WaitForConditionAsync(
                    session,
                    pageReadyExpression,
                    attemptTimeouts[attempt],
                    cancellationToken,
                    $"{menuName} 화면의 {controlText} 버튼을 준비하는 시간이 초과되었습니다.");
                return;
            }
            catch (TimeoutException exception) when (
                attempt + 1 < attemptTimeouts.Length
                && exception is not DevToolsCommandTimeoutException)
            {
                AppLogger.Info(
                    "Workflow",
                    $"{menuName} 탭 종료와 화면 이동이 겹쳐 메뉴 이동을 다시 시도합니다.");
            }
        }
    }

    private static async Task ResetStaleNiceTaskStateAsync(
        DevToolsSession session,
        string menuName,
        string controlText,
        bool forceReset,
        CancellationToken cancellationToken)
    {
        if (!forceReset)
        {
            var selectedTaskTabVisible = await session.EvaluateBooleanAsync(
                NiceSelectedTaskTabVisibleExpression(),
                cancellationToken: cancellationToken);
            if (selectedTaskTabVisible)
            {
                return;
            }

            var taskTabVisible = await session.EvaluateBooleanAsync(
                NiceTaskTabSelectedExpression(menuName),
                cancellationToken: cancellationToken);
            var controlVisible = await session.EvaluateBooleanAsync(
                NiceControlVisibleExpression(controlText),
                cancellationToken: cancellationToken);
            if (taskTabVisible || !controlVisible)
            {
                return;
            }
        }

        AppLogger.Info(
            "Workflow",
            $"{menuName} 탭 없이 남은 이전 화면을 정리합니다.");
        if (!await IsNiceMenuVisibleAsync(session, menuName, cancellationToken))
        {
            return;
        }

        await ClickNiceDutyMenuExpandIconAsync(session, cancellationToken);
        await WaitForConditionAsync(
            session,
            $"!({NiceMenuVisibleExpression(menuName)})",
            TimeSpan.FromSeconds(3),
            cancellationToken,
            $"{menuName}의 이전 메뉴 상태를 정리하는 시간이 초과되었습니다.");
    }

    private static async Task ClickNiceDutyMenuExpandIconAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        var dutyMenuText = JsonSerializer.Serialize("복무");
        var expandIconExpression = "(()=>{const n=" + dutyMenuText + ";"
            + "const norm=v=>(v||'').replace(/\\s+/g,' ').trim();"
            + "const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);"
            + "return r.width>0&&r.height>0&&r.x>=0&&s.display!=='none'&&s.visibility!=='hidden';};"
            + "const links=[...document.querySelectorAll('a.cl-sidenavigation-item,a[title]')].filter(visible);"
            + "const item=links.find(e=>norm(e.getAttribute('title'))===n)"
            + "||links.find(e=>[...e.querySelectorAll('.cl-text')].some(t=>norm(t.textContent)===n&&visible(t)))"
            + "||[...document.querySelectorAll('.cl-text')].find(t=>norm(t.textContent)===n&&visible(t))"
            + "?.closest('a.cl-sidenavigation-item,a');"
            + "return item?.querySelector('.cl-expand-icon,[class*=\"expand\"]')||item||null;})()";
        try
        {
            await ClickElementCenterAsync(
                session,
                expandIconExpression,
                "나이스 복무 메뉴의 펼침 버튼을 찾지 못했습니다.",
                TimeSpan.FromSeconds(3),
                cancellationToken);
        }
        catch (InvalidOperationException)
        {
            var visibleMenus = await session.EvaluateStringAsync(
                "(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);"
                    + "return r.width>0&&r.height>0&&r.x>=0&&s.display!=='none'&&s.visibility!=='hidden';};"
                    + "return JSON.stringify([...document.querySelectorAll('a.cl-sidenavigation-item,.cl-text')]"
                    + ".filter(visible).map(e=>((e.getAttribute?.('title')||e.textContent||'')+'')"
                    + ".replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,30));})()",
                cancellationToken);
            AppLogger.Info("Workflow", $"나이스 복무 메뉴 탐색 실패 화면 항목: {visibleMenus}");
            throw;
        }
    }

    private static async Task ClickNiceMenuAsync(
        DevToolsSession session,
        string menuName,
        CancellationToken cancellationToken)
    {
        var value = JsonSerializer.Serialize(menuName);
        var elementExpression = "(()=>{const n=" + value + ";"
            + "const norm=v=>(v||'').replace(/\\s+/g,' ').trim();"
            + "const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);"
            + "return r.width>0&&r.height>0&&r.x>=0&&s.display!=='none'&&s.visibility!=='hidden';};"
            + "const t=[...document.querySelectorAll('.cl-text')].find(e=>norm(e.textContent)===n&&visible(e));"
            + "if(t)return t.closest('a')||t;"
            + "return [...document.querySelectorAll('a.cl-sidenavigation-item,a[title]')]"
            + ".find(e=>visible(e)&&(norm(e.getAttribute('title'))===n||norm(e.textContent)===n))||null;})()";
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
        var dialogClosedExpression =
            $"!(()=>{{const n={title};const visible=e=>{{const r=e.getBoundingClientRect(),s=getComputedStyle(e);"
            + "return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};"
            + "return [...document.querySelectorAll('.cl-dialog-header .cl-text,h1.cl-text')]"
            + ".some(e=>(e.textContent||'').trim()===n&&visible(e));})()";
        for (var attempt = 0; attempt < 2; attempt++)
        {
            await ClickElementCenterAsync(
                session,
                elementExpression,
                $"열려 있는 {dialogTitle} 입력창의 닫기 버튼을 찾지 못했습니다.",
                TimeSpan.FromSeconds(5),
                cancellationToken);
            try
            {
                await WaitForConditionAsync(
                    session,
                    dialogClosedExpression,
                    attempt == 0 ? TimeSpan.FromSeconds(2) : TimeSpan.FromSeconds(8),
                    cancellationToken,
                    $"{dialogTitle} 입력창이 닫히는 시간이 초과되었습니다.");
                break;
            }
            catch (TimeoutException exception) when (
                attempt == 0 && exception is not DevToolsCommandTimeoutException)
            {
                AppLogger.Info("Workflow", $"{dialogTitle} 입력창 닫기를 다시 시도합니다.");
            }
        }
        AppLogger.Info("Workflow", $"{dialogTitle} 입력창을 닫았습니다.");
    }

    private static async Task SelectEdufineJobAsync(
        DevToolsSession session,
        string jobName,
        CancellationToken cancellationToken)
    {
        const string inputSelector = "[id$='cboJobList.comboedit:input']";
        await WaitForConditionAsync(
            session,
            $"!!document.querySelector({JsonSerializer.Serialize(inputSelector)})",
            TimeSpan.FromSeconds(20),
            cancellationToken);

        var jobNames = await ReadEdufineJobNamesAsync(session, cancellationToken);
        var jobIndex = jobNames.FindIndex(name => string.Equals(name, jobName, StringComparison.Ordinal));
        if (jobIndex < 0)
        {
            throw new InvalidOperationException(
                $"K-에듀파인 업무 목록에서 {jobName}을(를) 찾지 못했습니다. "
                + $"감지된 업무: {string.Join(", ", jobNames)}");
        }

        AppLogger.Info(
            "Workflow",
            $"K-에듀파인 업무 목록: {string.Join(", ", jobNames)} / {jobName} 위치: {jobIndex + 1}번째");

        var current = await session.EvaluateStringAsync(
            $"document.querySelector({JsonSerializer.Serialize(inputSelector)})?.value ?? ''",
            cancellationToken);
        if (string.Equals(current, jobName, StringComparison.Ordinal))
        {
            return;
        }

        var serializedJobName = JsonSerializer.Serialize(jobName);
        var selectExpression = "(()=>{const wanted=" + serializedJobName + ";"
            + "const application=globalThis.nexacro?.getApplication?.()||globalThis.application;"
            + "const combo=application?.mainframe?.MainVFrameSet?.TopFrame?.form?.cboJobList;"
            + "const dataset=combo?.getInnerDataset?.()||combo?._innerdataset;"
            + "if(!combo||!dataset||typeof combo._on_value_change!=='function')return false;"
            + "const dataColumn=combo.datacolumn||'menuNm',codeColumn=combo.codecolumn||'menuId';"
            + "let targetIndex=-1;for(let row=0;row<dataset.getRowCount();row++){"
            + "const name=((dataset.getColumn(row,dataColumn)||'')+'').replace(/\\s+/g,' ').trim();"
            + "if(name===wanted){targetIndex=row;break;}}if(targetIndex<0)return false;"
            + "const postText=((dataset.getColumn(targetIndex,dataColumn)||'')+'').replace(/\\s+/g,' ').trim();"
            + "const postValue=dataset.getColumn(targetIndex,codeColumn);"
            + "const changed=combo._on_value_change(combo.index,combo.text,combo.value,targetIndex,postText,postValue);"
            + "combo.redraw?.();return changed!==false;})()";
        var selectionDispatched = await session.EvaluateBooleanAsync(
            selectExpression,
            userGesture: true,
            cancellationToken);
        if (!selectionDispatched)
        {
            throw new InvalidOperationException($"K-에듀파인에서 {jobName} 선택 이벤트를 실행하지 못했습니다.");
        }

        await WaitForConditionAsync(
            session,
            $"document.querySelector({JsonSerializer.Serialize(inputSelector)})?.value === {JsonSerializer.Serialize(jobName)}",
            TimeSpan.FromSeconds(25),
            cancellationToken);
        AppLogger.Info("Workflow", $"K-에듀파인 업무 선택 결과: {jobName}");
        await Task.Delay(800, cancellationToken);
    }

    private static async Task<List<string>> ReadEdufineJobNamesAsync(
        DevToolsSession session,
        CancellationToken cancellationToken)
    {
        const string expression = """
            (()=>{
              const application=globalThis.nexacro?.getApplication?.()||globalThis.application;
              const combo=application?.mainframe?.MainVFrameSet?.TopFrame?.form?.cboJobList;
              const dataset=combo?.getInnerDataset?.()||combo?._innerdataset;
              if(!combo||!dataset||typeof dataset.getRowCount!=='function')return '[]';
              const dataColumn=combo.datacolumn||'menuNm';
              const names=[];
              for(let row=0;row<dataset.getRowCount();row++){
                const name=((dataset.getColumn(row,dataColumn)||'')+'').replace(/\s+/g,' ').trim();
                if(name)names.push(name);
              }
              return JSON.stringify(names);
            })()
            """;
        var json = await session.EvaluateStringAsync(expression, cancellationToken);
        var jobNames = string.IsNullOrWhiteSpace(json)
            ? new List<string>()
            : JsonSerializer.Deserialize<List<string>>(json) ?? new List<string>();
        if (jobNames.Count == 0)
        {
            throw new InvalidOperationException("K-에듀파인 업무 목록을 읽지 못했습니다.");
        }

        return jobNames;
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
        string menuName,
        string text,
        string errorMessage,
        CancellationToken cancellationToken)
    {
        await ClickElementCenterAsync(
            session,
            NiceTaskControlElementExpression(menuName, text),
            errorMessage,
            TimeSpan.FromSeconds(20),
            cancellationToken);
    }

    private static async Task OpenNiceRequestDialogAsync(
        DevToolsSession session,
        string menuName,
        string dialogTitle,
        string errorMessage,
        CancellationToken cancellationToken)
    {
        var attemptTimeouts = new[]
        {
            TimeSpan.FromSeconds(3),
            TimeSpan.FromSeconds(8),
        };

        for (var attempt = 0; attempt < attemptTimeouts.Length; attempt++)
        {
            await ClickNiceControlAsync(
                session,
                menuName,
                "신청",
                errorMessage,
                cancellationToken);
            try
            {
                await WaitForVisibleTextAsync(
                    session,
                    dialogTitle,
                    attemptTimeouts[attempt],
                    cancellationToken);
                return;
            }
            catch (TimeoutException exception) when (
                attempt + 1 < attemptTimeouts.Length
                && exception is not DevToolsCommandTimeoutException)
            {
                AppLogger.Info(
                    "Workflow",
                    $"{dialogTitle} 입력창이 열리지 않아 신청 동작을 다시 시도합니다.");
                await NavigateNiceMenuToControlAsync(
                    session,
                    menuName,
                    "신청",
                    cancellationToken);
            }
        }
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
        var value = JsonSerializer.Serialize(menuName);
        return "(()=>{const n=" + value + ";"
            + "const norm=v=>(v||'').replace(/\\s+/g,' ').trim();"
            + "return [...document.querySelectorAll('.cl-text,a.cl-sidenavigation-item,a[title]')].some(e=>{"
            + "const r=e.getBoundingClientRect(),s=getComputedStyle(e);"
            + "const text=e.matches('a[title]')?e.getAttribute('title'):e.textContent;"
            + "return norm(text)===n&&r.width>0&&r.height>0&&r.x>=0"
            + "&&s.display!=='none'&&s.visibility!=='hidden';});})()";
    }

    private static string NiceControlVisibleExpression(string text)
    {
        var value = JsonSerializer.Serialize(text);
        return "(()=>{const n=" + value + ";return [...document.querySelectorAll('.cl-button,button,a')].some(e=>{"
            + "const r=e.getBoundingClientRect(),s=getComputedStyle(e);return (e.textContent||'').trim()===n"
            + "&&r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&s.display!=='none'&&s.visibility!=='hidden';});})()";
    }

    private static string NiceTaskTabSelectedExpression(string tabName)
    {
        var value = JsonSerializer.Serialize(tabName);
        return "(()=>{const n=" + value + ";return [...document.querySelectorAll('.cl-tabfolder-item')].some(e=>{"
            + "const r=e.getBoundingClientRect(),s=getComputedStyle(e);return (e.innerText||e.textContent||'').trim()===n"
            + "&&e.classList.contains('cl-selected')&&r.width>0&&r.height>0&&r.x>=0&&r.y>=0"
            + "&&s.display!=='none'&&s.visibility!=='hidden';});})()";
    }

    private static string NiceSelectedTaskTabVisibleExpression()
    {
        return "(()=>{return [...document.querySelectorAll('.cl-tabfolder-item.cl-selected')].some(e=>{"
            + "const r=e.getBoundingClientRect(),s=getComputedStyle(e);return !e.classList.contains('unable-to-close')"
            + "&&r.width>0&&r.height>0&&r.x>=0&&r.y>=0"
            + "&&s.display!=='none'&&s.visibility!=='hidden';});})()";
    }

    private static string NiceTaskControlVisibleExpression(
        string tabName,
        string controlText)
    {
        return $"!!({NiceTaskControlElementExpression(tabName, controlText)})";
    }

    private static string NiceTaskControlElementExpression(
        string tabName,
        string controlText)
    {
        var tabValue = JsonSerializer.Serialize(tabName);
        var controlValue = JsonSerializer.Serialize(controlText);
        return "(()=>{const tabName=" + tabValue + ",controlText=" + controlValue + ";"
            + "const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);"
            + "return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&s.display!=='none'&&s.visibility!=='hidden';};"
            + "const item=[...document.querySelectorAll('.cl-tabfolder-item')].find(e=>"
            + "(e.innerText||e.textContent||'').trim()===tabName&&e.classList.contains('cl-selected')&&visible(e));"
            + "const tab=item?.querySelector('[role=\"tab\"][aria-controls]');"
            + "const panel=tab?document.getElementById(tab.getAttribute('aria-controls')):null;if(!panel)return null;"
            + "const xs=[...panel.querySelectorAll('.cl-button,button,a')].filter(e=>"
            + "(e.textContent||'').trim()===controlText&&visible(e));"
            + "return xs.find(e=>e.classList.contains('btn-primary')&&e.classList.contains('cl-button'))"
            + "||xs.find(e=>e.classList.contains('cl-button'))||xs[0]||null;})()";
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
