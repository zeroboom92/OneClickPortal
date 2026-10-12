using Microsoft.Win32;

namespace BrowserThumbnailPrototype;

// Keeps the existing portal form intact; only its position and visible region change.
internal sealed class TopDockController : IDisposable, IMessageFilter
{
    private readonly Form _portal;
    private readonly Form _handle;
    private readonly Button _button;
    private readonly HashSet<Control> _dragControls = new();
    private readonly System.Windows.Forms.Timer _animation = new() { Interval = 15 };
    private readonly System.Windows.Forms.Timer _hover = new() { Interval = 50 };
    private Point _anchor;
    private Point _dragStart;
    private Point _anchorStart;
    private Rectangle _dragThreshold;
    private Control? _dragControl;
    private bool _dragged;
    private bool _hoverOpenSuppressed;
    private bool? _handleExpandedAtMouseDown;
    private bool _ignoreHandleClick;
    private bool _keyboardInput;
    private bool _expanded;
    private bool _applying;
    private bool _updatingAutoHide;
    private bool _inputFilterInstalled;
    private bool _disposed;
    private int _autoHideSuspensions;
    private double _progress;
    private long _lastTick;
    private long _autoCollapseAt;
    private const int AutoCollapseDelay = 2000;
    private const string KeyPath = @"Software\OneClickPortal";

    public bool Enabled { get; private set; }
    public bool IsExpanded => Enabled && _expanded;

    public TopDockController(Form portal)
    {
        _portal = portal;
        _handle = new DockHandleForm
        {
            Text = "업무포털 손잡이", FormBorderStyle = FormBorderStyle.None,
            ShowInTaskbar = false, TopMost = true, StartPosition = FormStartPosition.Manual,
            BackColor = Color.White, AutoScaleMode = AutoScaleMode.None, KeyPreview = true,
        };
        _button = new Button
        {
            Dock = DockStyle.Fill, FlatStyle = FlatStyle.Flat, Text = "▼ 업무포털",
            BackColor = Color.White, ForeColor = Color.FromArgb(42, 106, 190),
            Font = new Font("맑은 고딕", 9), Cursor = Cursors.Hand,
            AccessibleName = "마우스를 올리면 업무포털 펼치기. 클릭으로 접기. 드래그로 위치 이동",
        };
        _button.FlatAppearance.BorderColor = Color.FromArgb(218, 225, 235);
        _handle.Controls.Add(_button);
        RegisterDragControl(_button);
        _button.MouseEnter += (_, _) => TryExpandOnHover();
        _button.Click += (_, _) =>
        {
            var expandedAtPress = _handleExpandedAtMouseDown ?? _expanded;
            var ignoreClick = _ignoreHandleClick;
            _handleExpandedAtMouseDown = null;
            _ignoreHandleClick = false;
            if (_portal.Enabled && !_dragged && !ignoreClick) SetExpanded(!expandedAtPress);
        };
        _handle.KeyDown += (_, e) =>
        {
            if (_portal.Enabled && e.KeyCode == Keys.Escape) SetExpanded(false);
        };
        _handle.FormClosing += (_, e) =>
        {
            if (e.CloseReason != CloseReason.UserClosing) return;
            e.Cancel = true;
            _portal.Hide();
        };
        _animation.Tick += (_, _) =>
        {
            var now = Environment.TickCount64;
            var step = (now - _lastTick) / 180d;
            _lastTick = now;
            _progress = Math.Clamp(_progress + (_expanded ? step : -step), 0, 1);
            ApplyFrame();
            if (_progress != (_expanded ? 1 : 0)) return;
            _animation.Stop();
            UpdateAutoHide();
        };
        _hover.Tick += (_, _) => UpdateAutoHide();
        _portal.VisibleChanged += OnVisibilityChanged;
        _portal.LocationChanged += OnGeometryChanged;
        _portal.SizeChanged += OnGeometryChanged;
        SystemEvents.DisplaySettingsChanged += OnDisplayChanged;
    }

    public void Enable()
    {
        if (Enabled || _disposed) return;
        using var key = Registry.CurrentUser.OpenSubKey(KeyPath);
        var screen = Screen.FromControl(_portal).Bounds;
        _anchor = key?.GetValue("TopDockLeft") is int x && key.GetValue("TopDockTop") is int y
            ? new Point(x, y) : new Point(screen.Left + (screen.Width - _portal.Width) / 2, screen.Top);
        ResetInteraction();
        Enabled = true;
        _portal.TopMost = true;
        ApplyFrame();
        if (_portal.Visible) StartMonitoring();
    }

    public void Disable()
    {
        if (!Enabled) return;
        Enabled = false;
        StopMonitoring();
        ResetInteraction();
        _handle.Hide();
        var old = _portal.Region;
        _portal.Region = null;
        old?.Dispose();
        _portal.TopMost = AppPreferences.IsAlwaysOnTopEnabled();
    }

    // Registration survives display-mode changes; event handlers do nothing in floating mode.
    public void RegisterDragControl(Control control)
    {
        if (_disposed || control.IsDisposed || !_dragControls.Add(control)) return;
        control.MouseDown += OnDragMouseDown;
        control.MouseMove += OnDragMouseMove;
        control.MouseUp += OnDragMouseUp;
        control.MouseCaptureChanged += OnDragCaptureChanged;
        control.Disposed += OnDragControlDisposed;
    }

    // Keep scopes across Disable/Enable so a settings preview can switch display modes safely.
    public IDisposable SuspendAutoHide()
    {
        if (_disposed) return new AutoHideScope(null);
        _autoHideSuspensions++;
        _autoCollapseAt = 0;
        return new AutoHideScope(this);
    }

    public void SetExpanded(bool expanded)
    {
        if (!Enabled || _disposed) return;
        _expanded = expanded;
        _hoverOpenSuppressed = !expanded;
        _autoCollapseAt = 0;
        _button.Text = expanded ? "▲ 접기" : "▼ 업무포털";
        if (_portal.Visible)
        {
            _lastTick = Environment.TickCount64;
            _animation.Start();
            UpdateAutoHide();
            // Explicit keyboard collapse leaves focus on a visible, operable control.
            if (!expanded && _keyboardInput && _portal.ContainsFocus && _portal.Enabled)
            {
                _handle.Activate();
                _button.Focus();
            }
        }
        else
        {
            _progress = expanded ? 1 : 0;
        }
    }

    public void Reposition() { if (Enabled) ApplyFrame(); }

    private void ApplyFrame()
    {
        if (!Enabled || _applying || _portal.IsDisposed) return;
        _applying = true;
        try
        {
            var bounds = Screen.FromPoint(_anchor).Bounds;
            _anchor = new Point(Math.Clamp(_anchor.X, bounds.Left,
                Math.Max(bounds.Left, bounds.Right - _portal.Width)), bounds.Top);
            var shown = (int)Math.Round(_portal.Height * (1 - Math.Pow(1 - _progress, 3)));
            _portal.Location = new Point(_anchor.X, bounds.Top - _portal.Height + shown);
            // Clip the hidden portion so it cannot appear on a monitor above this one.
            var old = _portal.Region;
            var shape = PortalWindowShape.CreateForeground(_portal);
            using var outline = PortalWindowShape.Create(_portal.Size, _portal.DeviceDpi);
            shape.Intersect(outline);
            shape.Intersect(new Rectangle(0, _portal.Height - shown, _portal.Width, shown));
            _portal.Region = shape;
            old?.Dispose();
            var scale = _portal.DeviceDpi / 96f;
            _handle.Size = new Size((int)(132 * scale), (int)(26 * scale));
            _handle.Location = new Point(_anchor.X + (_portal.Width - _handle.Width) / 2, bounds.Top + shown);
            _portal.TopMost = true;
        }
        finally { _applying = false; }
        UpdateAutoHide();
    }

    private void UpdateAutoHide()
    {
        if (!Enabled || _disposed || _portal.IsDisposed || _updatingAutoHide) return;
        _updatingAutoHide = true;
        try
        {
            if (!_portal.Visible)
            {
                _autoCollapseAt = 0;
                _handle.Hide();
                return;
            }

            var hasFocus = _portal.ContainsFocus || _handle.ContainsFocus;
            if (!hasFocus) _keyboardInput = false;
            var pointer = Cursor.Position;
            if (!_expanded)
            {
                _autoCollapseAt = 0;
                // Keep a discoverable way to reopen the menu, even with the pointer elsewhere.
                SetHandleVisible(true);
                // Wait for the closing animation before releasing a manual-close guard:
                // the handle moves under the pointer as it returns to the top edge.
                if (!_animation.Enabled && !_handle.Bounds.Contains(pointer))
                    _hoverOpenSuppressed = false;
                TryExpandOnHover();
                return;
            }

            SetHandleVisible(true);
            // Bounds intentionally include transparent gaps between the foreground controls.
            var inMenu = _portal.Bounds.Contains(pointer) || _handle.Bounds.Contains(pointer);
            if (_animation.Enabled || inMenu || IsAutoHidePaused(hasFocus))
            {
                _autoCollapseAt = 0;
                return;
            }

            var now = Environment.TickCount64;
            if (_autoCollapseAt == 0) _autoCollapseAt = now + AutoCollapseDelay;
            else if (now >= _autoCollapseAt) SetExpanded(false);
        }
        finally { _updatingAutoHide = false; }
    }

    private bool IsAutoHidePaused(bool hasFocus)
    {
        if (_autoHideSuspensions > 0 || !_portal.Enabled || _dragControl is not null
            || (_keyboardInput && hasFocus)) return true;
        if (Application.OpenForms.Cast<Form>().Any(form => form.Visible && form.Modal)) return true;
        return Descendants(_portal).Any(control => control.Capture
            || control is ComboBox { DroppedDown: true });
    }

    private void TryExpandOnHover()
    {
        if (!Enabled || _disposed || _expanded || _hoverOpenSuppressed || _animation.Enabled
            || !_portal.Visible || !_portal.Enabled || !_handle.Visible || _autoHideSuspensions > 0
            || _dragControl is not null || Control.MouseButtons != MouseButtons.None
            || !_handle.Bounds.Contains(Cursor.Position)
            || Application.OpenForms.Cast<Form>().Any(form => form.Visible && form.Modal)) return;
        _keyboardInput = false;
        SetExpanded(true);
    }

    private static IEnumerable<Control> Descendants(Control parent)
    {
        foreach (Control child in parent.Controls)
        {
            if (child.IsDisposed) continue;
            yield return child;
            foreach (var descendant in Descendants(child)) yield return descendant;
        }
    }

    private void SetHandleVisible(bool visible)
    {
        if (visible && !_handle.Visible) _handle.Show();
        else if (!visible && _handle.Visible) _handle.Hide();
    }

    bool IMessageFilter.PreFilterMessage(ref Message message)
    {
        if (!Enabled || _disposed || !_portal.Visible) return false;
        var control = Control.FromChildHandle(message.HWnd);
        var form = control?.FindForm();
        if (form != _portal && form != _handle && !_portal.ContainsFocus && !_handle.ContainsFocus)
            return false;
        if (message.Msg is 0x0100 or 0x0104) // WM_KEYDOWN / WM_SYSKEYDOWN, including Tab/navigation.
        {
            if (_dragControl is null)
            {
                _keyboardInput = true;
                _dragged = false;
                _handleExpandedAtMouseDown = null;
                _ignoreHandleClick = false;
            }
            _autoCollapseAt = 0;
        }
        else if (message.Msg is 0x0201 or 0x0204 or 0x0207 or 0x020B or 0x00A1 or 0x00A4)
        {
            // A mouse-focused button must not pin the menu after the pointer leaves.
            _keyboardInput = false;
            _autoCollapseAt = 0;
        }
        return false;
    }

    private void OnDragMouseDown(object? sender, MouseEventArgs e)
    {
        if (!Enabled || !_portal.Visible || !_portal.Enabled || e.Button != MouseButtons.Left
            || sender is not Control control) return;
        _dragStart = Cursor.Position;
        _anchorStart = _anchor;
        var dragSize = SystemInformation.DragSize;
        _dragThreshold = new Rectangle(_dragStart.X - dragSize.Width / 2,
            _dragStart.Y - dragSize.Height / 2, dragSize.Width, dragSize.Height);
        _dragged = false;
        if (control == _button)
        {
            _handleExpandedAtMouseDown = _expanded;
            // Hover already starts opening before a quick mouse click can arrive.
            // That same gesture must not immediately close the menu again.
            _ignoreHandleClick = _expanded && _animation.Enabled;
        }
        _keyboardInput = false;
        _autoCollapseAt = 0;
        _dragControl = control;
        control.Capture = true;
        UpdateAutoHide();
    }

    private void OnDragMouseMove(object? sender, MouseEventArgs e)
    {
        if (!Enabled || sender != _dragControl || (e.Button & MouseButtons.Left) == 0) return;
        var pointer = Cursor.Position;
        if (!_dragThreshold.Contains(pointer)) _dragged = true;
        if (!_dragged) return;
        _anchor = new Point(_anchorStart.X + pointer.X - _dragStart.X, _anchorStart.Y);
        ApplyFrame();
    }

    private void OnDragMouseUp(object? sender, MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left && sender == _dragControl) EndDrag(true);
    }

    private void OnDragCaptureChanged(object? sender, EventArgs e)
    {
        if (sender == _dragControl && _dragControl is { Capture: false }) EndDrag(true);
    }

    private void EndDrag(bool save)
    {
        var control = _dragControl;
        _dragControl = null;
        if (control is { IsDisposed: false, Capture: true }) control.Capture = false;
        if (_dragged)
        {
            _hoverOpenSuppressed = true;
            _handleExpandedAtMouseDown = null;
            _ignoreHandleClick = false;
        }
        if (save && _dragged) SaveAnchor();
        _autoCollapseAt = 0;
        UpdateAutoHide();
    }

    private void OnDragControlDisposed(object? sender, EventArgs e)
    {
        if (sender is not Control control) return;
        if (control == _dragControl) EndDrag(false);
        UnregisterDragControl(control);
    }

    private void UnregisterDragControl(Control control)
    {
        _dragControls.Remove(control);
        control.MouseDown -= OnDragMouseDown;
        control.MouseMove -= OnDragMouseMove;
        control.MouseUp -= OnDragMouseUp;
        control.MouseCaptureChanged -= OnDragCaptureChanged;
        control.Disposed -= OnDragControlDisposed;
    }

    private void ResumeAutoHide()
    {
        if (_disposed) return;
        _autoHideSuspensions = Math.Max(0, _autoHideSuspensions - 1);
        _autoCollapseAt = 0;
        UpdateAutoHide();
    }

    private void StartMonitoring()
    {
        _hover.Start();
        if (_inputFilterInstalled) return;
        Application.AddMessageFilter(this);
        _inputFilterInstalled = true;
    }

    private void StopMonitoring()
    {
        _animation.Stop();
        _hover.Stop();
        if (!_inputFilterInstalled) return;
        Application.RemoveMessageFilter(this);
        _inputFilterInstalled = false;
    }

    private void ResetInteraction()
    {
        EndDrag(false);
        _dragged = false;
        _hoverOpenSuppressed = false;
        _handleExpandedAtMouseDown = null;
        _ignoreHandleClick = false;
        _keyboardInput = false;
        _autoCollapseAt = 0;
        _expanded = false;
        _progress = 0;
        _button.Text = "▼ 업무포털";
    }

    private void SaveAnchor()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(KeyPath);
            key.SetValue("TopDockLeft", _anchor.X);
            key.SetValue("TopDockTop", _anchor.Y);
        }
        catch (Exception ex) { AppLogger.Error("TopDock", "손잡이 위치 저장 실패", ex); }
    }

    private void OnGeometryChanged(object? sender, EventArgs e) => Reposition();

    private void OnVisibilityChanged(object? sender, EventArgs e)
    {
        if (!Enabled) return;
        if (_portal.Visible)
        {
            ApplyFrame();
            StartMonitoring();
        }
        else
        {
            StopMonitoring();
            ResetInteraction();
            _handle.Hide();
        }
    }

    private void OnDisplayChanged(object? sender, EventArgs e)
    {
        if (_disposed || _portal.IsDisposed || !_portal.IsHandleCreated) return;
        try { _portal.BeginInvoke(new Action(Reposition)); }
        catch (InvalidOperationException) { }
    }

    public void Dispose()
    {
        if (_disposed) return;
        Enabled = false;
        _disposed = true;
        StopMonitoring();
        EndDrag(false);
        _autoHideSuspensions = 0;
        SystemEvents.DisplaySettingsChanged -= OnDisplayChanged;
        _portal.VisibleChanged -= OnVisibilityChanged;
        _portal.LocationChanged -= OnGeometryChanged;
        _portal.SizeChanged -= OnGeometryChanged;
        foreach (var control in _dragControls.ToArray()) UnregisterDragControl(control);
        _animation.Dispose();
        _hover.Dispose();
        _handle.Dispose();
    }

    private sealed class AutoHideScope(TopDockController? owner) : IDisposable
    {
        private TopDockController? _owner = owner;
        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.ResumeAutoHide();
    }

    private sealed class DockHandleForm : Form
    {
        // Revealing the handle on hover must leave the browser's focus intact.
        protected override bool ShowWithoutActivation => true;
    }
}
