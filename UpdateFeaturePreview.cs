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
        AccessibleName = "메뉴 자동 펼침과 배경 투명도 안내";
        AccessibleDescription = "열기 손잡이인 ▼ 업무포털은 항상 보입니다. "
            + "마우스를 올리면 메뉴가 펼쳐지고, 메뉴와 손잡이를 벗어나면 2초 뒤 접힙니다. "
            + "2초 안에 돌아오면 접힘이 취소됩니다. 로고와 손잡이를 끌어 좌우로 이동할 수 있습니다. "
            + "설정에서 배경 불투명도를 0부터 100퍼센트까지 실시간으로 조절할 수 있으며, "
            + "버튼과 글자는 선명하게 유지됩니다. 설정을 취소하면 원래 불투명도로 돌아갑니다.";
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

        DrawText(graphics, "항상 보이는 손잡이에서 시작하세요", R(20, 12, 492, 22),
            13 * scale, Ink, bold: true);

        DrawTaskButton(graphics, R(24, 41, 123, 27), Color.White, "▼ 업무포털", scale,
            Color.FromArgb(42, 106, 190));
        DrawText(graphics, "→", R(155, 41, 26, 27), 17 * scale, Color.FromArgb(49, 124, 213),
            alignment: TextFormatFlags.HorizontalCenter);
        DrawText(graphics, "마우스를 올리면 메뉴가 펼쳐져요", R(186, 41, 326, 27),
            12 * scale, Muted);

        using (var panel = new SolidBrush(Color.FromArgb(185, Color.White)))
        using (var outline = new Pen(Color.FromArgb(225, 230, 238), scale))
        using (var path = RoundedRectangle(R(20, 78, 492, 36), 7 * scale))
        {
            // A subtle screen pattern remains visible through the mock background;
            // the controls above it are painted with their original solid colors.
            var state = graphics.Save();
            graphics.SetClip(path);
            using var backdrop = new SolidBrush(Color.FromArgb(220, 231, 243));
            graphics.FillRectangle(backdrop, R(20, 78, 492, 36));
            using var stripe = new SolidBrush(Color.FromArgb(204, 220, 237));
            for (var x = 20; x < 512; x += 32)
                graphics.FillRectangle(stripe, R(x, 78, 16, 36));
            graphics.Restore(state);
            graphics.FillPath(panel, path);
            graphics.DrawPath(outline, path);
        }
        DrawTaskButton(graphics, R(28, 84, 26, 24), Color.FromArgb(49, 124, 213), "원", scale, Color.White);
        DrawTaskButton(graphics, R(60, 84, 62, 24), Color.FromArgb(248, 249, 251), "Edge ▾", scale);
        DrawTaskButton(graphics, R(127, 84, 52, 24), Color.FromArgb(49, 124, 213), "로그인", scale, Color.White);
        DrawTaskButton(graphics, R(184, 84, 56, 24), Color.FromArgb(125, 169, 255), "나이스", scale);
        DrawTaskButton(graphics, R(245, 84, 47, 24), Color.FromArgb(241, 244, 248), "복무", scale);
        DrawTaskButton(graphics, R(297, 84, 47, 24), Color.FromArgb(241, 244, 248), "출장", scale);
        DrawTaskButton(graphics, R(349, 84, 47, 24), Color.FromArgb(220, 206, 247), "결재", scale);
        DrawTaskButton(graphics, R(401, 84, 47, 24), Color.FromArgb(249, 217, 189), "예산", scale);
        DrawTaskButton(graphics, R(453, 84, 29, 24), Color.FromArgb(241, 244, 248), "⚙", scale);

        DrawFeature(graphics, 1, 128, "마우스로 열고, 벗어나면 2초 뒤 접기",
            "메뉴나 손잡이로 돌아오면 접힘이 취소됩니다.",
            Color.FromArgb(236, 229, 250), Color.FromArgb(107, 73, 161), scale);
        DrawFeature(graphics, 2, 184, "배경만 0~100% 실시간으로 조절",
            "버튼·글자는 선명하게, 취소하면 원래 불투명도로.",
            Color.FromArgb(229, 239, 255), Color.FromArgb(49, 101, 169), scale);
        DrawFeature(graphics, 3, 240, "로고·손잡이를 끌어 좌우로 이동",
            "화면 위쪽을 유지하며 원하는 위치로 옮깁니다.",
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

    private static void DrawTaskButton(Graphics graphics, Rectangle bounds, Color color, string text, float scale,
        Color? textColor = null)
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
        DrawText(graphics, text, bounds, 12 * scale, textColor ?? Color.FromArgb(45, 52, 64),
            alignment: TextFormatFlags.HorizontalCenter);
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
