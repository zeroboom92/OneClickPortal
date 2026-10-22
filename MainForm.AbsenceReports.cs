namespace BrowserThumbnailPrototype;

public sealed partial class MainForm
{
    private const int AbsenceReportIntervalMinutes = 10;
    private readonly System.Windows.Forms.Timer _absenceReportTimer = new()
        { Interval = AbsenceReportIntervalMinutes * 60 * 1000 };
    private CancellationTokenSource? _absenceReportCancellationSource;
    private bool _absenceReportReading;
    private AbsencePendingReadState? _lastAbsenceReportReadState;
    private string _absenceReportStatus = "결석신고서 접수대기 · 브라우저 연결 후 확인합니다.";

    private void UpdateAbsenceReportMonitoring()
    {
        if (_isClosing || IsDisposed || Disposing) return;
        if (_sourceWindow == IntPtr.Zero || _devToolsPort is null)
        {
            StopAbsenceReportMonitoring();
            return;
        }

        // Pending applications are checked regardless of optional session extension.
        // Settings changes start only the timer; the connection has its own first read.
        _absenceReportTimer.Start();
    }

    private async Task CheckAbsenceReportsOnConnectAsync(int port,
        EducationOffice office, CancellationToken cancellationToken)
    {
        var generation = _connectionGeneration;
        var window = _sourceWindow;
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cancellation.CancelAfter(TimeSpan.FromSeconds(25));
        var gateAcquired = false;
        _absenceReportReading = true;
        _absenceReportCancellationSource = cancellation;
        bool StillCurrent() => !_isClosing && !IsDisposed && !Disposing
            && generation == _connectionGeneration && port == _devToolsPort && window == _sourceWindow;
        try
        {
            // Connection setup already owns _workflowRunning. Serialize this initial
            // read with portal work, then revalidate before touching the page.
            await _portalOperationGate.WaitAsync(cancellation.Token);
            gateAcquired = true;
            if (!StillCurrent() || _confirmedExpiredSystems.Contains("나이스")) return;
            SetConnectionStatus("결석신고서 접수대기 확인 중");
            var result = await NiceAbsencePendingReader.ReadAsync(port, office, cancellation.Token);
            if (StillCurrent() && !cancellation.IsCancellationRequested
                && !_confirmedExpiredSystems.Contains("나이스")) ApplyAbsenceReportResult(result);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            if (StillCurrent() && !_confirmedExpiredSystems.Contains("나이스"))
                SetAbsenceReportStatus("결석신고서 접수대기 · 첫 조회 시간이 초과되었습니다. ↻로 다시 확인해 주세요.");
        }
        catch (PortalSessionExpiredException) { throw; }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            if (StillCurrent() && !_confirmedExpiredSystems.Contains("나이스"))
                SetAbsenceReportStatus("결석신고서 접수대기 · 첫 조회를 완료하지 못했습니다. ↻로 다시 확인해 주세요.");
            AppLogger.Info("AbsenceReports", $"연결 직후 접수대기 확인 실패 ({exception.GetType().Name})");
        }
        finally
        {
            if (gateAcquired) _portalOperationGate.Release();
            if (ReferenceEquals(_absenceReportCancellationSource, cancellation))
            {
                _absenceReportCancellationSource = null;
                _absenceReportReading = false;
            }
        }
    }

    private void StopAbsenceReportMonitoring()
    {
        _absenceReportTimer.Stop();
        _absenceReportCancellationSource?.Cancel();
        _lastAbsenceReportReadState = null;
        SetAbsenceReportStatus("결석신고서 접수대기 · 브라우저 연결 후 확인합니다.");
    }

    private void CancelAbsenceReportReadForExpiredSession()
    {
        _absenceReportCancellationSource?.Cancel();
        SetAbsenceReportStatus("결석신고서 접수대기 · 나이스 재로그인 후 확인합니다.");
    }

    private void SetAbsenceReportStatus(string status)
    {
        _absenceReportStatus = status;
        if (!_isClosing && !IsDisposed && !Disposing) RefreshNotificationSourceStatus();
    }

    private Task RefreshAbsenceReportsAsync() => RefreshAbsenceReportsCoreAsync(scheduled: false);

    private Task RefreshScheduledAbsenceReportsAsync() => RefreshAbsenceReportsCoreAsync(scheduled: true);

    private async Task RefreshAbsenceReportsCoreAsync(bool scheduled)
    {
        if (_isClosing || IsDisposed || Disposing || _absenceReportReading || _workflowRunning
            || _devToolsPort is not int port || _sourceWindow == IntPtr.Zero) return;
        if (_confirmedExpiredSystems.Contains("나이스"))
        {
            CancelAbsenceReportReadForExpiredSession();
            return;
        }

        var generation = _connectionGeneration;
        var window = _sourceWindow;
        var office = EducationOfficeCatalog.GetByCode(AppPreferences.GetEducationOfficeCode());
        _absenceReportReading = true;
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        _absenceReportCancellationSource = cancellation;
        var gateAcquired = false;
        bool StillCurrent() => !_isClosing && !IsDisposed && !Disposing
            && generation == _connectionGeneration && port == _devToolsPort && window == _sourceWindow;
        try
        {
            // A timer tick never queues behind interactive work. Manual refresh can
            // wait, but must recheck the connection, workflow and session afterwards.
            if (scheduled)
            {
                if (!await _portalOperationGate.WaitAsync(0, cancellation.Token)) return;
            }
            else await _portalOperationGate.WaitAsync(cancellation.Token);
            gateAcquired = true;
            if (!StillCurrent() || _workflowRunning || _confirmedExpiredSystems.Contains("나이스")) return;
            var result = await NiceAbsencePendingReader.ReadAsync(port, office, cancellation.Token);
            if (!StillCurrent() || cancellation.IsCancellationRequested
                || _confirmedExpiredSystems.Contains("나이스")) return;
            ApplyAbsenceReportResult(result);
        }
        catch (OperationCanceledException)
        {
            if (StillCurrent() && !_workflowRunning && !_confirmedExpiredSystems.Contains("나이스"))
                SetAbsenceReportStatus("결석신고서 접수대기 · 확인이 취소되었거나 시간이 초과되었습니다. 다음 주기에 다시 확인합니다.");
        }
        catch (PortalSessionExpiredException)
        {
            if (StillCurrent()) CancelAbsenceReportReadForExpiredSession();
        }
        catch (Exception exception)
        {
            if (StillCurrent() && !_confirmedExpiredSystems.Contains("나이스"))
                SetAbsenceReportStatus("결석신고서 접수대기 · 확인하지 못했습니다. 다음 주기에 다시 확인합니다.");
            // Exceptions from a page can contain student names or document contents.
            AppLogger.Info("AbsenceReports", $"접수대기 확인 실패 ({exception.GetType().Name})");
        }
        finally
        {
            if (gateAcquired) _portalOperationGate.Release();
            if (ReferenceEquals(_absenceReportCancellationSource, cancellation))
            {
                _absenceReportCancellationSource = null;
                _absenceReportReading = false;
            }
        }
    }

    private void ApplyAbsenceReportResult(AbsencePendingReadResult result)
    {
        if (_lastAbsenceReportReadState != result.State)
        {
            AppLogger.Info("AbsenceReports", $"접수대기 확인 상태: {result.State}");
            _lastAbsenceReportReadState = result.State;
        }

        if (result.State == AbsencePendingReadState.Available && result.Items is { } items
            && !string.IsNullOrWhiteSpace(result.Scope))
        {
            SetAbsenceReportStatus($"결석신고서 접수대기 · {items.Count:N0}건 · {DateTime.Now:HH:mm:ss} 확인\n연결 시와 {AbsenceReportIntervalMinutes}분마다 조회합니다.");
            if (_studentNotificationPreview) return;
            // Only the notification engine receives stable source identifiers. Its
            // daily scoped fingerprints and generic count summaries handle all storage.
            var added = _notificationCenter.ObservePendingAbsenceReports(items, result.Scope);
            ShowNewNotificationPopup(added);
            return;
        }

        SetAbsenceReportStatus(result.State switch
        {
            AbsencePendingReadState.PageMissing => "결석신고서 접수대기 · 나이스 화면이 열려 있지 않습니다.",
            AbsencePendingReadState.MultiplePages => "결석신고서 접수대기 · 나이스 탭이 여러 개라 확인할 대상을 정할 수 없습니다.",
            AbsencePendingReadState.ScopeUnavailable => "결석신고서 접수대기 · 로그인 계정과 학교를 확인하지 못했습니다. 나이스 로그인 상태를 확인해 주세요.",
            AbsencePendingReadState.Busy => "결석신고서 접수대기 · 나이스 화면 작업이 끝난 뒤 다음 주기에 다시 확인합니다.",
            AbsencePendingReadState.QueryFailed => "결석신고서 접수대기 · 조회를 완료하지 못했습니다. 다음 주기에 다시 확인합니다.",
            AbsencePendingReadState.NotAuthorized => "결석신고서 접수대기 · 결석신고서관리 조회 권한을 확인해 주세요.",
            _ => "결석신고서 접수대기 · 전체 조회 결과를 확인하지 못했습니다. 다음 주기에 다시 확인합니다.",
        });
    }
}
