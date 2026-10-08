using System.Drawing.Drawing2D;

namespace BrowserThumbnailPrototype;

// A separate circular control overlaps the lower-right corner without widening the button gap.
internal sealed class TaskCountBadge : Control
{
    private int? _badgeCount;

    public int? BadgeCount
    {
        get => _badgeCount;
        set
        {
            var count = value is >= 0 ? value : null;
            if (_badgeCount == count) return;
            _badgeCount = count;
            Invalidate();
        }
    }

    public TaskCountBadge()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        SetStyle(ControlStyles.Selectable, false);
        TabStop = false;
        Cursor = Cursors.Hand;
        AccessibleRole = AccessibleRole.PushButton;
        BackColor = Color.White;
        Visible = false;
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        using var path = new GraphicsPath();
        path.AddEllipse(ClientRectangle);
        var previous = Region;
        Region = new Region(path);
        previous?.Dispose();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        if (_badgeCount is not int count || Width < 2 || Height < 2) return;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        e.Graphics.Clear(Color.White);
        var inset = DeviceDpi / 96f;
        using var fill = new SolidBrush(Color.FromArgb(220, 38, 38));
        e.Graphics.FillEllipse(fill, inset / 2, inset / 2, Width - inset, Height - inset);
        using var font = new Font("Segoe UI", count > 99 ? 5.5F : count > 9 ? 6.5F : 7.5F, FontStyle.Bold);
        TextRenderer.DrawText(e.Graphics, count > 99 ? "99+" : count.ToString(), font,
            ClientRectangle, Color.White, TextFormatFlags.HorizontalCenter |
            TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
    }
}
