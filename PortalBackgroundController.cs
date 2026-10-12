using System.Runtime.InteropServices;

namespace BrowserThumbnailPrototype;

// Keep native buttons/text fully opaque; only the separate white surface uses alpha.
internal sealed class PortalBackgroundController : IDisposable
{
    private readonly Form _portal;
    private readonly Func<bool> _isDocked;
    private readonly BackgroundSurface _surface = new();
    private bool _synchronizing;
    private bool _disposed;
    private int _opacityPercent = 100;

    public PortalBackgroundController(Form portal, Func<bool> isDocked)
    {
        _portal = portal;
        _isDocked = isDocked;
        _portal.LocationChanged += OnChanged;
        _portal.SizeChanged += OnChanged;
        _portal.VisibleChanged += OnChanged;
        _portal.Activated += OnChanged;
        _portal.HandleCreated += OnChanged;
        _portal.HandleDestroyed += OnHandleDestroyed;
        _surface.MouseDown += (_, e) =>
        {
            // Preserve dragging from the visible background in floating mode.
            if (e.Button != MouseButtons.Left || _isDocked() || !_portal.Enabled) return;
            ReleaseCapture();
            SendMessage(_portal.Handle, 0x00A1, new IntPtr(2), IntPtr.Zero); // WM_NCLBUTTONDOWN / HTCAPTION
        };
    }

    public void SetOpacityPercent(int percent)
    {
        _opacityPercent = Math.Clamp(percent, 0, 100);
        _surface.SetAlpha((byte)Math.Round(_opacityPercent * 255d / 100));
        Synchronize();
    }

    public void Synchronize()
    {
        if (_disposed || _synchronizing || _portal.IsDisposed || _portal.Disposing) return;
        _synchronizing = true;
        try
        {
            var hiddenHeight = _isDocked()
                ? Math.Clamp(Screen.FromPoint(new Point(_portal.Left, _portal.Bottom)).Bounds.Top - _portal.Top,
                    0, _portal.Height)
                : 0;
            if (!_portal.IsHandleCreated || !_portal.Visible || _portal.WindowState == FormWindowState.Minimized
                || _opacityPercent == 0 || hiddenHeight == _portal.Height)
            {
                _surface.Hide();
                return;
            }

            _surface.Bounds = _portal.Bounds;
            _surface.SetPassThrough(_isDocked());
            // WM_WINDOWPOSCHANGED can run before Form.TopMost's managed flag is
            // updated. Read the already-applied native style instead.
            var topMost = (GetWindowLong(_portal.Handle, -20) & 0x00000008) != 0;
            if (_surface.TopMost != topMost) _surface.TopMost = topMost;
            if (((GetWindowLong(_surface.Handle, -20) & 0x00000008) != 0) != topMost)
                SetWindowPos(_surface.Handle, new IntPtr(topMost ? -1 : -2), 0, 0, 0, 0,
                    0x0001 | 0x0002 | 0x0010);
            var old = _surface.Region;
            var shape = _isDocked() ? PortalWindowShape.Create(_portal.Size, _portal.DeviceDpi) : null;
            if (hiddenHeight > 0)
                shape!.Intersect(new Rectangle(0, hiddenHeight, _portal.Width, _portal.Height - hiddenHeight));
            _surface.Region = shape;
            old?.Dispose();
            if (!_surface.Visible) _surface.Show();
            // No owner: an owned window would be forced ABOVE its owner. Position this
            // non-activating surface immediately BELOW the portal, in the same topmost band.
            SetWindowPos(_surface.Handle, _portal.Handle, 0, 0, 0, 0,
                0x0001 | 0x0002 | 0x0010); // NOSIZE | NOMOVE | NOACTIVATE
        }
        finally { _synchronizing = false; }
    }

    private void OnChanged(object? sender, EventArgs e) => Synchronize();
    private void OnHandleDestroyed(object? sender, EventArgs e) => _surface.Hide();

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _portal.LocationChanged -= OnChanged;
        _portal.SizeChanged -= OnChanged;
        _portal.VisibleChanged -= OnChanged;
        _portal.Activated -= OnChanged;
        _portal.HandleCreated -= OnChanged;
        _portal.HandleDestroyed -= OnHandleDestroyed;
        _surface.Dispose();
    }

    private sealed class BackgroundSurface : Form
    {
        private byte _alpha = 255;
        private bool _passThrough = true;

        public BackgroundSurface()
        {
            Text = "업무포털 배경";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Color.White;
        }

        protected override bool ShowWithoutActivation => true;

        protected override CreateParams CreateParams
        {
            get
            {
                var parameters = base.CreateParams;
                // LAYERED | NOACTIVATE | TOOLWINDOW. In dock mode, TRANSPARENT also
                // passes background clicks to the browser below.
                parameters.ExStyle |= 0x00080000 | 0x08000000 | 0x00000080;
                if (_passThrough) parameters.ExStyle |= 0x00000020;
                return parameters;
            }
        }

        public void SetAlpha(byte alpha)
        {
            _alpha = alpha;
            if (IsHandleCreated) SetLayeredWindowAttributes(Handle, 0, _alpha, 0x00000002);
        }

        public void SetPassThrough(bool passThrough)
        {
            if (_passThrough == passThrough) return;
            _passThrough = passThrough;
            UpdateStyles();
            if (IsHandleCreated) SetLayeredWindowAttributes(Handle, 0, _alpha, 0x00000002);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            SetLayeredWindowAttributes(Handle, 0, _alpha, 0x00000002);
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetLayeredWindowAttributes(IntPtr window, uint colorKey, byte alpha, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr window, int index);
}
