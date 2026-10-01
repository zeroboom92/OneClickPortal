using System.Drawing.Drawing2D;

namespace BrowserThumbnailPrototype;

// 작은 업무 버튼에만 적용하는 유리 느낌의 표면. 배경 캡처나 DWM 미리보기는 사용하지 않습니다.
internal sealed class GlassTaskButton : Button
{
    private bool _hovered;
    private bool _pressed;

    public GlassTaskButton()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); _hovered = true; Invalidate(); }
    protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); _hovered = false; Invalidate(); }
    protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); if (e.Button == MouseButtons.Left) _pressed = true; Invalidate(); }
    protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); _pressed = false; Invalidate(); }
    protected override void OnMouseCaptureChanged(EventArgs e) { base.OnMouseCaptureChanged(e); _pressed = false; Invalidate(); }
    protected override void OnKeyDown(KeyEventArgs e) { base.OnKeyDown(e); if (e.KeyCode == Keys.Space) _pressed = true; Invalidate(); }
    protected override void OnKeyUp(KeyEventArgs e) { base.OnKeyUp(e); _pressed = false; Invalidate(); }
    protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); _pressed = false; Invalidate(); }

    protected override void OnPaint(PaintEventArgs e)
    {
        if (Width < 2 || Height < 2) return;
        var scale = DeviceDpi / 96f;
        var bounds = new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f);
        var diameter = Math.Min(8f * scale, Math.Min(bounds.Width, bounds.Height));
        using var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        e.Graphics.Clear(Parent?.BackColor ?? Color.White);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var active = Enabled && (_pressed || _hovered);
        var baseColor = BackColor.IsEmpty ? Color.FromArgb(241, 244, 248) : BackColor;
        var top = active ? Lighten(baseColor, 0.12f) : Lighten(baseColor, 0.04f);
        var bottom = active ? Darken(baseColor, 0.06f) : baseColor;
        using var fill = new LinearGradientBrush(bounds, _pressed && Enabled ? bottom : top, bottom, 90f);
        e.Graphics.FillPath(fill, path);
        using var border = new Pen(Darken(baseColor, active ? 0.18f : 0.12f));
        e.Graphics.DrawPath(border, path);
        using var highlight = new Pen(Color.FromArgb(210, Color.White), scale);
        e.Graphics.DrawLine(highlight, diameter / 2, 1.5f * scale, Width - diameter / 2, 1.5f * scale);
        TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle,
            Enabled ? ForeColor : SystemColors.GrayText,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        if (Focused && ShowFocusCues)
            ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -4, -4));
    }

    private static Color Lighten(Color color, float amount)
    {
        return Blend(color, Color.White, amount);
    }

    private static Color Darken(Color color, float amount)
    {
        return Blend(color, Color.Black, amount);
    }

    private static Color Blend(Color first, Color second, float amount)
    {
        amount = Math.Clamp(amount, 0f, 1f);
        return Color.FromArgb(
            (int)Math.Round(first.R + (second.R - first.R) * amount),
            (int)Math.Round(first.G + (second.G - first.G) * amount),
            (int)Math.Round(first.B + (second.B - first.B) * amount));
    }
}
