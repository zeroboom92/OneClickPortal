using System.Drawing.Drawing2D;

namespace BrowserThumbnailPrototype;

// Draw at the current control size to keep the miniature desktop crisp at every DPI.
internal sealed class DisplayModePreview : Control
{
    private readonly PortalDisplayMode _mode;
    private bool _selected;
    private static readonly Color Accent = Color.FromArgb(49, 124, 213);

    public DisplayModePreview(PortalDisplayMode mode)
    {
        _mode = mode;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
            | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        TabStop = false;
        Cursor = Cursors.Hand;
        AccessibleRole = AccessibleRole.Graphic;
        BackColor = Color.White;
    }

    public bool Selected
    {
        get => _selected;
        set
        {
            _selected = value;
            BackColor = value ? Color.FromArgb(237, 245, 255) : Color.White;
            Invalidate();
            Parent?.Invalidate();
        }
    }

    public static void DrawCard(Graphics g, RectangleF bounds, bool selected)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using var background = new SolidBrush(selected ? Color.FromArgb(237, 245, 255) : Color.White);
        using var outline = new Pen(selected ? Accent : Color.FromArgb(213, 222, 233), selected ? 2 : 1);
        using var card = RoundedRectangle(bounds, 8);
        g.FillPath(background, card);
        g.DrawPath(outline, card);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        var state = g.Save();
        try
        {
            g.ScaleTransform(Width / 160f, Height / 92f);
            g.SmoothingMode = SmoothingMode.AntiAlias;

            using var frame = new SolidBrush(Color.FromArgb(93, 109, 131));
            using var desktop = new SolidBrush(Color.FromArgb(224, 235, 248));
            using var white = new SolidBrush(Color.White);
            using var light = new SolidBrush(Color.FromArgb(241, 244, 248));
            using var blue = new SolidBrush(Accent);
            using var muted = new SolidBrush(Color.FromArgb(184, 201, 222));
            using var screen = RoundedRectangle(new RectangleF(10, 10, 140, 72), 4);
            g.FillPath(frame, screen);
            g.FillRectangle(desktop, 13, 13, 134, 65);
            g.FillRectangle(frame, 73, 82, 14, 5);
            g.FillRectangle(frame, 58, 87, 44, 3);

            // A browser outline provides a shared visual reference for the portal's position.
            g.FillRectangle(white, 22, 26, 116, 43);
            g.FillRectangle(light, 22, 26, 116, 7);
            g.FillRectangle(muted, 28, 28, 19, 2);
            g.FillRectangle(light, 29, 41, 27, 21);
            g.FillRectangle(muted, 63, 41, 57, 3);
            g.FillRectangle(light, 63, 48, 65, 3);
            g.FillRectangle(light, 63, 55, 46, 3);
            g.FillRectangle(frame, 13, 74, 134, 4);
            g.FillRectangle(desktop, 17, 75, 3, 2);
            g.FillRectangle(desktop, 23, 75, 3, 2);

            if (_mode == PortalDisplayMode.TopDock)
            {
                DrawToolbar(g, new RectangleF(18, 13, 124, 12), twoRows: false);
                g.FillRectangle(blue, 61, 25, 38, 9);
                using var chevron = new Pen(Color.White, 1.3f);
                g.DrawLines(chevron, new[] { new PointF(76, 28), new PointF(80, 31), new PointF(84, 28) });
                using var arrow = new Pen(Accent, 1.8f) { EndCap = LineCap.ArrowAnchor };
                g.DrawLine(arrow, 80, 37, 80, 49);
                DrawCursor(g, 91, 29);
            }
            else
            {
                DrawToolbar(g, new RectangleF(59, 49, 81, 22), twoRows: true);
                using var arrow = new Pen(Accent, 1.5f) { StartCap = LineCap.ArrowAnchor, EndCap = LineCap.ArrowAnchor };
                g.DrawLine(arrow, 38, 54, 53, 54);
                g.DrawLine(arrow, 45.5f, 47, 45.5f, 62);
                DrawCursor(g, 67, 54);
            }
        }
        finally { g.Restore(state); }
    }

    private static void DrawToolbar(Graphics g, RectangleF bounds, bool twoRows)
    {
        using var shadow = new SolidBrush(Color.FromArgb(100, 133, 164));
        using var white = new SolidBrush(Color.White);
        using var border = new Pen(Color.FromArgb(137, 163, 195));
        using var blue = new SolidBrush(Color.FromArgb(125, 169, 255));
        using var green = new SolidBrush(Color.FromArgb(229, 239, 201));
        using var gray = new SolidBrush(Color.FromArgb(232, 237, 244));
        using var text = new SolidBrush(Color.FromArgb(55, 72, 96));
        g.FillRectangle(shadow, bounds.X + 1, bounds.Y + 1, bounds.Width, bounds.Height);
        g.FillRectangle(white, bounds);
        g.DrawRectangle(border, bounds.X, bounds.Y, bounds.Width, bounds.Height);
        var rowHeight = twoRows ? 8 : 7;
        var x = bounds.Left + 3;
        var y = bounds.Top + 2;
        g.FillRectangle(blue, x, y, twoRows ? 24 : 18, rowHeight);
        x += twoRows ? 27 : 21;
        for (var i = 0; i < (twoRows ? 3 : 6); i++)
        {
            var width = twoRows ? 14 : 15;
            g.FillRectangle(i == 3 ? green : gray, x, y, width, rowHeight);
            g.FillRectangle(text, x + 3, y + 3, width - 6, 1);
            x += width + 1;
        }
        if (twoRows)
        {
            y += 10;
            g.FillRectangle(green, bounds.Left + 3, y, 24, 8);
            for (var i = 0; i < 3; i++)
            {
                x = bounds.Left + 30 + i * 15;
                g.FillRectangle(gray, x, y, 14, 8);
                g.FillRectangle(text, x + 3, y + 3, 8, 1);
            }
        }
    }

    private static void DrawCursor(Graphics g, float x, float y)
    {
        var points = new[] { new PointF(x, y), new PointF(x + 1, y + 10), new PointF(x + 4, y + 7), new PointF(x + 7, y + 7) };
        using var fill = new SolidBrush(Color.White);
        using var border = new Pen(Color.FromArgb(45, 64, 90), 1);
        g.FillPolygon(fill, points);
        g.DrawPolygon(border, points);
    }

    private static GraphicsPath RoundedRectangle(RectangleF bounds, float radius)
    {
        var path = new GraphicsPath();
        var diameter = radius * 2;
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}
