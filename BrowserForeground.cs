using System.Diagnostics;
using System.Runtime.InteropServices;

namespace BrowserThumbnailPrototype;

internal sealed class BrowserForegroundException(string message, Exception? innerException = null)
    : InvalidOperationException(message, innerException);

internal static class BrowserForeground
{
    private const int MaximumAttempts = 4;
    private const int RetryMilliseconds = 100;
    private const int MaximumMilliseconds = 800;
    private const string IdentityFailure = "업무 화면이 있는 브라우저 창을 확인하지 못했습니다. 브라우저 연결을 확인한 뒤 다시 눌러 주세요.";
    private const string ForegroundFailure = "브라우저 업무 화면을 앞으로 가져오지 못했습니다. 브라우저를 직접 선택한 뒤 다시 눌러 주세요.";

    internal interface IWindowApi
    {
        bool IsWindow(IntPtr window);
        bool IsVisible(IntPtr window);
        bool IsMinimized(IntPtr window);
        uint ReadProcessId(IntPtr window);
        string? ReadProcessName(uint processId);
        IntPtr ReadForeground();
        bool AllowForeground(uint processId);
        bool SetForeground(IntPtr window);
    }

    internal sealed record Context(
        IWindowApi Windows,
        Func<int, uint?> ReadOwner,
        Func<long> ReadMilliseconds,
        Func<TimeSpan, CancellationToken, Task> Delay,
        Action<string> Log);

    private static readonly Context Production = new(
        new Win32WindowApi(), BrowserEndpointOwner.FindListeningProcessId,
        () => Environment.TickCount64, Task.Delay,
        message => AppLogger.Info("BrowserFocus", message));

    internal static bool GrantToBrowser(IntPtr sourceWindow, int port, string? expectedProcessName) =>
        GrantToBrowser(sourceWindow, port, expectedProcessName, Production);

    internal static bool GrantToBrowser(IntPtr sourceWindow, int port, string? expectedProcessName, Context context)
    {
        var validated = false;
        var granted = false;
        try
        {
            var owner = ReadValidOwner(port, context);
            if (sourceWindow == IntPtr.Zero || owner is null || !context.Windows.IsWindow(sourceWindow)
                || context.Windows.ReadProcessId(sourceWindow) != owner.Value) return false;
            var name = context.Windows.ReadProcessName(owner.Value);
            if (!SupportedBrowser(name) || (expectedProcessName is not null
                && (!SupportedBrowser(expectedProcessName)
                    || !string.Equals(name, expectedProcessName, StringComparison.OrdinalIgnoreCase)))) return false;
            // Recheck the binding immediately before granting only this process.
            if (ReadValidOwner(port, context) != owner || !context.Windows.IsWindow(sourceWindow)
                || context.Windows.ReadProcessId(sourceWindow) != owner.Value) return false;
            validated = true;
            granted = context.Windows.AllowForeground(owner.Value);
            return granted;
        }
        catch (Exception)
        {
            return false;
        }
        finally
        {
            Log(context, $"grantValidated={validated};grantAllowed={granted}");
        }
    }

    internal static IntPtr ReadForegroundBrowserWindow(int port) => ReadForegroundBrowserWindow(port, Production);

    internal static IntPtr ReadForegroundBrowserWindow(int port, Context context)
    {
        var matched = false;
        try
        {
            var owner = ReadValidOwner(port, context);
            if (owner is null) return IntPtr.Zero;
            var window = context.Windows.ReadForeground();
            if (!UsableWindow(window, owner.Value, context)
                || ReadValidOwner(port, context) != owner
                || context.Windows.ReadForeground() != window) return IntPtr.Zero;
            matched = true;
            return window;
        }
        catch (Exception)
        {
            return IntPtr.Zero;
        }
        finally
        {
            Log(context, $"foregroundOwnerMatched={matched}");
        }
    }

    internal static Task EnsureWindowForegroundAsync(IntPtr window, int port, CancellationToken cancellationToken) =>
        EnsureWindowForegroundAsync(window, port, cancellationToken, Production);

    internal static async Task EnsureWindowForegroundAsync(
        IntPtr window, int port, CancellationToken cancellationToken, Context context)
    {
        var confirmed = false;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var owner = ReadValidOwner(port, context);
            if (owner is null) throw new BrowserForegroundException(IdentityFailure);
            VerifyWindow(window, port, owner.Value, context, cancellationToken);
            var started = context.ReadMilliseconds();
            for (var attempt = 0; attempt < MaximumAttempts; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                VerifyWindow(window, port, owner.Value, context, cancellationToken);
                if (Elapsed(context, started) >= MaximumMilliseconds) break;
                if (context.Windows.ReadForeground() != window)
                {
                    // A successful API return is only a request acknowledgement.
                    // Never substitute the source HWND or another browser window.
                    var accepted = context.Windows.SetForeground(window);
                    Log(context, $"foregroundRequestAccepted={accepted}");
                    await context.Delay(TimeSpan.FromMilliseconds(RetryMilliseconds), cancellationToken);
                    VerifyWindow(window, port, owner.Value, context, cancellationToken);
                }
                if (context.Windows.ReadForeground() != window) continue;

                // Confirmation spans an await, including delayed native focus
                // changes. A transient foreground flash must not report success.
                await context.Delay(TimeSpan.FromMilliseconds(RetryMilliseconds), cancellationToken);
                VerifyWindow(window, port, owner.Value, context, cancellationToken);
                if (Elapsed(context, started) >= MaximumMilliseconds) break;
                if (context.Windows.ReadForeground() != window)
                    throw new BrowserForegroundException(ForegroundFailure);
                confirmed = true;
                return;
            }
            throw new BrowserForegroundException(ForegroundFailure);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (BrowserForegroundException)
        {
            throw;
        }
        catch (Exception)
        {
            // Native/ownership failures must not leak page or process metadata.
            throw new BrowserForegroundException(IdentityFailure);
        }
        finally
        {
            Log(context, $"foregroundConfirmed={confirmed}");
        }
    }

    private static long Elapsed(Context context, long started)
    {
        var elapsed = context.ReadMilliseconds() - started;
        if (elapsed < 0) throw new BrowserForegroundException(ForegroundFailure);
        return elapsed;
    }

    private static uint? ReadValidOwner(int port, Context context)
    {
        if (port is < 1 or > 65535) return null;
        var owner = context.ReadOwner(port);
        // uint.MaxValue is ASFW_ANY. Never authorize it, even from a bad reader.
        return owner is > 0 and < uint.MaxValue ? owner : null;
    }

    private static bool UsableWindow(IntPtr window, uint owner, Context context) =>
        window != IntPtr.Zero && context.Windows.IsWindow(window) && context.Windows.IsVisible(window)
        && !context.Windows.IsMinimized(window) && context.Windows.ReadProcessId(window) == owner;

    private static void VerifyWindow(IntPtr window, int port, uint owner, Context context, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (ReadValidOwner(port, context) != owner || !UsableWindow(window, owner, context))
            throw new BrowserForegroundException(IdentityFailure);
    }

    private static bool SupportedBrowser(string? name) =>
        string.Equals(name, "msedge", StringComparison.OrdinalIgnoreCase)
        || string.Equals(name, "chrome", StringComparison.OrdinalIgnoreCase);

    private static void Log(Context context, string message)
    {
        try { context.Log(message); }
        catch (Exception) { /* Diagnostics never change foreground behavior. */ }
    }

    internal sealed class Win32WindowApi : IWindowApi
    {
        public bool IsWindow(IntPtr window) => NativeIsWindow(window);
        public bool IsVisible(IntPtr window) => IsWindowVisible(window);
        public bool IsMinimized(IntPtr window) => IsIconic(window);
        public uint ReadProcessId(IntPtr window)
        {
            _ = GetWindowThreadProcessId(window, out var processId);
            return processId;
        }
        public string? ReadProcessName(uint processId)
        {
            if (processId > int.MaxValue) return null;
            using var process = Process.GetProcessById((int)processId);
            return process.ProcessName;
        }
        public IntPtr ReadForeground() => GetForegroundWindow();
        public bool AllowForeground(uint processId) => processId is > 0 and < uint.MaxValue && AllowSetForegroundWindow(processId);
        public bool SetForeground(IntPtr window) => SetForegroundWindow(window);

        [DllImport("user32.dll", EntryPoint = "IsWindow", ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool NativeIsWindow(IntPtr window);
        [DllImport("user32.dll", ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll", ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll", ExactSpelling = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll", ExactSpelling = true)]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AllowSetForegroundWindow(uint processId);
        [DllImport("user32.dll", ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetForegroundWindow(IntPtr window);
    }
}
