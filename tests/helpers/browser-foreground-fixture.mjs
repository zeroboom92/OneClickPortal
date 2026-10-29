// Existing offline transport probes never call native foreground APIs. Compile
// their production dependency with an adapter that fails if a new path does so.
export const browserForegroundStub = String.raw`
namespace BrowserThumbnailPrototype
{
    internal sealed class BrowserForegroundException(string message, Exception? inner = null) : InvalidOperationException(message, inner);
    internal static class BrowserForeground
    {
        internal static IntPtr ReadForegroundBrowserWindow(int port) =>
            throw new InvalidOperationException("Unexpected native foreground read in an offline fixture.");
        internal static Task EnsureWindowForegroundAsync(IntPtr window, int port, CancellationToken token) =>
            throw new InvalidOperationException("Unexpected native foreground activation in an offline fixture.");
        internal static bool GrantToBrowser(IntPtr window, int port, string? processName) =>
            throw new InvalidOperationException("Unexpected native foreground grant in an offline fixture.");
    }
}
`;
