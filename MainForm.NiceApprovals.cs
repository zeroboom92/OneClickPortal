namespace BrowserThumbnailPrototype;

public sealed partial class MainForm
{
    private const int NiceApprovalIntervalMinutes = 1;
    // A busy shared gate is retried on a later tick, rather than repeatedly
    // colliding with the separate one-minute session-extension timer.
    private readonly System.Windows.Forms.Timer _niceApprovalTimer = new() { Interval = 5 * 1000 };
    private readonly ApprovalPollingSchedule _niceApprovalPolling = new();
    private CancellationTokenSource? _niceApprovalCancellationSource;
    private bool _niceApprovalReading;
    private NiceApprovalReadState? _lastNiceApprovalReadState;
    private string _niceApprovalStatus = "나이스 결재대기 · 브라우저 연결 후 확인합니다.";

    private void UpdateNiceApprovalMonitoring()
    {
        if (_isClosing || IsDisposed || Disposing) return;
        if (_sourceWindow == IntPtr.Zero || _devToolsPort is null)
        {
            StopNiceApprovalMonitoring();
            return;
        }
        // Monitoring does not depend on optional automatic session extension.
        // Only connecting and an explicit refresh initiate an immediate read.
        _niceApprovalTimer.Start();
    }

    private void StopNiceApprovalMonitoring()
    {
        _niceApprovalTimer.Stop();
        _niceApprovalCancellationSource?.Cancel();
        _niceApprovalPolling.Reset();
        _lastNiceApprovalReadState = null;
        SetNiceApprovalMenuCount(null);
        SetNiceApprovalStatus("나이스 결재대기 · 브라우저 연결 후 확인합니다.");
    }

    private void CancelNiceApprovalReadForExpiredSession()
    {
        _niceApprovalCancellationSource?.Cancel();
        SetNiceApprovalStatus("나이스 결재대기 · 나이스 재로그인 후 확인합니다.");
        SetNiceApprovalMenuCount(null);
    }

    private void SetNiceApprovalStatus(string status)
    {
        _niceApprovalStatus = status;
        if (!_isClosing && !IsDisposed && !Disposing) RefreshNotificationSourceStatus();
    }

    private Task CheckNiceApprovalsOnConnectAsync(CancellationToken cancellationToken) =>
        RefreshNiceApprovalsCoreAsync(scheduled: false, connecting: true, cancellationToken);

    private Task RefreshNiceApprovalsAsync() => RefreshNiceApprovalsCoreAsync(scheduled: false);

    private Task RefreshScheduledNiceApprovalsAsync() => RefreshNiceApprovalsCoreAsync(scheduled: true);

    private async Task RefreshNiceApprovalsCoreAsync(bool scheduled, bool connecting = false,
        CancellationToken cancellationToken = default)
    {
        if (_isClosing || IsDisposed || Disposing || _niceApprovalReading || (_workflowRunning && !connecting)
            || _devToolsPort is not int port || _sourceWindow == IntPtr.Zero) return;
        if (_confirmedExpiredSystems.Contains("나이스"))
        {
            CancelNiceApprovalReadForExpiredSession();
            return;
        }
        if (scheduled && !_niceApprovalPolling.IsDue(Environment.TickCount64, edufineActive: false)) return;

        var generation = _connectionGeneration;
        var window = _sourceWindow;
        var office = EducationOfficeCatalog.GetByCode(AppPreferences.GetEducationOfficeCode());
        _niceApprovalReading = true;
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cancellation.CancelAfter(TimeSpan.FromSeconds(25));
        _niceApprovalCancellationSource = cancellation;
        var gateAcquired = false;
        bool StillCurrent() => !_isClosing && !IsDisposed && !Disposing
            && generation == _connectionGeneration && port == _devToolsPort && window == _sourceWindow;
        try
        {
            // Timer work never waits behind a user's workflow or session check.
            if (scheduled)
            {
                if (!await _portalOperationGate.WaitAsync(0, cancellation.Token)) return;
            }
            else await _portalOperationGate.WaitAsync(cancellation.Token);
            gateAcquired = true;
            cancellation.Token.ThrowIfCancellationRequested();
            if (!StillCurrent() || (_workflowRunning && !connecting)
                || _confirmedExpiredSystems.Contains("나이스")) return;
            if (connecting) SetConnectionStatus("나이스 결재대기 확인 중");
            _niceApprovalPolling.RecordAttempt(Environment.TickCount64, fullScan: true);
            var result = await NiceApprovalReader.ReadAsync(port, office, cancellation.Token);
            if (!StillCurrent() || cancellation.IsCancellationRequested
                || _confirmedExpiredSystems.Contains("나이스")) return;
            ApplyNiceApprovalResult(result);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            if (StillCurrent() && (connecting || !_workflowRunning) && !_confirmedExpiredSystems.Contains("나이스"))
            {
                SetNiceApprovalMenuCount(null);
                SetNiceApprovalStatus("나이스 결재대기 · 확인이 취소되었거나 시간이 초과되었습니다. 다음 주기에 다시 확인합니다.");
            }
        }
        catch (PortalSessionExpiredException)
        {
            if (StillCurrent()) CancelNiceApprovalReadForExpiredSession();
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            if (StillCurrent() && !_confirmedExpiredSystems.Contains("나이스"))
            {
                SetNiceApprovalMenuCount(null);
                SetNiceApprovalStatus("나이스 결재대기 · 확인하지 못했습니다. 다음 주기에 다시 확인합니다.");
            }
            AppLogger.Info("NiceApprovals", $"건수 확인 실패 ({exception.GetType().Name})");
        }
        finally
        {
            if (gateAcquired) _portalOperationGate.Release();
            if (ReferenceEquals(_niceApprovalCancellationSource, cancellation))
            {
                _niceApprovalCancellationSource = null;
                _niceApprovalReading = false;
            }
        }
    }

    private void ApplyNiceApprovalResult(NiceApprovalReadResult result)
    {
        if (_lastNiceApprovalReadState != result.State)
        {
            AppLogger.Info("NiceApprovals", $"건수 확인 상태: {result.State}");
            _lastNiceApprovalReadState = result.State;
        }
        if (result.State == NiceApprovalReadState.Available && result.Count is >= 0
            && !string.IsNullOrWhiteSpace(result.Scope))
        {
            var count = result.Count.Value;
            SetNiceApprovalMenuCount(count);
            SetNiceApprovalStatus($"나이스 결재대기 · {count:N0}건 · {DateTime.Now:HH:mm:ss} 확인\n미결/협조함 건수를 연결 시와 {NiceApprovalIntervalMinutes}분마다 조회하고 증가하면 알립니다.");
            if (_studentNotificationPreview) return;
            var added = _notificationCenter.ObserveCount(NotificationKind.NiceApproval, count, result.Scope);
            ShowNewNotificationPopup(added);
            return;
        }
        // Failed reads never become zero and never change the previous baseline.
        SetNiceApprovalMenuCount(null);
        SetNiceApprovalStatus(result.State switch
        {
            NiceApprovalReadState.PageMissing => "나이스 결재대기 · 나이스 화면이 열려 있지 않습니다.",
            NiceApprovalReadState.MultiplePages => "나이스 결재대기 · 나이스 탭이 여러 개라 확인할 대상을 정할 수 없습니다.",
            NiceApprovalReadState.ScopeUnavailable => "나이스 결재대기 · 로그인 계정과 학교를 확인하지 못했습니다. 나이스 로그인 상태를 확인해 주세요.",
            NiceApprovalReadState.Busy => "나이스 결재대기 · 나이스 화면 작업이 끝난 뒤 다음 주기에 다시 확인합니다.",
            NiceApprovalReadState.QueryFailed => "나이스 결재대기 · 조회를 완료하지 못했습니다. 다음 주기에 다시 확인합니다.",
            _ => "나이스 결재대기 · 조회 결과를 확인하지 못했습니다. 다음 주기에 다시 확인합니다.",
        });
    }
}
