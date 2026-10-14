using System.ComponentModel;
using System.Diagnostics.CodeAnalysis;
using System.Drawing.Drawing2D;

namespace BrowserThumbnailPrototype;

internal sealed class NotificationBellButton : Button
{
    private static readonly string IconFontFamily = GetIconFontFamily();
    private bool hasUnread;
    private bool hovering;
    private bool pressed;

    public NotificationBellButton()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
            | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        UseVisualStyleBackColor = false;
        BackColor = Color.FromArgb(241, 244, 248);
        ForeColor = Color.FromArgb(74, 84, 100);
        FlatAppearance.BorderColor = BackColor;
        FlatAppearance.BorderSize = 1;
        AccessibleRole = AccessibleRole.PushButton;
        AccessibleName = "알림 모아보기";
        TabStop = true;
    }

    protected override Size DefaultSize => new(28, 28);

    // This button is deliberately icon-only; count information belongs in its
    // tooltip and accessible name, which the notification controller maintains.
    [Browsable(false)]
    [AllowNull]
    [EditorBrowsable(EditorBrowsableState.Never)]
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public override string Text
    {
        get => string.Empty;
        set => base.Text = string.Empty;
    }

    [DefaultValue(false)]
    public bool HasUnread
    {
        get => hasUnread;
        set
        {
            if (hasUnread == value) return;
            hasUnread = value;
            Invalidate();
        }
    }

    protected override void OnMouseEnter(EventArgs e)
    {
        hovering = true;
        Invalidate();
        base.OnMouseEnter(e);
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        hovering = false;
        pressed = false;
        Invalidate();
        base.OnMouseLeave(e);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) pressed = true;
        Invalidate();
        base.OnMouseDown(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        pressed = false;
        Invalidate();
        base.OnMouseUp(e);
    }

    protected override void OnMouseCaptureChanged(EventArgs e)
    {
        if (!Capture) pressed = false;
        Invalidate();
        base.OnMouseCaptureChanged(e);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Space) pressed = true;
        Invalidate();
        base.OnKeyDown(e);
    }

    protected override void OnKeyUp(KeyEventArgs e)
    {
        pressed = false;
        Invalidate();
        base.OnKeyUp(e);
    }

    protected override void OnGotFocus(EventArgs e)
    {
        Invalidate();
        base.OnGotFocus(e);
    }

    protected override void OnLostFocus(EventArgs e)
    {
        pressed = false;
        Invalidate();
        base.OnLostFocus(e);
    }

    protected override void OnEnabledChanged(EventArgs e)
    {
        if (!Enabled) pressed = false;
        Invalidate();
        base.OnEnabledChanged(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var background = !Enabled ? Mix(BackColor, SystemColors.Control, 0.5f)
            : pressed ? Mix(BackColor, ForeColor, 0.12f)
            : hovering ? Mix(BackColor, ForeColor, 0.06f) : BackColor;
        var outline = Enabled ? ForeColor : SystemColors.GrayText;
        using (var brush = new SolidBrush(background)) e.Graphics.FillRectangle(brush, ClientRectangle);
        if (ClientSize.Width < 8 || ClientSize.Height < 8) return;

        if (FlatAppearance.BorderSize > 0)
        {
            var border = Enabled ? FlatAppearance.BorderColor : Mix(FlatAppearance.BorderColor, background, 0.5f);
            using var pen = new Pen(border, FlatAppearance.BorderSize);
            var inset = FlatAppearance.BorderSize / 2f;
            e.Graphics.DrawRectangle(pen, inset, inset,
                Math.Max(0, ClientSize.Width - FlatAppearance.BorderSize),
                Math.Max(0, ClientSize.Height - FlatAppearance.BorderSize));
        }

        var scale = Math.Min(DeviceDpi / 96f, (Math.Min(ClientSize.Width, ClientSize.Height) - 4) / 24f);
        if (scale <= 0) return;
        // Windows' standard Ringer glyph (U+EA8F), at the settings button's 12 pt size.
        // Segoe MDL2 Assets provides the same glyph on Windows 10.
        using var iconFont = new Font(IconFontFamily, 16f * scale, FontStyle.Regular, GraphicsUnit.Pixel);
        var iconBounds = ClientRectangle;
        if (pressed) iconBounds.Offset(0, Math.Max(1, (int)Math.Round(scale)));
        TextRenderer.DrawText(e.Graphics, "\uEA8F", iconFont, iconBounds, outline, background,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter
            | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);

        if (hasUnread)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using var dot = new SolidBrush(Enabled ? Color.FromArgb(218, 64, 77) : Color.FromArgb(163, 141, 144));
            using var rim = new Pen(background, 1.4f * scale);
            var diameter = 5.3f * scale;
            var bounds = new RectangleF(ClientSize.Width / 2f + 4f * scale,
                ClientSize.Height / 2f - 10f * scale, diameter, diameter);
            e.Graphics.FillEllipse(dot, bounds);
            e.Graphics.DrawEllipse(rim, bounds);
        }

        if (Focused && ShowFocusCues)
        {
            var inset = Math.Max(2, (int)Math.Round(2 * DeviceDpi / 96f));
            var focus = Rectangle.Inflate(ClientRectangle, -inset, -inset);
            if (focus.Width > 0 && focus.Height > 0)
                ControlPaint.DrawFocusRectangle(e.Graphics, focus, outline, background);
        }
    }

    private static string GetIconFontFamily()
    {
        using var font = new Font("Segoe Fluent Icons", 12F);
        return font.Name == "Segoe Fluent Icons" ? font.Name : "Segoe MDL2 Assets";
    }

    private static Color Mix(Color first, Color second, float amount) => Color.FromArgb(
        first.A,
        (int)Math.Round(first.R + (second.R - first.R) * amount),
        (int)Math.Round(first.G + (second.G - first.G) * amount),
        (int)Math.Round(first.B + (second.B - first.B) * amount));
}
