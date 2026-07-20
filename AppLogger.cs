using System.Text;

namespace BrowserThumbnailPrototype;

internal static class AppLogger
{
    private static readonly object SyncRoot = new();

    public static string LogDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OneClickPortal",
        "logs");

    public static string CurrentLogPath => Path.Combine(
        LogDirectory,
        $"oneclickportal-{DateTime.Now:yyyyMMdd}.log");

    public static void Info(string area, string message)
    {
        Write("INFO", area, message, null);
    }

    public static void Error(string area, string message, Exception exception)
    {
        Write("ERROR", area, message, exception);
    }

    private static void Write(string level, string area, string message, Exception? exception)
    {
        try
        {
            Directory.CreateDirectory(LogDirectory);
            var line = new StringBuilder()
                .Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff"))
                .Append(" [").Append(level).Append("] [")
                .Append(Sanitize(area)).Append("] ")
                .Append(Sanitize(message));
            if (exception is not null)
            {
                line.Append(" | ")
                    .Append(exception.GetType().Name)
                    .Append(": ")
                    .Append(Sanitize(exception.Message));
            }

            lock (SyncRoot)
            {
                File.AppendAllText(CurrentLogPath, line.AppendLine().ToString(), Encoding.UTF8);
            }
        }
        catch
        {
            // Logging must never interrupt the user's workflow.
        }
    }

    private static string Sanitize(string value)
    {
        return value.Replace('\r', ' ').Replace('\n', ' ').Trim();
    }
}
