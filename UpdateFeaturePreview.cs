using System.Drawing.Drawing2D;

namespace BrowserThumbnailPrototype;

// Native release-note illustration; it never reads or opens a user's work screens.
internal sealed class UpdateFeaturePreview : Control
{
    private static readonly Color Ink = Color.FromArgb(34, 40, 50);
    private static readonly Color Muted = Color.FromArgb(92, 102, 116);
    private static readonly Color Blue = Color.FromArgb(42, 106, 190);
    private static readonly string IconFontFamily = GetIconFontFamily();

    public UpdateFeaturePreview()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        SetStyle(ControlStyles.Selectable, false);
        Size = new Size(532, 299);
        BackColor = Color.White;
        TabStop = false;
        AccessibleRole = AccessibleRole.Graphic;
        AccessibleName = "종 버튼으로 알림 확인";
        AccessibleDescription = "설정 옆 종 버튼에 미확인 알림이 있으면 빨간 점이 표시됩니다. "
            + "종을 누르면 알림 목록이 열리고, 확인한 기록도 보관됩니다. "
            + "현재 결재대기 건수 증가 알림을 지원합니다.";
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (Width < 2 || Height < 2) return;
        var graphics = e.Graphics;
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.Clear(BackColor);
        var scale = Math.Min(Width / 532f, Height / 299f);
        Rectangle R(float x, float y, float width, float height) => new(
            (int)Math.Round(x * scale), (int)Math.Round(y * scale),
            (int)Math.Round(width * scale), (int)Math.Round(height * scale));

        using (var background = new SolidBrush(Color.FromArgb(247, 249, 252)))
        using (var border = new Pen(Color.FromArgb(226, 232, 240), scale))
        using (var card = RoundedRectangle(new RectangleF(scale / 2, scale / 2,
            531 * scale, 298 * scale), 10 * scale))
        {
            graphics.FillPath(background, card);
            graphics.DrawPath(border, card);
        }
        DrawText(graphics, "설정 옆 종 버튼", R(24, 48, 192, 24),
            13 * scale, Ink, bold: true);

        // A compact toolbar keeps the bell's location and unread dot easy to recognize.
        DrawSurface(graphics, R(24, 82, 192, 56), Color.White, Color.FromArgb(221, 228, 237), 7 * scale);
        DrawText(graphics, "업무포털", R(36, 96, 96, 28), 13 * scale, Ink, bold: true);
        DrawSurface(graphics, R(144, 98, 26, 24), Color.FromArgb(229, 239, 255), Color.FromArgb(202, 220, 245), 4 * scale);
        DrawSurface(graphics, R(178, 98, 26, 24), Color.FromArgb(241, 244, 248), Color.FromArgb(220, 225, 232), 4 * scale);
        DrawSystemIcon(graphics, "\uEA8F", R(144, 98, 26, 24), scale);
        DrawSystemIcon(graphics, "\uE713", R(178, 98, 26, 24), scale);
        using (var unread = new SolidBrush(Color.FromArgb(218, 64, 77)))
            graphics.FillEllipse(unread, R(162, 99, 5, 5));

        using (var arrow = new Pen(Blue, 2 * scale))
        {
            arrow.StartCap = LineCap.Round;
            arrow.EndCap = LineCap.Round;
            graphics.DrawLine(arrow, 226 * scale, 110 * scale, 244 * scale, 110 * scale);
            graphics.DrawLine(arrow, 239 * scale, 105 * scale, 244 * scale, 110 * scale);
            graphics.DrawLine(arrow, 239 * scale, 115 * scale, 244 * scale, 110 * scale);
        }

        DrawSurface(graphics, R(256, 28, 252, 212), Color.White, Color.FromArgb(221, 228, 237), 8 * scale);
        DrawText(graphics, "알림", R(272, 40, 104, 26), 14 * scale, Ink, bold: true);
        DrawText(graphics, "모두 확인", R(390, 42, 102, 22), 11 * scale, Blue,
            alignment: TextFormatFlags.Right);

        DrawSurface(graphics, R(268, 78, 228, 68), Color.FromArgb(237, 245, 255), Color.FromArgb(218, 232, 250), 5 * scale);
        using (var unread = new SolidBrush(Blue))
            graphics.FillEllipse(unread, R(280, 96, 5, 5));
        DrawText(graphics, "결재대기 2건 증가", R(292, 88, 192, 24), 13 * scale, Ink, bold: true);
        DrawText(graphics, "방금 전", R(292, 116, 192, 18), 11 * scale, Muted);

        DrawSurface(graphics, R(268, 154, 228, 68), Color.White, Color.FromArgb(232, 236, 242), 5 * scale);
        DrawText(graphics, "결재대기 1건 증가", R(292, 164, 192, 24), 13 * scale, Ink);
        DrawText(graphics, "확인함 · 오늘", R(292, 192, 192, 18), 11 * scale, Muted);
        DrawText(graphics, "확인한 기록도 보관", R(256, 244, 252, 22), 11 * scale, Muted,
            alignment: TextFormatFlags.HorizontalCenter);
        DrawText(graphics, "현재 결재대기 건수 증가 알림을 지원합니다.",
            R(24, 275, 484, 16), 10 * scale, Muted,
            alignment: TextFormatFlags.HorizontalCenter);
    }

    private static void DrawSystemIcon(Graphics graphics, string glyph, Rectangle bounds, float scale)
    {
        using var font = new Font(IconFontFamily, 16 * scale, FontStyle.Regular, GraphicsUnit.Pixel);
        TextRenderer.DrawText(graphics, glyph, font, bounds, Color.FromArgb(74, 84, 100),
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
            TextFormatFlags.SingleLine | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
    }

    private static void DrawSurface(Graphics graphics, Rectangle bounds, Color background, Color borderColor, float radius)
    {
        using var path = RoundedRectangle(bounds, radius);
        using var fill = new SolidBrush(background);
        using var border = new Pen(borderColor);
        graphics.FillPath(fill, path);
        graphics.DrawPath(border, path);
    }

    private static void DrawText(Graphics graphics, string text, Rectangle bounds, float pixels, Color color,
        bool bold = false, TextFormatFlags alignment = TextFormatFlags.Left)
    {
        using var font = new Font("맑은 고딕", pixels, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel);
        TextRenderer.DrawText(graphics, text, font, bounds, color,
            alignment | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
    }

    private static string GetIconFontFamily()
    {
        using var font = new Font("Segoe Fluent Icons", 12F);
        return font.Name == "Segoe Fluent Icons" ? font.Name : "Segoe MDL2 Assets";
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
