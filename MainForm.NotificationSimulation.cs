namespace BrowserThumbnailPrototype;

public sealed partial class MainForm
{
    private readonly bool _studentNotificationPreview;

    private static NotificationCenter CreateNotificationCenter(bool closeToTray, bool studentNotificationPreview)
    {
        // Every explicit simulation has its own disposable history. Never load or modify
        // the installed app's real history or the ordinary local preview's deduplication keys.
        var path = studentNotificationPreview
            ? Path.Combine(Path.GetTempPath(), "OneClickPortal", "student-notification-preview-" + Guid.NewGuid().ToString("N"), "notifications.json")
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OneClickPortal", closeToTray ? "notifications.json" : "notifications-preview.json");
        return new NotificationCenter(path);
    }

    private void InitializeStudentNotificationPreview()
    {
        Text = "원클릭 업무포털 · 모의 알림 테스트";
        // Keep this explicitly requested test easy to recover from the taskbar.
        ShowInTaskbar = true;
        Shown += async (_, _) =>
        {
            using var autoHidePause = _topDock?.SuspendAutoHide();
            try
            {
                await TryConnectStudentNotificationPreviewAsync();
            }
            catch (Exception exception)
            {
                AppLogger.Error("NotificationPreview", "모의 알림 테스트의 기존 브라우저 연결 확인 실패", exception);
            }
            if (_isClosing || IsDisposed || Disposing) return;

            const string scope = "student-notification-preview";
            var now = DateTimeOffset.Now;
            _notificationCenter.ObserveItems(NotificationKind.FieldTrip, [], scope, now);
            _notificationCenter.ObserveItems(NotificationKind.Absence, [], scope, now);
            _notificationCenter.ObserveItems(NotificationKind.FieldTrip,
                [new NotificationSourceItem("simulated-application", string.Empty)], scope, now);
            _notificationCenter.ObserveItems(NotificationKind.Absence,
                [new NotificationSourceItem("simulated-absence", string.Empty)], scope, now);
            _notificationCenter.ObservePendingFieldTripReports(
                [new NotificationSourceItem("simulated-report", string.Empty)], scope, now);

            SetStatus(IsBrowserConnected()
                ? "모의 알림 3건 · 알림을 누르면 실제 나이스 조회"
                : "모의 알림 3건 · 브라우저를 연결한 뒤 알림을 눌러 주세요");
            BringWidgetToFront();
            OpenNotificationCenter();
        };
    }

    private async Task TryConnectStudentNotificationPreviewAsync()
    {
        // Automatic connection is limited to one unambiguous official Nice page and
        // one matching browser window. Login and certificate choices remain with the user.
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        var office = EducationOfficeCatalog.GetByCode(AppPreferences.GetEducationOfficeCode());
        var browser = AppPreferences.GetLoginBrowser();
        var port = (await DevToolsDiscovery.InspectPortalPortsAsync(office, browser, cancellation.Token)).Port;
        if (port is null) return;
        var owner = BrowserEndpointOwner.FindListeningProcessId(port.Value);
        if (owner is null) return;
        var targets = await DevToolsDiscovery.GetTargetsAsync(port.Value, cancellation.Token);
        if (targets.Count(target => target.Type == "page"
            && Uri.TryCreate(target.Url, UriKind.Absolute, out var uri)
            && uri.Scheme == Uri.UriSchemeHttps
            && string.Equals(uri.Host, office.NiceDomain, StringComparison.OrdinalIgnoreCase)) != 1) return;

        RefreshBrowserWindows();
        var candidates = _browserWindows.Items.Cast<BrowserWindowItem>()
            .Where(window => string.Equals(window.ProcessName, BrowserSupport.GetProcessName(browser), StringComparison.OrdinalIgnoreCase)
                && IsWindowOwnedBy(window.Handle, owner.Value)
                && (window.Title.Contains("나이스", StringComparison.Ordinal)
                    || window.Title.Contains("업무포털", StringComparison.Ordinal)
                    || window.Title.Contains("에듀파인", StringComparison.Ordinal)))
            .ToArray();
        if (candidates.Length != 1) return;
        _browserWindows.SelectedItem = candidates[0];
        await ConnectSelectedBrowserAsync();
    }
}
