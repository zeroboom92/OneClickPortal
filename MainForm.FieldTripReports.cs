namespace BrowserThumbnailPrototype;

public sealed partial class MainForm
{
    private const int FieldTripReportIntervalMinutes = 10;
    private readonly System.Windows.Forms.Timer _fieldTripReportTimer = new()
        { Interval = FieldTripReportIntervalMinutes * 60 * 1000 };
    private CancellationTokenSource? _fieldTripReportCancellationSource;
    private bool _fieldTripReportReading;
    private FieldTripReportReadState? _lastFieldTripReportReadState;
    private string _fieldTripReportStatus = "교외체험학습 보고서 · 브라우저 연결 후 확인합니다.";

    private void UpdateFieldTripReportMonitoring()
    {
        if (_isClosing || IsDisposed || Disposing) return;
        if (_sourceWindow == IntPtr.Zero || _devToolsPort is null)
        {
            StopFieldTripReportMonitoring();
            return;
        }

        // Pending reports are monitored independently of optional session extension.
        _fieldTripReportTimer.Start();
    }

    private async Task CheckFieldTripReportsOnConnectAsync(PortalWorkflowController controller, int port,
        EducationOffice office, CancellationToken cancellationToken)
    {
        var generation = _connectionGeneration;
        var window = _sourceWindow;
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cancellation.CancelAfter(TimeSpan.FromSeconds(60));
        var gateAcquired = false;
        _fieldTripReportReading = true;
        _fieldTripReportCancellationSource = cancellation;
        bool StillCurrent() => !_isClosing && !IsDisposed && !Disposing
            && generation == _connectionGeneration && port == _devToolsPort && window == _sourceWindow;
        try
        {
            // This is part of connecting, before other monitoring is started. It is allowed
            // while _workflowRunning protects connection setup from user workflows.
            await _portalOperationGate.WaitAsync(cancellation.Token);
            gateAcquired = true;
            if (!StillCurrent()) return;
            SetConnectionStatus("교외체험학습 미상신 보고서 먼저 확인 중");
            await controller.EnsureFieldTripReportReadyAsync(cancellation.Token);
            if (!StillCurrent() || cancellation.IsCancellationRequested) return;
            var result = await NiceFieldTripReportReader.ReadAsync(port, office, cancellation.Token);
            if (StillCurrent() && !cancellation.IsCancellationRequested) ApplyFieldTripReportResult(result);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            if (StillCurrent()) SetFieldTripReportStatus("교외체험학습 보고서 · 첫 조회 시간이 초과되었습니다. ↻로 다시 확인해 주세요.");
        }
        catch (PortalSessionExpiredException) { throw; }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            if (StillCurrent()) SetFieldTripReportStatus("교외체험학습 보고서 · 첫 조회를 완료하지 못했습니다. ↻로 다시 확인해 주세요.");
            // Report setup must not prevent the other systems from connecting.
            AppLogger.Info("FieldTripReports", $"연결 직후 보고서 확인 실패 ({exception.GetType().Name})");
        }
        finally
        {
            if (gateAcquired) _portalOperationGate.Release();
            if (ReferenceEquals(_fieldTripReportCancellationSource, cancellation))
                _fieldTripReportCancellationSource = null;
            _fieldTripReportReading = false;
        }
    }

    private void StopFieldTripReportMonitoring()
    {
        _fieldTripReportTimer.Stop();
        _fieldTripReportCancellationSource?.Cancel();
        _lastFieldTripReportReadState = null;
        SetFieldTripReportStatus("교외체험학습 보고서 · 브라우저 연결 후 확인합니다.");
    }

    private void CancelFieldTripReportReadForExpiredSession()
    {
        _fieldTripReportCancellationSource?.Cancel();
        SetFieldTripReportStatus("교외체험학습 보고서 · 나이스 재로그인 후 확인합니다.");
    }

    private void SetFieldTripReportStatus(string status)
    {
        _fieldTripReportStatus = status;
        if (!_isClosing && !IsDisposed && !Disposing) RefreshNotificationSourceStatus();
    }

    private Task RefreshFieldTripReportsAsync() => RefreshFieldTripReportsCoreAsync(scheduled: false);

    private Task RefreshScheduledFieldTripReportsAsync() => RefreshFieldTripReportsCoreAsync(scheduled: true);

    private async Task RefreshFieldTripReportsCoreAsync(bool scheduled)
    {
        if (_isClosing || IsDisposed || Disposing || _fieldTripReportReading || _workflowRunning
            || _devToolsPort is not int port || _sourceWindow == IntPtr.Zero) return;
        if (_confirmedExpiredSystems.Contains("나이스"))
        {
            CancelFieldTripReportReadForExpiredSession();
            return;
        }

        var generation = _connectionGeneration;
        var window = _sourceWindow;
        var office = EducationOfficeCatalog.GetByCode(AppPreferences.GetEducationOfficeCode());
        _fieldTripReportReading = true;
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        _fieldTripReportCancellationSource = cancellation;
        var gateAcquired = false;
        bool StillCurrent() => !_isClosing && !IsDisposed && !Disposing
            && generation == _connectionGeneration && port == _devToolsPort && window == _sourceWindow;
        try
        {
            // Manual reads wait for an operation already in progress. Timer ticks never
            // queue behind user work; the connection's first check has its own priority path.
            if (scheduled)
            {
                if (!await _portalOperationGate.WaitAsync(0, cancellation.Token)) return;
            }
            else await _portalOperationGate.WaitAsync(cancellation.Token);
            gateAcquired = true;
            if (!StillCurrent() || _workflowRunning || _confirmedExpiredSystems.Contains("나이스")) return;

            var result = await NiceFieldTripReportReader.ReadAsync(port, office, cancellation.Token);
            if (!StillCurrent() || cancellation.IsCancellationRequested) return;
            ApplyFieldTripReportResult(result);
        }
        catch (OperationCanceledException)
        {
            if (StillCurrent() && !_workflowRunning && !_confirmedExpiredSystems.Contains("나이스"))
                SetFieldTripReportStatus("교외체험학습 보고서 · 확인이 취소되었거나 시간이 초과되었습니다. 다음 주기에 다시 확인합니다.");
        }
        catch (Exception exception)
        {
            if (StillCurrent())
                SetFieldTripReportStatus("교외체험학습 보고서 · 확인하지 못했습니다. 다음 주기에 다시 확인합니다.");
            // Do not log report contents, student details, source IDs or page exceptions.
            AppLogger.Info("FieldTripReports", $"보고서 확인 실패 ({exception.GetType().Name})");
        }
        finally
        {
            if (gateAcquired) _portalOperationGate.Release();
            if (ReferenceEquals(_fieldTripReportCancellationSource, cancellation))
                _fieldTripReportCancellationSource = null;
            _fieldTripReportReading = false;
        }
    }

    private void ApplyFieldTripReportResult(FieldTripReportReadResult result)
    {
        if (_lastFieldTripReportReadState != result.State)
        {
            AppLogger.Info("FieldTripReports", $"보고서 확인 상태: {result.State}");
            _lastFieldTripReportReadState = result.State;
        }

        if (result.State == FieldTripReportReadState.Available && result.Items is { } items
            && !string.IsNullOrWhiteSpace(result.Scope))
        {
            SetFieldTripReportStatus($"교외체험학습 보고서 · 미상신 {items.Count:N0}건 · {DateTime.Now:HH:mm:ss} 확인\n연결 직후 먼저 확인하고, 이후 {FieldTripReportIntervalMinutes}분마다 조회합니다.");
            // A simulation shows only its three synthetic entries, even though its
            // menu clicks and connection preparation use the real logged-in browser.
            if (_studentNotificationPreview) return;
            // The reader supplies a durable office/account/school scope. Browser ports,
            // tab IDs and changing class filters must never become deduplication keys.
            var added = _notificationCenter.ObservePendingFieldTripReports(items, result.Scope);
            ShowNewNotificationPopup(added);
            return;
        }

        SetFieldTripReportStatus(result.State switch
        {
            FieldTripReportReadState.PageMissing => "교외체험학습 보고서 · 나이스 화면이 열려 있지 않습니다.",
            FieldTripReportReadState.MultiplePages => "교외체험학습 보고서 · 나이스 탭이 여러 개라 확인할 대상을 정할 수 없습니다.",
            FieldTripReportReadState.ReportPageMissing => "교외체험학습 보고서 · 보고서관리 탭이 닫혀 있습니다. 다시 연결하거나 나이스에서 보고서관리를 열어 주세요.",
            FieldTripReportReadState.ScopeUnavailable => "교외체험학습 보고서 · 로그인 계정과 학교를 확인하지 못했습니다. 나이스 로그인 상태를 확인해 주세요.",
            FieldTripReportReadState.Busy => "교외체험학습 보고서 · 나이스 화면 작업이 끝난 뒤 다음 주기에 다시 확인합니다.",
            FieldTripReportReadState.QueryFailed => "교외체험학습 보고서 · 조회를 완료하지 못했습니다. 다음 주기에 다시 확인합니다.",
            _ => "교외체험학습 보고서 · 전체 조회 결과를 확인하지 못했습니다. 다음 주기에 다시 확인합니다.",
        });
    }
}
