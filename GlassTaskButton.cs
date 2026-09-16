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
        var top = active ? Color.FromArgb(247, 252, 255) : Color.FromArgb(253, 254, 255);
        var bottom = active ? Color.FromArgb(216, 234, 250) : Color.FromArgb(234, 240, 248);
        using var fill = new LinearGradientBrush(bounds, _pressed && Enabled ? bottom : top, bottom, 90f);
        e.Graphics.FillPath(fill, path);
        using var border = new Pen(active ? Color.FromArgb(158, 187, 216) : Color.FromArgb(207, 219, 232));
        e.Graphics.DrawPath(border, path);
        using var highlight = new Pen(Color.FromArgb(210, Color.White), scale);
        e.Graphics.DrawLine(highlight, diameter / 2, 1.5f * scale, Width - diameter / 2, 1.5f * scale);
        TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle,
            Enabled ? ForeColor : SystemColors.GrayText,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        if (Focused && ShowFocusCues)
            ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -4, -4));
    }
}
