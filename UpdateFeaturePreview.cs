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
        AccessibleName = "접혀도 남아 있는 업무포털 펼침 버튼 안내";
        AccessibleDescription = "메뉴가 접히면 파란색 '▼ 업무포털' 버튼이 남습니다. "
            + "마우스를 올리거나 클릭하면 펼쳐지고, 상단의 '▲ 접기'를 누르면 메뉴만 접힙니다. "
            + "설정 옆 종에서 기존 알림을 확인하며, 프로그램 종료는 트레이 메뉴의 '완전히 종료'를 사용합니다. "
            + "알림 기능은 현재 테스트 중입니다. 현재는 화면의 결재대기 건수 증가를 알리며, 교외체험학습과 결석신고 알림은 아직 연결되지 않았습니다.";
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
        DrawText(graphics, "접혀도 펼침 버튼은 항상 보입니다", R(20, 12, 492, 24),
            14 * scale, Ink, bold: true);
        DrawText(graphics, "접힌 상태", R(20, 48, 232, 22), 13 * scale, Ink, bold: true);
        DrawText(graphics, "펼친 상태", R(280, 48, 232, 22), 13 * scale, Ink, bold: true);

        DrawSurface(graphics, R(20, 78, 232, 109), Color.White, Color.FromArgb(221, 228, 237), 6 * scale);
        DrawSurface(graphics, R(280, 78, 232, 109), Color.White, Color.FromArgb(221, 228, 237), 6 * scale);
        using (var screenEdge = new Pen(Color.FromArgb(221, 228, 237), scale))
        {
            graphics.DrawLine(screenEdge, 26 * scale, 89 * scale, 246 * scale, 89 * scale);
            graphics.DrawLine(screenEdge, 286 * scale, 89 * scale, 506 * scale, 89 * scale);
        }

        // The blue handle matches the real 104 x 32 px control at 96 DPI.
        DrawSurface(graphics, R(84, 89, 104, 32), Blue, Blue, 3 * scale);
        DrawText(graphics, "▼ 업무포털", R(84, 89, 104, 32), 12 * scale, Color.White,
            bold: true, alignment: TextFormatFlags.HorizontalCenter);
        DrawText(graphics, "올리거나 클릭하여 펼치기", R(30, 139, 212, 24), 11 * scale, Muted,
            alignment: TextFormatFlags.HorizontalCenter);

        // The bell remains beside settings; the former top-right X now folds the menu.
        DrawSurface(graphics, R(286, 92, 220, 28), Color.White, Color.FromArgb(221, 228, 237), 3 * scale);
        DrawTaskButton(graphics, R(292, 97, 76, 18), Color.FromArgb(229, 239, 255), "업무 메뉴", scale, Blue);
        DrawSurface(graphics, R(372, 94, 26, 24), Color.FromArgb(241, 244, 248), Color.FromArgb(220, 225, 232), 3 * scale);
        DrawSurface(graphics, R(402, 94, 26, 24), Color.FromArgb(241, 244, 248), Color.FromArgb(220, 225, 232), 3 * scale);
        DrawSystemIcon(graphics, "\uEA8F", R(372, 94, 26, 24), scale);
        DrawSystemIcon(graphics, "\uE713", R(402, 94, 26, 24), scale);
        using (var unread = new SolidBrush(Color.FromArgb(218, 64, 77)))
            graphics.FillEllipse(unread, R(390, 96, 4, 4));
        DrawTaskButton(graphics, R(432, 94, 68, 24), Color.FromArgb(229, 239, 255), "▲ 접기", scale, Blue);
        DrawSurface(graphics, R(344, 122, 104, 32), Blue, Blue, 3 * scale);
        DrawText(graphics, "▲ 접기", R(344, 122, 104, 32), 12 * scale, Color.White,
            bold: true, alignment: TextFormatFlags.HorizontalCenter);
        DrawText(graphics, "상단 ▲ 접기로 메뉴만 접기", R(290, 160, 212, 22), 11 * scale, Muted,
            alignment: TextFormatFlags.HorizontalCenter);

        DrawSurface(graphics, R(20, 202, 492, 68), Color.White, Color.FromArgb(221, 228, 237), 6 * scale);
        DrawText(graphics, "알림 확인", R(34, 210, 212, 22), 12 * scale, Ink, bold: true);
        DrawText(graphics, "설정 옆 종에서 확인", R(34, 235, 212, 22), 11 * scale, Muted);
        DrawText(graphics, "프로그램 종료", R(284, 210, 212, 22), 12 * scale, Ink, bold: true);
        DrawText(graphics, "트레이 → 완전히 종료", R(284, 235, 212, 22), 11 * scale, Muted);
        DrawText(graphics, "알림은 테스트 중이며, 교외체험학습·결석신고는 아직 연결되지 않았습니다.",
            R(20, 278, 492, 14), 10 * scale, Muted);
    }

    private static void DrawTaskButton(Graphics graphics, Rectangle bounds, Color color, string text, float scale,
        Color? textColor = null)
    {
        DrawSurface(graphics, bounds, color, Color.FromArgb(220, 225, 232), 3 * scale);
        DrawText(graphics, text, bounds, 11 * scale, textColor ?? Color.FromArgb(45, 52, 64),
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
