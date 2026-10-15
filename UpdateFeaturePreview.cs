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
        AccessibleName = "교외체험학습 보고서 미상신 알림";
        AccessibleDescription = "아침에 연결하면 교외체험학습 미상신 보고서를 먼저 확인합니다. "
            + "미확인 알림이 있으면 설정 옆 종 버튼에 빨간 점이 표시됩니다. "
            + "종을 눌러 알림 목록을 열고 보고서 알림을 누르면 보고서관리로 이동해 조회합니다. "
            + "이후 10분마다 확인하며, 같은 보고서는 중복으로 알리지 않습니다.";
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
        DrawText(graphics, "아침 연결 직후 먼저 확인", R(24, 18, 484, 28),
            16 * scale, Ink, bold: true);
        DrawText(graphics, "설정 옆 종 버튼", R(24, 68, 192, 22),
            12 * scale, Muted);

        // A compact toolbar keeps the bell's location and unread dot easy to recognize.
        DrawSurface(graphics, R(24, 96, 192, 56), Color.White, Color.FromArgb(221, 228, 237), 7 * scale);
        DrawText(graphics, "업무포털", R(36, 110, 96, 28), 13 * scale, Ink, bold: true);
        DrawSurface(graphics, R(144, 112, 26, 24), Color.FromArgb(229, 239, 255), Color.FromArgb(202, 220, 245), 4 * scale);
        DrawSurface(graphics, R(178, 112, 26, 24), Color.FromArgb(241, 244, 248), Color.FromArgb(220, 225, 232), 4 * scale);
        DrawSystemIcon(graphics, "\uEA8F", R(144, 112, 26, 24), scale);
        DrawSystemIcon(graphics, "\uE713", R(178, 112, 26, 24), scale);
        using (var unread = new SolidBrush(Color.FromArgb(218, 64, 77)))
            graphics.FillEllipse(unread, R(162, 113, 5, 5));
        DrawText(graphics, "빨간 점이 뜨면 알림 확인", R(24, 158, 192, 20),
            11 * scale, Muted);

        using (var arrow = new Pen(Blue, 2 * scale))
        {
            arrow.StartCap = LineCap.Round;
            arrow.EndCap = LineCap.Round;
            graphics.DrawLine(arrow, 226 * scale, 124 * scale, 244 * scale, 124 * scale);
            graphics.DrawLine(arrow, 239 * scale, 119 * scale, 244 * scale, 124 * scale);
            graphics.DrawLine(arrow, 239 * scale, 129 * scale, 244 * scale, 124 * scale);
            graphics.DrawLine(arrow, 382 * scale, 188 * scale, 382 * scale, 198 * scale);
            graphics.DrawLine(arrow, 377 * scale, 193 * scale, 382 * scale, 198 * scale);
            graphics.DrawLine(arrow, 387 * scale, 193 * scale, 382 * scale, 198 * scale);
        }

        DrawSurface(graphics, R(256, 64, 252, 118), Color.White, Color.FromArgb(221, 228, 237), 8 * scale);
        DrawText(graphics, "알림", R(272, 73, 104, 24), 14 * scale, Ink, bold: true);
        DrawText(graphics, "모두 확인", R(390, 74, 102, 22), 11 * scale, Blue,
            alignment: TextFormatFlags.Right);

        DrawSurface(graphics, R(268, 103, 228, 67), Color.FromArgb(237, 245, 255), Color.FromArgb(218, 232, 250), 5 * scale);
        using (var unread = new SolidBrush(Blue))
            graphics.FillEllipse(unread, R(280, 120, 5, 5));
        DrawText(graphics, "교외체험학습 보고서", R(292, 109, 192, 24), 13 * scale, Ink, bold: true);
        DrawText(graphics, "미상신 1건", R(292, 138, 192, 22), 12 * scale, Blue, bold: true);

        DrawSurface(graphics, R(24, 207, 484, 40), Color.FromArgb(237, 245, 255),
            Color.FromArgb(202, 220, 245), 6 * scale);
        DrawText(graphics, "알림을 누르면 보고서관리로 이동 · 조회", R(36, 213, 460, 28),
            14 * scale, Blue, bold: true,
            alignment: TextFormatFlags.HorizontalCenter);
        DrawText(graphics, "이후 10분마다 확인 · 같은 보고서는 중복 알림 없음",
            R(24, 265, 484, 18), 11 * scale, Muted,
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
