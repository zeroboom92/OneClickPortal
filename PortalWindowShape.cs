using System.Drawing.Drawing2D;

namespace BrowserThumbnailPrototype;

internal static class PortalWindowShape
{
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
}
