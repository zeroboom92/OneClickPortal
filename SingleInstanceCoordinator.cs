using System.IO.Pipes;
using System.Text;

namespace BrowserThumbnailPrototype;

/// <summary>
/// 프로그램이 한 번만 실행되도록 하고, 두 번째 실행이 넘긴 요청을
/// 이미 떠 있는 창으로 전달합니다.
///
/// 이 장치가 필요한 이유는 URI(<c>oneclickportal://leave</c>)로 요청이 들어올 때
/// 윈도우가 매번 새 프로세스를 띄우기 때문입니다. 새 프로세스는 요청만 넘기고 곧바로 종료합니다.
///
/// 이름 있는 파이프는 컴퓨터 전체에서 공유되므로, 여러 사용자가 쓰는 PC에서 섞이지 않도록
/// 이름에 사용자 이름을 함께 넣습니다.
/// </summary>
internal sealed class SingleInstanceCoordinator : IDisposable
{
    /// <summary>업무 요청이 아니라 "창만 앞으로 가져와 달라"는 뜻입니다.</summary>
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

    /// <summary>
    /// 이 프로세스가 첫 번째 실행이면 <c>true</c>를 돌려줍니다.
    /// <c>false</c>이면 이미 다른 창이 떠 있다는 뜻입니다.
    /// </summary>
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
            // 잠금을 만들지 못하면 중복 실행을 막지 못할 뿐이므로, 평소처럼 실행되도록 둡니다.
            AppLogger.Error("SingleInstance", "중복 실행 잠금을 만들지 못했습니다.", exception);
            mutex?.Dispose();
            coordinator = null;
            return true;
        }
    }

    /// <summary>
    /// 이미 실행 중인 창에 요청을 넘깁니다. <paramref name="taskKind"/>가 <c>null</c>이면
    /// 창을 앞으로 가져오라는 뜻만 전달합니다.
    /// 전달에 실패하면 <c>false</c>를 돌려주며, 이때 호출한 쪽은 평소처럼 새로 실행하면 됩니다.
    /// </summary>
    public static bool TrySendToRunningInstance(PortalTaskKind? taskKind)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(3000);

            var message = taskKind is null
                ? ActivateMessage
                : ResolveExternalName(taskKind.Value);

            using var writer = new StreamWriter(client, new UTF8Encoding(false)) { AutoFlush = true };
            writer.WriteLine(message);
            return true;
        }
        catch (Exception exception)
        {
            AppLogger.Error("SingleInstance", "실행 중인 창으로 요청을 전달하지 못했습니다.", exception);
            return false;
        }
    }

    /// <summary>
    /// 다른 실행이 넘기는 요청을 받기 시작합니다.
    /// <paramref name="onRequest"/>는 파이프를 읽는 백그라운드 스레드에서 호출되므로,
    /// 화면을 건드리는 쪽에서 UI 스레드로 옮겨야 합니다.
    /// </summary>
    public void StartListening(Action<PortalTaskKind?> onRequest)
    {
        ArgumentNullException.ThrowIfNull(onRequest);
        _listenerTask = Task.Run(() => ListenAsync(onRequest, _cancellation.Token));
    }

    private static async Task ListenAsync(Action<PortalTaskKind?> onRequest, CancellationToken cancellationToken)
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
                else if (PortalTaskCatalog.TryGetByExternalName(message, out var kind))
                {
                    onRequest(kind);
                }
                else
                {
                    AppLogger.Info("SingleInstance", $"알 수 없는 요청을 무시했습니다: {message}");
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception exception)
            {
                AppLogger.Error("SingleInstance", "요청을 받는 중 오류가 발생했습니다.", exception);

                // 곧바로 다시 시도하면 오류가 반복될 수 있어 잠시 쉬었다가 재시도합니다.
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

    private static string ResolveExternalName(PortalTaskKind taskKind)
    {
        foreach (var descriptor in PortalTaskCatalog.All)
        {
            if (descriptor.Kind == taskKind)
            {
                return descriptor.ExternalName;
            }
        }

        return taskKind.ToString();
    }

    private static string BuildInstanceKey()
    {
        var userName = Environment.UserName;
        var builder = new StringBuilder(userName.Length);
        foreach (var character in userName)
        {
            // 파이프·뮤텍스 이름에 쓸 수 없는 문자를 걸러 냅니다.
            builder.Append(char.IsLetterOrDigit(character) ? character : '_');
        }

        return builder.Length == 0 ? "user" : builder.ToString();
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
            AppLogger.Error("SingleInstance", "요청 수신을 정리하는 중 오류가 발생했습니다.", exception);
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
                // 이 스레드가 잠금을 갖고 있지 않은 경우로, 정리 시점에는 문제가 되지 않습니다.
            }

            _mutex.Dispose();
        }
    }
}
