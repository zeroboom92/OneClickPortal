using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace BrowserThumbnailPrototype;

internal static class PortalWindowShape
{
    private static readonly ConditionalWeakTable<Label, LabelMaskCache> LabelMasks = new();

    public static Region Create(Size size, int dpi)
    {
        var width = Math.Max(1, size.Width);
        var height = Math.Max(1, size.Height);
        var radius = Math.Min(14f * dpi / 96f, Math.Min(width / 2f, height / 2f));
        var diameter = radius * 2;
        using var path = new GraphicsPath();
        path.AddLine(0, 0, width, 0);
        path.AddLine(width, 0, width, height - radius);
        path.AddArc(width - diameter, height - diameter, diameter, diameter, 0, 90);
        path.AddLine(width - radius, height, radius, height);
        path.AddArc(0, height - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return new Region(path);
    }

    // The foreground keeps controls opaque; the separate background window supplies
    // the adjustable white surface. The caller applies the outer shape/slide clip.
    public static Region CreateForeground(Form portal)
    {
        var foreground = new Region();
        foreground.MakeEmpty();
        using var clientClip = new Region(portal.ClientRectangle);
        AddVisibleControls(portal, portal, clientClip, foreground);
        return foreground;
    }

    private static void AddVisibleControls(Form portal, Control parent, Region parentClip, Region foreground)
    {
        foreach (Control control in parent.Controls)
        {
            if (!control.Visible || control.IsDisposed || control.Width <= 0 || control.Height <= 0)
                continue;

            // Convert the window bounds through the parent client area, preserving
            // nested layout offsets without mistaking native borders for padding.
            var origin = portal.PointToClient(parent.PointToScreen(control.Location));
            using var controlClip = control.Region?.Clone()
                ?? new Region(new Rectangle(Point.Empty, control.Size));
            controlClip.Intersect(new Rectangle(Point.Empty, control.Size));
            controlClip.Translate(origin.X, origin.Y);
            controlClip.Intersect(parentClip);

            if (control.HasChildren || control is TableLayoutPanel or FlowLayoutPanel)
            {
                var clientOrigin = portal.PointToClient(control.PointToScreen(Point.Empty));
                controlClip.Intersect(new Rectangle(clientOrigin, control.ClientSize));
                AddVisibleControls(portal, control, controlClip, foreground);
                continue;
            }

            if (control is Label label)
            {
                using var labelMask = CreateLabelMask(label);
                labelMask.Translate(origin.X, origin.Y);
                labelMask.Intersect(controlClip);
                foreground.Union(labelMask);
            }
            else
            {
                // Buttons, native ComboBox borders and the badge's own Region are
                // retained as complete, interactive surfaces.
                foreground.Union(controlClip);
            }
        }
    }

    private static Region CreateLabelMask(Label label)
    {
        if (label.Image is Image image && string.IsNullOrEmpty(label.Text))
        {
            var area = Rectangle.FromLTRB(label.Padding.Left, label.Padding.Top,
                label.Width - label.Padding.Right, label.Height - label.Padding.Bottom);
            var x = label.ImageAlign switch
            {
                ContentAlignment.TopLeft or ContentAlignment.MiddleLeft or ContentAlignment.BottomLeft => area.Left,
                ContentAlignment.TopRight or ContentAlignment.MiddleRight or ContentAlignment.BottomRight => area.Right - image.Width,
                _ => area.Left + (area.Width - image.Width) / 2,
            };
            var y = label.ImageAlign switch
            {
                ContentAlignment.TopLeft or ContentAlignment.TopCenter or ContentAlignment.TopRight => area.Top,
                ContentAlignment.BottomLeft or ContentAlignment.BottomCenter or ContentAlignment.BottomRight => area.Bottom - image.Height,
                _ => area.Top + (area.Height - image.Height) / 2,
            };
            var imageBounds = Rectangle.Intersect(new Rectangle(x, y, image.Width, image.Height), label.ClientRectangle);
            return new Region(imageBounds);
        }

        var background = ResolveBackgroundColor(label);
        var key = new LabelMaskKey(label.Text, label.Size, label.Font, label.ForeColor,
            background, label.Enabled, label.AutoEllipsis, label.UseMnemonic,
            label.UseCompatibleTextRendering, label.TextAlign, label.Padding,
            label.BorderStyle, label.RightToLeft, label.DeviceDpi, label.Image, label.ImageAlign);
        var cache = LabelMasks.GetValue(label, static _ => new LabelMaskCache());
        if (cache.Mask is null || cache.Key != key)
        {
            var mask = RasterizeLabel(label, background);
            cache.Mask?.Dispose();
            cache.Mask = mask;
            cache.Key = key;
        }
        return cache.Mask.Clone();
    }

    private static Region RasterizeLabel(Label label, Color background)
    {
        using var bitmap = new Bitmap(label.Width, label.Height, PixelFormat.Format32bppArgb);
        bitmap.SetResolution(label.DeviceDpi, label.DeviceDpi);
        var bounds = new Rectangle(Point.Empty, label.Size);
        using (var graphics = Graphics.FromImage(bitmap))
            graphics.Clear(background);
        label.DrawToBitmap(bitmap, bounds);

        // Preserve the actual antialiased glyph pixels, including ellipsis, instead
        // of leaving an opaque rectangle behind a Dock=Fill status label.
        using var path = new GraphicsPath(FillMode.Winding);
        var bits = bitmap.LockBits(bounds, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var row = new byte[label.Width * 4];
            for (var y = 0; y < label.Height; y++)
            {
                Marshal.Copy(IntPtr.Add(bits.Scan0, y * bits.Stride), row, 0, row.Length);
                var runStart = -1;
                for (var x = 0; x <= label.Width; x++)
                {
                    var offset = x * 4;
                    var hasInk = x < label.Width &&
                        (row[offset] != background.B || row[offset + 1] != background.G || row[offset + 2] != background.R);
                    if (hasInk && runStart < 0)
                        runStart = x;
                    else if (!hasInk && runStart >= 0)
                    {
                        path.AddRectangle(new Rectangle(runStart, y, x - runStart, 1));
                        runStart = -1;
                    }
                }
            }
        }
        finally
        {
            bitmap.UnlockBits(bits);
        }

        var mask = new Region();
        mask.MakeEmpty();
        if (path.PointCount > 0)
            mask.Union(path);
        return mask;
    }

    private static Color ResolveBackgroundColor(Control control)
    {
        var color = control.BackColor;
        if (color.A == 255)
            return color;
        var underneath = control.Parent is null ? SystemColors.Control : ResolveBackgroundColor(control.Parent);
        var alpha = color.A;
        return Color.FromArgb(
            (color.R * alpha + underneath.R * (255 - alpha)) / 255,
            (color.G * alpha + underneath.G * (255 - alpha)) / 255,
            (color.B * alpha + underneath.B * (255 - alpha)) / 255);
    }

    private sealed class LabelMaskCache
    {
        public LabelMaskKey Key;
        public Region? Mask;
    }

    private readonly record struct LabelMaskKey(string Text, Size Size, Font Font,
        Color ForeColor, Color Background, bool Enabled, bool AutoEllipsis,
        bool UseMnemonic, bool UseCompatibleTextRendering, ContentAlignment TextAlign,
        Padding Padding, BorderStyle BorderStyle, RightToLeft RightToLeft, int Dpi,
        Image? Image, ContentAlignment ImageAlign);
}
