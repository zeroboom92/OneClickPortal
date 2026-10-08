using System.Drawing.Drawing2D;

namespace BrowserThumbnailPrototype;

// Native release-note illustration; it never reads or opens a user's work screens.
internal sealed class UpdateFeaturePreview : Control
{
    private static readonly Color Ink = Color.FromArgb(34, 40, 50);
    private static readonly Color Muted = Color.FromArgb(92, 102, 116);

    public UpdateFeaturePreview()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        SetStyle(ControlStyles.Selectable, false);
        Size = new Size(532, 299);
        BackColor = Color.White;
        TabStop = false;
        AccessibleRole = AccessibleRole.Graphic;
        AccessibleName = "새로운 결재·예산 기능 안내";
        AccessibleDescription = "연보라색 결재 버튼과 살구색 예산 버튼이 추가되었습니다. "
            + "결재 버튼 오른쪽 아래의 빨간 원에 흰색 결재대기 건수가 표시됩니다. 그림의 5건은 예시입니다. "
            + "에듀파인 사용 중에는 약 5초, 그 외에는 1분마다 화면의 표시 건수를 확인합니다. "
            + "예산은 현재 조건으로 조회 버튼을 한 번 누르며, 업무 화면을 빠르게 표시합니다.";
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

        DrawText(graphics, "새로 추가된 업무 버튼", R(20, 13, 255, 22), 13 * scale, Ink, bold: true);
        DrawText(graphics, "숫자 5는 표시 예시입니다", R(296, 16, 216, 18), 11 * scale, Muted,
            alignment: TextFormatFlags.Right);

        using (var panel = new SolidBrush(Color.White))
        using (var outline = new Pen(Color.FromArgb(225, 230, 238), scale))
        using (var path = RoundedRectangle(R(20, 43, 492, 54), 7 * scale))
        {
            graphics.FillPath(panel, path);
            graphics.DrawPath(outline, path);
        }
        DrawText(graphics, "업무 버튼", R(36, 55, 80, 28), 12 * scale, Muted);
        DrawTaskButton(graphics, R(132, 55, 49, 28), Color.FromArgb(220, 206, 247), "결재", scale);
        DrawTaskButton(graphics, R(182, 55, 49, 28), Color.FromArgb(249, 217, 189), "예산", scale);
        // Match the actual 49x28 single-row button and 14px lower-right badge, with 4px overhang.
        DrawCountBadge(graphics, R(167, 73, 14, 14), scale);
        DrawText(graphics, "목록과 현황을 빠르게 열어요", R(251, 55, 244, 28), 12 * scale, Ink);

        DrawFeature(graphics, 1, 114, "결재 · 예산 버튼 추가",
            "결재대기 목록과 사업별 예산현황을 바로 엽니다.",
            Color.FromArgb(236, 229, 250), Color.FromArgb(107, 73, 161), scale);
        DrawFeature(graphics, 2, 174, "화면의 결재 건수를 주기적으로 확인",
            "에듀파인 사용 중 약 5초, 그 외에는 1분마다 확인합니다.",
            Color.FromArgb(229, 239, 255), Color.FromArgb(49, 101, 169), scale);
        DrawFeature(graphics, 3, 234, "자동 조회와 빠른 화면 전환",
            "예산은 현재 조건으로 한 번 조회하고 창을 표시합니다.",
            Color.FromArgb(251, 234, 218), Color.FromArgb(148, 89, 43), scale);
    }

    private static void DrawFeature(Graphics graphics, int number, float y, string title, string description,
        Color background, Color foreground, float scale)
    {
        Rectangle R(float x, float top, float width, float height) => new(
            (int)Math.Round(x * scale), (int)Math.Round(top * scale),
            (int)Math.Round(width * scale), (int)Math.Round(height * scale));
        var marker = R(24, y + 2, 24, 24);
        using var fill = new SolidBrush(background);
        graphics.FillEllipse(fill, marker);
        DrawText(graphics, number.ToString(), marker, 12 * scale, foreground, bold: true,
            alignment: TextFormatFlags.HorizontalCenter);
        DrawText(graphics, title, R(62, y, 446, 22), 13 * scale, Ink, bold: true);
        DrawText(graphics, description, R(62, y + 24, 446, 22), 12 * scale, Muted);
    }

    private static void DrawTaskButton(Graphics graphics, Rectangle bounds, Color color, string text, float scale)
    {
        var surface = new RectangleF(bounds.X + scale / 2, bounds.Y + scale / 2,
            bounds.Width - scale, bounds.Height - scale);
        using var path = RoundedRectangle(surface, 4 * scale);
        using var fill = new LinearGradientBrush(surface, Blend(color, Color.White, 0.04f), color, 90f);
        using var border = new Pen(Blend(color, Color.Black, 0.12f), scale);
        using var highlight = new Pen(Color.FromArgb(210, Color.White), scale);
        graphics.FillPath(fill, path);
        graphics.DrawPath(border, path);
        graphics.DrawLine(highlight, bounds.Left + 4 * scale, bounds.Top + 1.5f * scale,
            bounds.Right - 4 * scale, bounds.Top + 1.5f * scale);
        // Pixel-sized fonts scale once with the drawing coordinates, including on high-DPI screens.
        DrawText(graphics, text, bounds, 12 * scale, Color.FromArgb(45, 52, 64),
            alignment: TextFormatFlags.HorizontalCenter);
    }

    private static void DrawCountBadge(Graphics graphics, Rectangle bounds, float scale)
    {
        using var fill = new SolidBrush(Color.FromArgb(220, 38, 38));
        graphics.FillEllipse(fill, bounds.X + scale / 2, bounds.Y + scale / 2,
            bounds.Width - scale, bounds.Height - scale);
        using var font = new Font("Segoe UI", 10 * scale, FontStyle.Bold, GraphicsUnit.Pixel);
        TextRenderer.DrawText(graphics, "5", font, bounds, Color.White,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
            TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
    }

    private static void DrawText(Graphics graphics, string text, Rectangle bounds, float pixels, Color color,
        bool bold = false, TextFormatFlags alignment = TextFormatFlags.Left)
    {
        using var font = new Font("맑은 고딕", pixels, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel);
        TextRenderer.DrawText(graphics, text, font, bounds, color,
            alignment | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }

    private static Color Blend(Color first, Color second, float amount) => Color.FromArgb(
        (int)Math.Round(first.R + (second.R - first.R) * amount),
        (int)Math.Round(first.G + (second.G - first.G) * amount),
        (int)Math.Round(first.B + (second.B - first.B) * amount));

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
