using System.Drawing.Drawing2D;

namespace BrowserThumbnailPrototype;

// Native release-note illustration; it never reads or opens a user's work screens.
internal sealed class UpdateFeaturePreview : Control
{
    private static readonly Color Ink = Color.FromArgb(34, 40, 50);
    private static readonly Color Muted = Color.FromArgb(92, 102, 116);
    private static readonly Color Blue = Color.FromArgb(42, 106, 190);
    private static readonly string IconFontFamily = GetIconFontFamily();
    private readonly bool _browserChoicePreview;

    public UpdateFeaturePreview() : this(UpdateHistory.Current.Version) { }

    // Keep the preceding illustration available for release-history verification.
    public UpdateFeaturePreview(string version)
    {
        _browserChoicePreview = version == "1.4.3";
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        SetStyle(ControlStyles.Selectable, false);
        Size = new Size(532, 299);
        BackColor = Color.White;
        TabStop = false;
        AccessibleRole = AccessibleRole.Graphic;
        if (_browserChoicePreview)
        {
            AccessibleName = "크롬 또는 엣지로 로그인하고 연결하기";
            AccessibleDescription = "설정의 로그인 브라우저에서 Chrome 또는 Edge를 선택합니다. "
                + "원클릭의 로그인 버튼으로 선택한 브라우저를 열고 로그인한 뒤 연결을 누릅니다. "
                + "로그인·인증서 선택과 최종 상신·결재는 사용자가 직접 진행합니다.";
            return;
        }
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
        if (_browserChoicePreview)
        {
            DrawBrowserChoice(graphics, scale);
            return;
        }
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

    private static void DrawBrowserChoice(Graphics graphics, float scale)
    {
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
        DrawText(graphics, "원하는 브라우저로 시작하세요", R(24, 18, 484, 28),
            16 * scale, Ink, bold: true);

        var borderColor = Color.FromArgb(221, 228, 237);
        DrawSurface(graphics, R(24, 68, 192, 146), Color.White, borderColor, 8 * scale);
        DrawText(graphics, "1  브라우저 선택", R(36, 78, 168, 24), 14 * scale, Ink, bold: true);
        DrawText(graphics, "설정 > 로그인 브라우저", R(36, 111, 168, 20), 11 * scale, Muted);
        DrawSurface(graphics, R(36, 146, 80, 36), Color.FromArgb(237, 245, 255),
            Color.FromArgb(120, 163, 221), 6 * scale);
        DrawText(graphics, "Chrome", R(40, 150, 72, 28), 13 * scale, Blue, bold: true,
            alignment: TextFormatFlags.HorizontalCenter);
        DrawSurface(graphics, R(124, 146, 80, 36), Color.FromArgb(247, 249, 252),
            borderColor, 6 * scale);
        DrawText(graphics, "Edge", R(128, 150, 72, 28), 13 * scale, Ink,
            alignment: TextFormatFlags.HorizontalCenter);

        DrawSurface(graphics, R(244, 68, 120, 146), Color.White, borderColor, 8 * scale);
        DrawText(graphics, "2  로그인", R(254, 78, 100, 24), 14 * scale, Ink, bold: true);
        DrawText(graphics, "선택한 브라우저", R(250, 111, 108, 20), 11 * scale, Muted,
            alignment: TextFormatFlags.HorizontalCenter);
        DrawSurface(graphics, R(260, 145, 88, 34), Color.FromArgb(49, 124, 213),
            Color.FromArgb(49, 124, 213), 5 * scale);
        DrawText(graphics, "로그인", R(264, 148, 80, 28), 13 * scale, Color.White, bold: true,
            alignment: TextFormatFlags.HorizontalCenter);
        DrawText(graphics, "로그인은 직접 진행", R(248, 185, 112, 18), 10 * scale, Muted,
            alignment: TextFormatFlags.HorizontalCenter);

        DrawSurface(graphics, R(392, 68, 116, 146), Color.White, borderColor, 8 * scale);
        DrawText(graphics, "3  연결", R(404, 78, 92, 24), 14 * scale, Ink, bold: true);
        DrawText(graphics, "로그인을 마친 뒤", R(398, 111, 104, 20), 11 * scale, Muted,
            alignment: TextFormatFlags.HorizontalCenter);
        DrawSurface(graphics, R(406, 145, 88, 34), Color.FromArgb(45, 162, 126),
            Color.FromArgb(45, 162, 126), 5 * scale);
        DrawText(graphics, "연결", R(410, 148, 80, 28), 13 * scale, Color.White, bold: true,
            alignment: TextFormatFlags.HorizontalCenter);
        DrawText(graphics, "업무 버튼 사용", R(400, 185, 100, 18), 10 * scale, Muted,
            alignment: TextFormatFlags.HorizontalCenter);

        using (var arrow = new Pen(Blue, 2 * scale))
        {
            arrow.StartCap = LineCap.Round;
            arrow.EndCap = LineCap.Round;
            foreach (var x in new[] { 222, 370 })
            {
                graphics.DrawLine(arrow, x * scale, 141 * scale, (x + 15) * scale, 141 * scale);
                graphics.DrawLine(arrow, (x + 10) * scale, 136 * scale, (x + 15) * scale, 141 * scale);
                graphics.DrawLine(arrow, (x + 10) * scale, 146 * scale, (x + 15) * scale, 141 * scale);
            }
        }
        DrawSurface(graphics, R(24, 234, 484, 42), Color.FromArgb(237, 245, 255),
            Color.FromArgb(202, 220, 245), 6 * scale);
        DrawText(graphics, "로그인 · 인증서 선택 · 최종 상신은 직접 진행합니다.", R(34, 241, 464, 28),
            12 * scale, Blue, alignment: TextFormatFlags.HorizontalCenter);
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
