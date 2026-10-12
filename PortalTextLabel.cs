using System.Drawing.Text;

namespace BrowserThumbnailPrototype;

internal sealed class PortalTextLabel : Label
{
    public PortalTextLabel() => UseCompatibleTextRendering = true;

    protected override void OnPaint(PaintEventArgs e)
    {
        // Use the same deterministic glyph raster for the visible label and its
        // foreground mask. ClearType's screen/bitmap differences leave white specks.
        e.Graphics.TextRenderingHint = TextRenderingHint.SingleBitPerPixelGridFit;
        base.OnPaint(e);
    }
}
