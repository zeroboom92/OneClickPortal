using System.IO.Pipes;
using System.Text;

namespace BrowserThumbnailPrototype;

/// <summary>
/// 같은 Windows 사용자 세션에서 프로그램을 하나만 실행하고,
/// 두 번째 실행의 업무 요청을 기존 창으로 전달합니다.
/// </summary>
internal sealed class SingleInstanceCoordinator : IDisposable
{
    private const string ActivateMessage = "activate";
    private static readonly string InstanceKey = BuildInstanceKey();
    private static readonly string MutexName = $@"Local\OneClickPortal.SingleInstance.{InstanceKey}";
    private static readonly string PipeName = $"OneClickPortal.Request.{InstanceKey}";

    private readonly Mutex _mutex;
    private readonly CancellationTokenSource _cancellation = new();
    private Task? _listenerTask;
    private bool _disposed;

    private SingleInstanceCoordinator(Mutex mutex)
    {
        _mutex = mutex;
    }

    public static bool TryAcquire(out SingleInstanceCoordinator? coordinator)
    {
        Mutex? mutex = null;
        try
        {
            mutex = new Mutex(initiallyOwned: true, MutexName, out var createdNew);
            if (!createdNew)
            {
                mutex.Dispose();
                coordinator = null;
                return false;
            }

            coordinator = new SingleInstanceCoordinator(mutex);
            return true;
        }
        catch (Exception exception)
        {
            AppLogger.Error("SingleInstance", "중복 실행 잠금을 만들지 못했습니다.", exception);
            mutex?.Dispose();
            coordinator = null;
            return true;
        }
    }

    public static bool TrySendToRunningInstance(PortalTaskKind? taskKind)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(3000);
            using var writer = new StreamWriter(client, new UTF8Encoding(false)) { AutoFlush = true };
            writer.WriteLine(taskKind is null
                ? ActivateMessage
                : PortalTaskCatalog.GetExternalName(taskKind.Value));
            return true;
        }
        catch (Exception exception)
        {
            AppLogger.Error("SingleInstance", "실행 중인 창으로 요청을 전달하지 못했습니다.", exception);
            return false;
        }
    }

    public void StartListening(Action<PortalTaskKind?> onRequest)
    {
        ArgumentNullException.ThrowIfNull(onRequest);
        _listenerTask = Task.Run(() => ListenAsync(onRequest, _cancellation.Token));
    }

    private static async Task ListenAsync(
        Action<PortalTaskKind?> onRequest,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                using var server = new NamedPipeServerStream(
                    PipeName,
                    PipeDirection.In,
                    maxNumberOfServerInstances: 1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);
                await server.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);

                using var reader = new StreamReader(server, new UTF8Encoding(false));
                var message = (await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false))?.Trim();
                if (string.IsNullOrEmpty(message))
                {
                    continue;
                }

                if (string.Equals(message, ActivateMessage, StringComparison.OrdinalIgnoreCase))
                {
                    onRequest(null);
                }
                else if (PortalTaskCatalog.TryGetByExternalName(message, out var taskKind))
                {
                    onRequest(taskKind);
                }
                else
                {
                    AppLogger.Info("SingleInstance", $"알 수 없는 외부 업무 요청을 무시했습니다: {message}");
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception exception)
            {
                AppLogger.Error("SingleInstance", "외부 업무 요청을 받는 중 오류가 발생했습니다.", exception);
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        try
        {
            _cancellation.Cancel();
            _listenerTask?.Wait(TimeSpan.FromSeconds(2));
        }
        catch (Exception exception)
        {
            AppLogger.Error("SingleInstance", "외부 업무 요청 수신을 정리하는 중 오류가 발생했습니다.", exception);
        }
        finally
        {
            _cancellation.Dispose();
            try
            {
                _mutex.ReleaseMutex();
            }
            catch (ApplicationException)
            {
                // 잠금을 이미 잃은 경우에는 종료 정리만 계속합니다.
            }

            _mutex.Dispose();
        }
    }

    private static string BuildInstanceKey()
    {
        var userName = Environment.UserName;
        var builder = new StringBuilder(userName.Length);
        foreach (var character in userName)
        {
            builder.Append(char.IsLetterOrDigit(character) ? character : '_');
        }

        return builder.Length == 0 ? "user" : builder.ToString();
    }
}
