using System.Diagnostics;

namespace BrowserThumbnailPrototype;

internal sealed class PreviewInstanceGuard : IDisposable
{
    private readonly Mutex _mutex;
    private bool _ownsMutex;

    private PreviewInstanceGuard(Mutex mutex) { _mutex = mutex; _ownsMutex = true; }

    public static PreviewInstanceGuard? TryAcquire(out string? reason)
    {
        reason = null;
        Mutex? mutex = null;
        var acquired = false;
        try
        {
            // Every preview folder/version shares one lock within this Windows session.
            mutex = new Mutex(false, @"Local\OneClickPortal.Preview.SingleInstance");
            try { acquired = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired)
            {
                reason = "다른 테스트본이 실행 중입니다.";
                mutex.Dispose();
                return null;
            }

            using var current = Process.GetCurrentProcess();
            var workspace = ResolveWorkspaceRoot();
            var installedPath = Path.GetFullPath(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OneClickPortal", "current", "OneClickPortal.exe"));
            var existing = 0;
            foreach (var process in Process.GetProcessesByName("OneClickPortal"))
            {
                using (process)
                {
                    if (process.Id == current.Id || process.SessionId != current.SessionId) continue;
                    string? path;
                    try { path = process.MainModule?.FileName; }
                    catch (InvalidOperationException) { continue; } // Already exited.
                    if (path is null || !Path.GetFileName(path).Equals("OneClickPortal.exe", StringComparison.OrdinalIgnoreCase)) continue;
                    path = Path.GetFullPath(path);
                    var directory = Path.GetDirectoryName(path)!;
                    var isLegacyPreview = Path.GetFileName(directory).StartsWith("publish-test-", StringComparison.OrdinalIgnoreCase)
                        && string.Equals(Path.GetDirectoryName(directory), workspace, StringComparison.OrdinalIgnoreCase);
                    if (isLegacyPreview || string.Equals(path, installedPath, StringComparison.OrdinalIgnoreCase)) existing++;
                }
            }
            if (existing > 0)
            {
                reason = $"기존 설치본 또는 테스트본 {existing}개가 실행 중입니다.";
                mutex.ReleaseMutex();
                mutex.Dispose();
                return null;
            }
            return new PreviewInstanceGuard(mutex);
        }
        catch
        {
            if (acquired) mutex?.ReleaseMutex();
            mutex?.Dispose();
            reason = "기존 프로그램의 실행 상태를 확인하지 못했습니다.";
            return null;
        }
    }

    public void Dispose()
    {
        if (_ownsMutex) { _mutex.ReleaseMutex(); _ownsMutex = false; }
        _mutex.Dispose();
    }

    private static string ResolveWorkspaceRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        for (var level = 0; directory is not null && level < 6; level++, directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "BrowserThumbnailPrototype.csproj")))
                return directory.FullName;
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."));
    }
}
