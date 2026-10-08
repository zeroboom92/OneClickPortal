namespace BrowserThumbnailPrototype;

public sealed partial class MainForm
{
    // Each tick checks local window state; a background browser is read only once per minute.
    private readonly System.Windows.Forms.Timer _approvalBadgeTimer = new() { Interval = 5 * 1000 };
    private readonly ApprovalPollingSchedule _approvalPolling = new();
    private GlassTaskButton? _approvalButton;
    private readonly TaskCountBadge _approvalBadge = new();
    private CancellationTokenSource? _approvalBadgeCancellationSource;
    private bool _approvalBadgeReading;
    private DateTimeOffset? _approvalBadgeReadAt;
    private ApprovalReadState? _lastApprovalReadState;

    private void SetApprovalBadge(int? count, string description)
    {
        if (_approvalButton is null || _isClosing || IsDisposed || Disposing) return;
        _approvalBadge.BadgeCount = count;
        _approvalBadgeReadAt = count is null ? null : DateTimeOffset.UtcNow;
        _approvalButton.AccessibleName = count is int value ? $"결재 · 결재대기 {value:N0}건" : "결재";
        _approvalButton.AccessibleDescription = description;
        _statusTip.SetToolTip(_approvalButton, description + "\n클릭하면 결재대기 목록을 엽니다.");
        _approvalBadge.AccessibleName = _approvalButton.AccessibleName;
        _approvalBadge.AccessibleDescription = description;
        _statusTip.SetToolTip(_approvalBadge, description + "\n클릭하면 결재대기 목록을 엽니다.");
        PositionApprovalBadge();
    }

    private void InitializeApprovalBadge()
    {
        Controls.Add(_approvalBadge);
        _approvalBadge.Click += (_, _) => _approvalButton?.PerformClick();
        _rootLayout.Layout += (_, _) => PositionApprovalBadge();
        _overviewTaskButtonPanel.Layout += (_, _) => PositionApprovalBadge();
        _overviewTaskButtonPanel.LocationChanged += (_, _) => PositionApprovalBadge();
        _approvalButton!.LocationChanged += (_, _) => PositionApprovalBadge();
        _approvalButton.SizeChanged += (_, _) => PositionApprovalBadge();
        _approvalButton.VisibleChanged += (_, _) => PositionApprovalBadge();
        _approvalButton.EnabledChanged += (_, _) => _approvalBadge.Enabled = _approvalButton.Enabled;
    }

    private void PositionApprovalBadge()
    {
        if (_approvalButton is null || _approvalBadge.Parent is null || _isClosing) return;
        var point = Point.Empty;
        Control? current = _approvalButton;
        while (current is not null && current != this)
        {
            point.Offset(current.Location);
            current = current.Parent;
        }
        if (current != this) { _approvalBadge.Visible = false; return; }
        var scale = DeviceDpi / 96f;
        int Pixels(int value) => (int)Math.Round(value * scale);
        var badgeSize = Pixels(14);
        // The stacked layout has a budget button immediately below, so keep its badge inside
        // the lower edge. The single row has room for a 4px overhang in the existing padding.
        var overhang = _displayMode == PortalDisplayMode.TopDock ? Pixels(4) : 0;
        _approvalBadge.Bounds = new Rectangle(point.X + _approvalButton.Width - badgeSize,
            point.Y + _approvalButton.Height - badgeSize + overhang, badgeSize, badgeSize);
        _approvalBadge.Enabled = _approvalButton.Enabled;
        _approvalBadge.Visible = _approvalBadge.BadgeCount is not null && _approvalButton.Visible;
        if (Controls.GetChildIndex(_approvalBadge) != 0) _approvalBadge.BringToFront();
    }

    private void UpdateApprovalMonitoring()
    {
        if (_isClosing || IsDisposed || Disposing) return;
        if (_sourceWindow == IntPtr.Zero || _devToolsPort is null)
        {
            StopApprovalMonitoring();
            return;
        }
        // Reading a displayed counter is independent of the optional session extension setting.
        _approvalBadgeTimer.Start();
        if (!_workflowRunning) _ = RefreshApprovalBadgeAsync();
    }

    private void StopApprovalMonitoring()
    {
        _approvalBadgeTimer.Stop();
        _approvalBadgeCancellationSource?.Cancel();
        _approvalPolling.Reset();
        _lastApprovalReadState = null;
        SetApprovalBadge(null, "브라우저 연결 후 결재대기 건수를 확인합니다.");
    }

    private Task RefreshApprovalBadgeAsync() => RefreshApprovalBadgeCoreAsync(scheduled: false);

    private Task RefreshScheduledApprovalBadgeAsync() => RefreshApprovalBadgeCoreAsync(scheduled: true);

    private bool IsEdufineInUse()
    {
        // Only inspect the connected window's local title. No page connection or document scan
        // is needed to switch between the 5-second and 1-minute schedules.
        return _sourceWindow != IntPtr.Zero && !_sourceTransparent
            && NativeMethods.IsWindow(_sourceWindow) && NativeMethods.IsWindowVisible(_sourceWindow)
            && !NativeMethods.IsIconic(_sourceWindow)
            && NativeMethods.GetForegroundWindow() == _sourceWindow
            && NativeMethods.GetWindowTitle(_sourceWindow).Contains("에듀파인", StringComparison.OrdinalIgnoreCase);
    }

    private async Task RefreshApprovalBadgeCoreAsync(bool scheduled)
    {
        if (_isClosing || IsDisposed || Disposing || _approvalBadgeReading || _workflowRunning
            || _devToolsPort is not int port || _sourceWindow == IntPtr.Zero) return;
        if (_confirmedExpiredSystems.Contains("K-에듀파인"))
        {
            SetApprovalBadge(null, "K-에듀파인 재로그인 후 건수를 확인합니다.");
            return;
        }

        if (scheduled && !_approvalPolling.IsDue(Environment.TickCount64, IsEdufineInUse())) return;

        var generation = _connectionGeneration;
        var window = _sourceWindow;
        var office = EducationOfficeCatalog.GetByCode(AppPreferences.GetEducationOfficeCode());
        _approvalBadgeReading = true;
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        _approvalBadgeCancellationSource = cancellation;
        var gateAcquired = false;
        bool StillCurrent() => !_isClosing && !IsDisposed && !Disposing
            && generation == _connectionGeneration && port == _devToolsPort && window == _sourceWindow;
        try
        {
            // Automatic checks never queue behind another operation. Manual refreshes still wait,
            // and a user's workflow cancels any count read before taking the gate.
            if (scheduled)
            {
                if (!await _portalOperationGate.WaitAsync(0, cancellation.Token)) return;
            }
            else await _portalOperationGate.WaitAsync(cancellation.Token);
            gateAcquired = true;
            if (!StillCurrent() || _workflowRunning) return;
            if (_confirmedExpiredSystems.Contains("K-에듀파인"))
            {
                SetApprovalBadge(null, "K-에듀파인 재로그인 후 건수를 확인합니다.");
                return;
            }
            var now = Environment.TickCount64;
            var fullScan = _approvalPolling.RequiresFullScan(now, forced: !scheduled);
            _approvalPolling.RecordAttempt(now, fullScan);
            var result = await EdufineApprovalReader.ReadAsync(port, office, cancellation.Token, fullScan);
            if (!StillCurrent() || cancellation.IsCancellationRequested) return;
            if (_lastApprovalReadState != result.State)
            {
                AppLogger.Info("ApprovalBadge", $"건수 읽기 상태: {result.State}");
                _lastApprovalReadState = result.State;
            }
            var count = result.Count;
            SetApprovalBadge(count, count is int value
                ? $"결재대기 {value:N0}건 · {DateTime.Now:HH:mm:ss} 화면에서 확인\n에듀파인 사용 중 약 5초, 그 외 1분마다 표시 건수를 확인합니다."
                : result.State switch
                {
                    ApprovalReadState.PageMissing => "에듀파인 화면이 열려 있지 않습니다. 에듀파인을 연 뒤 ↻를 눌러 주세요.",
                    ApprovalReadState.MultiplePages => "에듀파인 탭이 여러 개라 건수를 확인할 대상을 정할 수 없습니다.",
                    _ => "현재 에듀파인 화면에서 결재대기 건수를 확인할 수 없습니다. 요약이 보이는 화면에서 ↻를 눌러 주세요.",
                });
        }
        catch (OperationCanceledException)
        {
            if (StillCurrent() && !_workflowRunning)
                SetApprovalBadge(null, "결재대기 건수 확인 시간이 초과되었습니다.");
        }
        catch (Exception exception)
        {
            if (StillCurrent())
                SetApprovalBadge(null, "결재대기 건수를 읽지 못했습니다. 다음 주기에 다시 확인합니다.");
            // Do not log document contents, user details, URLs or page exceptions.
            AppLogger.Info("ApprovalBadge", $"건수 확인 실패 ({exception.GetType().Name})");
        }
        finally
        {
            if (gateAcquired) _portalOperationGate.Release();
            if (ReferenceEquals(_approvalBadgeCancellationSource, cancellation))
                _approvalBadgeCancellationSource = null;
            _approvalBadgeReading = false;
        }
    }
}
