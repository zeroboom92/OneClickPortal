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
        AccessibleName = "작은 알림창과 이전 업데이트 보기 안내";
        AccessibleDescription = "설정 옆 종을 누르면 간단한 알림창이 열립니다. "
            + "미확인 알림은 점으로 표시하며 확인한 기록도 보관합니다. 이전 업데이트 보기에서 과거 변경 내용을 확인합니다. "
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
        DrawText(graphics, "작은 종으로 간편하게 확인", R(20, 12, 310, 24), 14 * scale, Ink, bold: true);
        DrawSurface(graphics, R(364, 14, 148, 23), Color.FromArgb(255, 242, 222),
            Color.FromArgb(255, 242, 222), 6 * scale);
        DrawText(graphics, "현재 테스트 중입니다", R(364, 14, 148, 23), 11 * scale,
            Color.FromArgb(147, 91, 26), bold: true, alignment: TextFormatFlags.HorizontalCenter);

        DrawSurface(graphics, R(20, 48, 492, 35), Color.White, Color.FromArgb(221, 228, 237), 6 * scale);
        DrawTaskButton(graphics, R(27, 54, 30, 23), Color.FromArgb(229, 239, 255), "원", scale, Blue);
        DrawTaskButton(graphics, R(62, 54, 78, 23), Color.FromArgb(241, 244, 248), "Edge ▾", scale);
        DrawTaskButton(graphics, R(145, 54, 61, 23), Color.FromArgb(125, 169, 255), "나이스", scale);
        DrawTaskButton(graphics, R(211, 54, 43, 23), Color.FromArgb(241, 244, 248), "복무", scale);
        DrawTaskButton(graphics, R(259, 54, 43, 23), Color.FromArgb(241, 244, 248), "출장", scale);
        DrawTaskButton(graphics, R(307, 54, 43, 23), Color.FromArgb(220, 206, 247), "결재", scale);
        DrawTaskButton(graphics, R(355, 54, 43, 23), Color.FromArgb(249, 217, 189), "예산", scale);
        DrawSurface(graphics, R(436, 52, 28, 27), Color.FromArgb(241, 244, 248), Color.FromArgb(220, 225, 232), 3 * scale);
        DrawSurface(graphics, R(473, 52, 28, 27), Color.FromArgb(241, 244, 248), Color.FromArgb(220, 225, 232), 3 * scale);
        DrawSystemIcon(graphics, "\uEA8F", R(436, 52, 28, 27), scale);
        DrawSystemIcon(graphics, "\uE713", R(473, 52, 28, 27), scale);
        using (var unread = new SolidBrush(Color.FromArgb(218, 64, 77)))
            graphics.FillEllipse(unread, R(454, 54, 5, 5));
        using (var connector = new Pen(Color.FromArgb(180, 203, 234), scale))
            graphics.DrawLine(connector, 450 * scale, 83 * scale, 450 * scale, 94 * scale);

        DrawText(graphics, "종을 누르면 알림", R(24, 108, 250, 23), 13 * scale, Ink, bold: true);
        DrawText(graphics, "작은 창에서 바로 확인하세요.", R(24, 132, 250, 20), 12 * scale, Muted);
        DrawText(graphics, "미확인 점·기록 보관", R(24, 164, 250, 23), 13 * scale, Ink, bold: true);
        DrawText(graphics, "확인한 알림도 목록에 남습니다.", R(24, 188, 250, 20), 12 * scale, Muted);
        DrawText(graphics, "이전 업데이트 보기", R(24, 220, 250, 23), 13 * scale, Ink, bold: true);
        DrawText(graphics, "지나간 버전도 다시 확인하세요.", R(24, 244, 250, 20), 12 * scale, Muted);

        // A compact example uses approval-count alerts only; student monitoring is not connected.
        DrawSurface(graphics, R(288, 94, 224, 163), Color.White, Color.FromArgb(218, 224, 233), 3 * scale);
        DrawText(graphics, "알림", R(300, 102, 60, 24), 13 * scale, Ink, bold: true);
        DrawText(graphics, "모두 확인", R(432, 106, 59, 18), 10 * scale, Muted);
        DrawText(graphics, "×", R(490, 102, 18, 24), 14 * scale, Muted, alignment: TextFormatFlags.HorizontalCenter);
        using (var divider = new Pen(Color.FromArgb(237, 240, 245), scale))
        {
            graphics.DrawLine(divider, 289 * scale, 132 * scale, 511 * scale, 132 * scale);
            graphics.DrawLine(divider, 300 * scale, 193 * scale, 500 * scale, 193 * scale);
        }
        using (var unread = new SolidBrush(Blue)) graphics.FillEllipse(unread, R(300, 149, 5, 5));
        DrawText(graphics, "결재대기 2건 증가", R(312, 141, 184, 23), 12 * scale, Ink, bold: true);
        DrawText(graphics, "오늘 09:20", R(312, 166, 184, 18), 10 * scale, Muted);
        DrawText(graphics, "결재대기 1건 증가", R(312, 201, 184, 23), 12 * scale, Ink);
        DrawText(graphics, "오늘 09:05", R(312, 226, 184, 18), 10 * scale, Muted);

        DrawText(graphics, "교외체험학습·결석신고 알림은 아직 연결되지 않았습니다.",
            R(20, 274, 492, 16), 10 * scale, Muted);
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
