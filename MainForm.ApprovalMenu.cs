using System.ComponentModel;

namespace BrowserThumbnailPrototype;

public sealed partial class MainForm
{
    private ContextMenuStrip? _approvalChoiceMenu;
    private ToolStripMenuItem? _edufineApprovalMenuItem;
    private ToolStripMenuItem? _niceApprovalMenuItem;
    private IDisposable? _approvalMenuAutoHidePause;
    private int? _niceApprovalMenuCount;
    private DateTimeOffset? _niceApprovalMenuReadAt;
    private string _approvalBadgeDescription = "브라우저 연결 후 결재대기 건수를 확인합니다.";
    private bool _approvalMenuInitialized;
    private bool _approvalMenuDisposed;
    private long _approvalMenuDismissedAt;

    private void InitializeApprovalMenu()
    {
        if (_approvalMenuInitialized || _approvalMenuDisposed) return;
        _approvalMenuInitialized = true;
        VisibleChanged += (_, _) => { if (!Visible) CloseApprovalMenu(); };
        LocationChanged += (_, _) => CloseApprovalMenu();
    }

    private bool CanRequestApprovalAction() => !_approvalMenuDisposed && !_isClosing
        && !IsDisposed && !Disposing && !_workflowRunning && IsBrowserConnected()
        && _approvalButton is { IsDisposed: false, Enabled: true };

    private async Task RequestApprovalActionAsync()
    {
        if (!CanRequestApprovalAction()) { CloseApprovalMenu(); return; }
        if (!AppPreferences.IsNiceApprovalMenuEnabled())
        {
            CloseApprovalMenu();
            await RunWorkflowAsync(PortalTaskKind.Approval);
            return;
        }
        // Native menus close on the mouse-down before a toolbar Click arrives.
        // Treat a second click on the same button as a toggle, rather than reopening.
        var dismissedAt = _approvalMenuDismissedAt;
        _approvalMenuDismissedAt = 0;
        if (dismissedAt != 0 && Environment.TickCount64 - dismissedAt < 300) return;
        if (_approvalChoiceMenu?.Visible == true) { CloseApprovalMenu(); return; }
        EnsureApprovalMenu();
        RefreshApprovalMenuItems();
        if (_approvalChoiceMenu is not { IsDisposed: false } menu || _approvalButton is null) return;

        _approvalMenuAutoHidePause?.Dispose();
        _approvalMenuAutoHidePause = _topDock?.SuspendAutoHide();
        try
        {
            var buttonBounds = _approvalButton.RectangleToScreen(_approvalButton.ClientRectangle);
            var area = Screen.FromRectangle(buttonBounds).WorkingArea;
            var size = menu.GetPreferredSize(Size.Empty);
            var gap = Math.Max(2, (int)Math.Round(2 * DeviceDpi / 96f));
            var x = Math.Clamp(buttonBounds.Left, area.Left, Math.Max(area.Left, area.Right - size.Width));
            var y = buttonBounds.Bottom + gap;
            if (y + size.Height > area.Bottom) y = buttonBounds.Top - size.Height - gap;
            y = Math.Clamp(y, area.Top, Math.Max(area.Top, area.Bottom - size.Height));
            menu.Show(_approvalButton, _approvalButton.PointToClient(new Point(x, y)));
            if (!menu.Visible) ReleaseApprovalMenuAutoHidePause();
        }
        catch
        {
            ReleaseApprovalMenuAutoHidePause();
            throw;
        }
    }

    private void EnsureApprovalMenu()
    {
        if (_approvalChoiceMenu is { IsDisposed: false } || _approvalMenuDisposed) return;
        var menu = new ContextMenuStrip
        {
            Name = "ApprovalSystemMenu",
            AccessibleName = "결재대기 시스템 선택",
            ShowImageMargin = false,
            ShowCheckMargin = false,
            AutoClose = true,
            Font = Font,
        };
        var edufine = new ToolStripMenuItem("에듀파인 결재대기") { Name = "EdufineApprovalMenuItem" };
        var nice = new ToolStripMenuItem("나이스 결재대기") { Name = "NiceApprovalMenuItem" };
        edufine.Click += async (_, _) => await SelectApprovalSystemAsync(PortalTaskKind.Approval);
        nice.Click += async (_, _) => await SelectApprovalSystemAsync(PortalTaskKind.NiceApproval);
        menu.Items.AddRange([edufine, nice]);
        menu.Opening += (_, e) => ValidateApprovalMenuOpening(e);
        menu.Closed += (_, e) =>
        {
            if (e.CloseReason == ToolStripDropDownCloseReason.AppClicked
                && (Control.MouseButtons & MouseButtons.Left) != 0
                && _approvalButton is { IsDisposed: false } button
                && button.RectangleToScreen(button.ClientRectangle).Contains(Cursor.Position))
                _approvalMenuDismissedAt = Environment.TickCount64;
            ReleaseApprovalMenuAutoHidePause();
        };
        _approvalChoiceMenu = menu;
        _edufineApprovalMenuItem = edufine;
        _niceApprovalMenuItem = nice;
    }

    private void ValidateApprovalMenuOpening(CancelEventArgs e)
    {
        if (!CanRequestApprovalAction() || !AppPreferences.IsNiceApprovalMenuEnabled()) e.Cancel = true;
        RefreshApprovalMenuItems();
    }

    private async Task SelectApprovalSystemAsync(PortalTaskKind kind)
    {
        var permitted = CanRequestApprovalAction() && AppPreferences.IsNiceApprovalMenuEnabled();
        CloseApprovalMenu();
        if (!permitted) return;
        // Keep the ordinary workflow's manual re-login recovery for an expired system.
        // One expired system must not disable the other choice.
        await RunWorkflowAsync(kind);
    }

    private void SetNiceApprovalMenuCount(int? count)
    {
        _niceApprovalMenuCount = count is >= 0 ? count : null;
        _niceApprovalMenuReadAt = _niceApprovalMenuCount is null ? null : DateTimeOffset.UtcNow;
        RefreshApprovalActionPresentation();
    }

    private static string ApprovalMenuCaption(string name, int? count, DateTimeOffset? readAt,
        bool expired, DateTimeOffset now) => !expired && count is >= 0 && readAt is { } at
            && now >= at && now - at <= TimeSpan.FromMinutes(2)
                ? $"{name} [{count.Value:N0}건]" : name;

    private void RefreshApprovalMenuItems()
    {
        if (_approvalChoiceMenu is not { IsDisposed: false }) return;
        var now = DateTimeOffset.UtcNow;
        if (_edufineApprovalMenuItem is { } edufine)
        {
            edufine.Text = ApprovalMenuCaption("에듀파인 결재대기", _approvalBadge.BadgeCount,
                _approvalBadgeReadAt, _confirmedExpiredSystems.Contains("K-에듀파인"), now);
            edufine.AccessibleName = edufine.Text;
            edufine.Enabled = CanRequestApprovalAction();
        }
        if (_niceApprovalMenuItem is { } nice)
        {
            nice.Text = ApprovalMenuCaption("나이스 결재대기", _niceApprovalMenuCount,
                _niceApprovalMenuReadAt, _confirmedExpiredSystems.Contains("나이스"), now);
            nice.AccessibleName = nice.Text;
            nice.Enabled = CanRequestApprovalAction();
        }
    }

    private void RefreshApprovalActionPresentation()
    {
        if (_approvalButton is not { IsDisposed: false } button || _isClosing || IsDisposed || Disposing) return;
        var chooseSystem = AppPreferences.IsNiceApprovalMenuEnabled();
        var count = _approvalBadge.BadgeCount;
        button.AccessibleName = chooseSystem ? "결재 · 에듀파인 또는 나이스 선택"
            : count is int value ? $"결재 · 결재대기 {value:N0}건" : "결재";
        var description = chooseSystem ? "에듀파인 또는 나이스 결재대기를 선택합니다." : _approvalBadgeDescription;
        var tip = chooseSystem ? description : description + "\n클릭하면 결재대기 목록을 엽니다.";
        button.AccessibleDescription = description;
        _statusTip.SetToolTip(button, tip);
        _approvalBadge.AccessibleName = button.AccessibleName;
        _approvalBadge.AccessibleDescription = description;
        _statusTip.SetToolTip(_approvalBadge, tip);
        RefreshApprovalMenuItems();
        if (!chooseSystem || !CanRequestApprovalAction()) CloseApprovalMenu();
    }

    private void ReleaseApprovalMenuAutoHidePause()
    {
        var pause = _approvalMenuAutoHidePause;
        _approvalMenuAutoHidePause = null;
        pause?.Dispose();
    }

    private void CloseApprovalMenu()
    {
        if (_approvalChoiceMenu is { IsDisposed: false, Visible: true } menu) menu.Close();
        ReleaseApprovalMenuAutoHidePause();
    }

    private void DisposeApprovalMenu()
    {
        if (_approvalMenuDisposed) return;
        _approvalMenuDisposed = true;
        CloseApprovalMenu();
        _approvalChoiceMenu?.Dispose();
        _approvalChoiceMenu = null;
        _edufineApprovalMenuItem = null;
        _niceApprovalMenuItem = null;
    }
}
