namespace BrowserThumbnailPrototype;

public sealed partial class MainForm
{
    private readonly NotificationCenter _notificationCenter;
    private readonly NotificationBellButton _notificationsButton = new();
    private readonly ToolStripMenuItem _notificationMenuItem = new("알림");
    private NotificationCenterForm? _notificationDialog;
    private long _notificationBellDismissedAt;

    private void InitializeNotifications()
    {
        _notificationCenter.Changed += OnNotificationsChanged;
        VisibleChanged += (_, _) => { if (!Visible) CloseNotificationCenter(); };
        LocationChanged += (_, _) => PositionNotificationCenter();
        RefreshNotificationIndicators();
    }

    private void OnNotificationsChanged(object? sender, EventArgs e)
    {
        if (_isClosing || IsDisposed || Disposing) return;
        if (InvokeRequired)
        {
            try { BeginInvoke(new Action(() => OnNotificationsChanged(sender, e))); }
            catch (InvalidOperationException) { /* The window closed while a refresh was queued. */ }
            return;
        }
        RefreshNotificationIndicators();
    }

    private void RefreshNotificationIndicators()
    {
        var unread = _notificationCenter.UnreadCount;
        _notificationsButton.HasUnread = unread > 0;
        _notificationsButton.AccessibleName = $"알림 · 미확인 {unread:N0}건";
        _notificationsButton.AccessibleDescription = _studentNotificationPreview
            ? "모의 신청서·결석신고서·보고서 알림을 누르면 실제 나이스 메뉴를 조회합니다."
            : "결재대기 건수 증가와 교외체험학습 보고서 미상신 알림을 모아 확인합니다.";
        _notificationMenuItem.Text = unread == 0 ? "알림" : $"알림 · 미확인 {unread:N0}건";
        _trayIcon.Text = unread == 0 ? "원클릭 업무포털 · 클릭하여 열기" : $"원클릭 업무포털 · 미확인 알림 {unread:N0}건";
        RefreshNotificationSourceStatus();
    }

    private void ObserveApprovalNotifications(int count, string scope)
    {
        if (_studentNotificationPreview) return;
        // Reuse the existing successful read; notification monitoring adds no browser requests.
        var added = _notificationCenter.ObserveCount(NotificationKind.Approval, count, scope);
        ShowNewNotificationPopup(added);
    }

    private void ResetNotificationObservations()
    {
        // An explicit login/reconnect or confirmed expiry may mean a different account,
        // even if Chromium reuses the same tab ID. Ordinary read failures keep the baseline.
        _approvalBadgeCancellationSource?.Cancel();
        _fieldTripReportCancellationSource?.Cancel();
        _notificationCenter.ResetObservations();
    }

    private void ShowNewNotificationPopup(IReadOnlyList<PortalNotification> added)
    {
        if (added.Count == 0 || _isClosing || IsDisposed || Disposing
            || _notificationDialog?.Visible == true || !AppPreferences.AreNotificationPopupsEnabled()) return;
        var latest = added[0];
        try
        {
            _trayIcon.ShowBalloonTip(6000, latest.Title,
                latest.Message + "\n클릭하면 알림이 열립니다.", ToolTipIcon.Info);
        }
        catch (Exception exception)
        {
            // A Windows popup failure must not invalidate a successful count read or its saved alert.
            AppLogger.Info("Notifications", $"팝업 표시 실패 ({exception.GetType().Name})");
        }
    }

    private bool CanOpenNotificationSource(NotificationKind kind) =>
        IsBrowserConnected() && !_workflowRunning && (kind switch
        {
            NotificationKind.Approval => !_confirmedExpiredSystems.Contains("K-에듀파인"),
            NotificationKind.FieldTrip or NotificationKind.Absence or NotificationKind.FieldTripReport
                => !_confirmedExpiredSystems.Contains("나이스"),
            _ => false,
        });

    internal void ShowNotificationCenter() => OpenNotificationCenter();

    private void ToggleNotificationCenter()
    {
        // A click on the bell can deactivate and close the popup before Click is raised.
        var dismissedAt = _notificationBellDismissedAt;
        _notificationBellDismissedAt = 0;
        if (dismissedAt != 0 && Environment.TickCount64 - dismissedAt < 300) return;
        if (_notificationDialog is { IsDisposed: false }) CloseNotificationCenter();
        else OpenNotificationCenter();
    }

    private void OpenNotificationCenter()
    {
        if (_isClosing || IsDisposed || Disposing) return;
        if (_notificationDialog is { IsDisposed: false } existing)
        {
            existing.Activate();
            return;
        }

        var dialog = new NotificationCenterForm(_notificationCenter, CanOpenNotificationSource, _studentNotificationPreview)
        {
            TopMost = _studentNotificationPreview || TopMost,
            StartPosition = FormStartPosition.Manual,
        };
        var autoHidePause = _topDock?.SuspendAutoHide();
        _notificationDialog = dialog;
        dialog.OpenRequested += kind =>
        {
            if (!CanOpenNotificationSource(kind)) return;
            dialog.Close();
            if (kind == NotificationKind.Approval) _ = RunWorkflowAsync(PortalTaskKind.Approval);
            else if (kind == NotificationKind.FieldTrip) _ = RunWorkflowAsync(PortalTaskKind.FieldTripApplicationManagement);
            else if (kind == NotificationKind.Absence) _ = RunWorkflowAsync(PortalTaskKind.AbsenceReportManagement);
            else if (kind == NotificationKind.FieldTripReport) _ = RunWorkflowAsync(PortalTaskKind.FieldTripReportManagement);
        };
        dialog.Deactivate += (_, _) =>
        {
            // Keep the explicit simulation visible until an entry or close is clicked.
            if (_studentNotificationPreview) return;
            if ((Control.MouseButtons & MouseButtons.Left) != 0
                && _notificationsButton.RectangleToScreen(_notificationsButton.ClientRectangle).Contains(Cursor.Position))
                _notificationBellDismissedAt = Environment.TickCount64;
            dialog.Close();
        };
        dialog.FormClosed += (_, _) =>
        {
            if (ReferenceEquals(_notificationDialog, dialog)) _notificationDialog = null;
            autoHidePause?.Dispose();
            dialog.Dispose();
        };
        try
        {
            PositionNotificationCenter();
            dialog.Show(this);
            PositionNotificationCenter();
            if (_studentNotificationPreview)
            {
                dialog.BringToFront();
                dialog.Activate();
                NativeMethods.SetForegroundWindow(dialog.Handle);
            }
        }
        catch
        {
            _notificationDialog = null;
            autoHidePause?.Dispose();
            dialog.Dispose();
            throw;
        }
    }

    private void PositionNotificationCenter()
    {
        if (_notificationDialog is not { IsDisposed: false } dialog) return;
        var bell = _notificationsButton.RectangleToScreen(_notificationsButton.ClientRectangle);
        var area = Screen.FromRectangle(bell).WorkingArea;
        var gap = Math.Max(4, (int)Math.Round(5 * DeviceDpi / 96f));
        var x = Math.Clamp(bell.Right - dialog.Width, area.Left, Math.Max(area.Left, area.Right - dialog.Width));
        var y = bell.Bottom + gap;
        if (y + dialog.Height > area.Bottom) y = bell.Top - dialog.Height - gap;
        y = Math.Clamp(y, area.Top, Math.Max(area.Top, area.Bottom - dialog.Height));
        dialog.Location = new Point(x, y);
    }

    private void RefreshNotificationSourceStatus() => _statusTip.SetToolTip(_notificationsButton,
        $"알림 · 미확인 {_notificationCenter.UnreadCount:N0}건"
        + "\n" + _fieldTripReportStatus
        + (_notificationCenter.HasPersistenceError ? "\n알림 기록을 저장하지 못했습니다." : string.Empty));

    private void CloseNotificationCenter() => _notificationDialog?.Close();

    private void DisposeNotifications()
    {
        _notificationCenter.Changed -= OnNotificationsChanged;
        CloseNotificationCenter();
        _notificationMenuItem.Dispose();
    }
}
