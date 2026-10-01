using Microsoft.Win32;

namespace BrowserThumbnailPrototype;

// Keeps the existing portal form intact; only its position and visible region change.
internal sealed class TopDockController : IDisposable
{
    private readonly Form _portal;
    private readonly Form _handle;
    private readonly Button _button;
    private readonly System.Windows.Forms.Timer _animation = new() { Interval = 15 };
    private Point _anchor;
    private Point _dragStart;
    private Point _anchorStart;
    private bool _dragged;
    private bool _expanded;
    private bool _applying;
    private double _progress;
    private long _lastTick;
    private const string KeyPath = @"Software\OneClickPortal";
    public bool Enabled { get; private set; }

    public TopDockController(Form portal)
    {
        _portal = portal;
        _handle = new Form
        {
            Text = "업무포털 손잡이", FormBorderStyle = FormBorderStyle.None,
            ShowInTaskbar = false, TopMost = true, StartPosition = FormStartPosition.Manual,
            BackColor = Color.White, AutoScaleMode = AutoScaleMode.None,
        };
        _button = new Button
        {
            Dock = DockStyle.Fill, FlatStyle = FlatStyle.Flat, Text = "▼ 업무포털",
            BackColor = Color.White, ForeColor = Color.FromArgb(42,106,190),
            Font = new Font("맑은 고딕", 9), Cursor = Cursors.Hand,
            AccessibleName = "업무포털 펼치기 또는 접기. 드래그로 위치 이동",
        };
        _button.FlatAppearance.BorderColor = Color.FromArgb(218,225,235);
        _handle.Controls.Add(_button);
        _button.MouseDown += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            _dragStart = Cursor.Position; _anchorStart = _anchor; _dragged = false;
            _button.Capture = true;
        };
        _button.MouseMove += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            var delta = Cursor.Position.X - _dragStart.X;
            if (Math.Abs(delta) > SystemInformation.DragSize.Width) _dragged = true;
            if (!_dragged) return;
            _anchor = new Point(_anchorStart.X + delta, _anchorStart.Y);
            ApplyFrame();
        };
        _button.MouseUp += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            _button.Capture = false;
            if (_dragged) SaveAnchor();
        };
        _button.Click += (_, _) => { if (!_dragged) SetExpanded(!_expanded); };
        _handle.KeyDown += (_, e) => { if (e.KeyCode == Keys.Escape) SetExpanded(false); };
        _handle.KeyPreview = true;
        _handle.FormClosing += (_, e) => { if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; _portal.Hide(); } };
        _animation.Tick += (_, _) =>
        {
            var now = Environment.TickCount64;
            var step = (now - _lastTick) / 180d;
            _lastTick = now;
            _progress = Math.Clamp(_progress + (_expanded ? step : -step), 0, 1);
            ApplyFrame();
            if (_progress == (_expanded ? 1 : 0)) _animation.Stop();
        };
        _portal.VisibleChanged += OnVisibilityChanged;
        _portal.LocationChanged += OnGeometryChanged;
        _portal.SizeChanged += OnGeometryChanged;
        SystemEvents.DisplaySettingsChanged += OnDisplayChanged;
    }

    public void Enable()
    {
        using var key = Registry.CurrentUser.OpenSubKey(KeyPath);
        var screen = Screen.FromControl(_portal).Bounds;
        _anchor = key?.GetValue("TopDockLeft") is int x && key.GetValue("TopDockTop") is int y
            ? new Point(x, y) : new Point(screen.Left + (screen.Width - _portal.Width) / 2, screen.Top);
        Enabled = true;
        _portal.TopMost = true;
        _expanded = false; _progress = 0;
        _button.Text = "▼ 업무포털";
        ApplyFrame();
        if (_portal.Visible) _handle.Show();
    }

    public void Disable()
    {
        Enabled = false; _animation.Stop(); _handle.Hide();
        var old = _portal.Region; _portal.Region = PortalWindowShape.Create(_portal.Size, _portal.DeviceDpi); old?.Dispose();
        var area = Screen.FromPoint(_anchor).WorkingArea;
        _portal.Location = new Point(Math.Clamp(_anchor.X, area.Left, Math.Max(area.Left,area.Right-_portal.Width)), area.Top + 20);
        _portal.TopMost = AppPreferences.IsAlwaysOnTopEnabled();
    }

    public void SetExpanded(bool expanded)
    {
        if (!Enabled || !_portal.Enabled) return;
        _expanded = expanded;
        _button.Text = expanded ? "▲ 접기" : "▼ 업무포털";
        _lastTick = Environment.TickCount64;
        _animation.Start();
    }

    public void Reposition() { if (Enabled) ApplyFrame(); }

    private void ApplyFrame()
    {
        if (!Enabled || _applying || _portal.IsDisposed) return;
        _applying = true;
        try
        {
            var bounds = Screen.FromPoint(_anchor).Bounds;
            _anchor = new Point(Math.Clamp(_anchor.X, bounds.Left, Math.Max(bounds.Left,bounds.Right-_portal.Width)),bounds.Top);
            var shown = (int)Math.Round(_portal.Height * (1 - Math.Pow(1 - _progress, 3)));
            _portal.Location = new Point(_anchor.X, bounds.Top - _portal.Height + shown);
            // Clip the hidden portion so it cannot appear on a monitor above this one.
            var old = _portal.Region;
            var shape = PortalWindowShape.Create(_portal.Size, _portal.DeviceDpi);
            shape.Intersect(new Rectangle(0, _portal.Height-shown, _portal.Width, shown));
            _portal.Region = shape;
            old?.Dispose();
            var scale = _portal.DeviceDpi / 96f;
            _handle.Size = new Size((int)(132*scale), (int)(26*scale));
            _handle.Location = new Point(_anchor.X + (_portal.Width-_handle.Width)/2,bounds.Top+shown);
            _portal.TopMost = true;
        }
        finally { _applying = false; }
    }

    private void SaveAnchor()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(KeyPath);
            key.SetValue("TopDockLeft",_anchor.X); key.SetValue("TopDockTop",_anchor.Y);
        }
        catch(Exception ex) { AppLogger.Error("TopDock", "손잡이 위치 저장 실패", ex); }
    }
    private void OnGeometryChanged(object? sender, EventArgs e) => Reposition();
    private void OnVisibilityChanged(object? sender, EventArgs e)
    {
        if (!Enabled) return;
        if (_portal.Visible) { ApplyFrame(); _handle.Show(); }
        else { _animation.Stop(); _handle.Hide(); }
    }
    private void OnDisplayChanged(object? sender, EventArgs e)
    {
        if (_portal.IsDisposed || !_portal.IsHandleCreated) return;
        try { _portal.BeginInvoke(new Action(Reposition)); }
        catch (InvalidOperationException) { }
    }
    public void Dispose()
    {
        Enabled = false;
        SystemEvents.DisplaySettingsChanged -= OnDisplayChanged;
        _portal.VisibleChanged -= OnVisibilityChanged;
        _portal.LocationChanged -= OnGeometryChanged;
        _portal.SizeChanged -= OnGeometryChanged;
        _animation.Dispose(); _handle.Dispose();
    }
}
