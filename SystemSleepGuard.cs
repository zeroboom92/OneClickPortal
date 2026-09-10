using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;

namespace BrowserThumbnailPrototype;

internal sealed class SystemSleepGuard : IDisposable
{
    private readonly object _sync = new();
    private SafeFileHandle? _requestHandle;
    private bool _requestSet;
    private bool _disposed;

    public bool TryEnable()
    {
        lock (_sync)
        {
            if (_disposed)
            {
                AppLogger.Info("WindowsPower", "종료된 자동 절전 방지 요청은 다시 시작할 수 없습니다.");
                return false;
            }

            if (_requestSet)
            {
                return true;
            }

            var expectedContextSize = IntPtr.Size == 8 ? 32 : 24;
            var actualContextSize = Marshal.SizeOf<ReasonContext>();
            if (actualContextSize != expectedContextSize)
            {
                AppLogger.Info(
                    "WindowsPower",
                    $"REASON_CONTEXT ABI 크기 불일치: actual={actualContextSize}, expected={expectedContextSize}");
                return false;
            }

            var reasonString = Marshal.StringToHGlobalUni("원클릭업무포털 세션 유지");
            try
            {
                var reason = new ReasonContext
                {
                    Version = PowerRequestContextVersion,
                    Flags = PowerRequestContextSimpleString,
                    Reason = new ReasonContextUnion { SimpleReasonString = reasonString },
                };

                var requestHandle = PowerCreateRequest(ref reason);
                if (requestHandle.IsInvalid)
                {
                    var error = Marshal.GetLastWin32Error();
                    requestHandle.Dispose();
                    AppLogger.Info("WindowsPower", $"자동 절전 방지 요청 생성 실패: Win32={error}");
                    return false;
                }

                if (!PowerSetRequest(requestHandle, PowerRequestType.SystemRequired))
                {
                    var error = Marshal.GetLastWin32Error();
                    requestHandle.Dispose();
                    AppLogger.Info("WindowsPower", $"SYSTEM 자동 절전 방지 요청 설정 실패: Win32={error}");
                    return false;
                }

                _requestHandle = requestHandle;
                _requestSet = true;
                AppLogger.Info("WindowsPower", "프로그램 실행 중 SYSTEM 자동 절전 방지 요청을 시작했습니다.");
                return true;
            }
            catch (Exception exception)
            {
                AppLogger.Error("WindowsPower", "자동 절전 방지 요청 초기화 실패", exception);
                return false;
            }
            finally
            {
                Marshal.FreeHGlobal(reasonString);
            }
        }
    }

    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            var requestHandle = _requestHandle;
            _requestHandle = null;
            if (requestHandle is null)
            {
                return;
            }

            if (_requestSet)
            {
                if (PowerClearRequest(requestHandle, PowerRequestType.SystemRequired))
                {
                    AppLogger.Info("WindowsPower", "SYSTEM 자동 절전 방지 요청을 해제했습니다.");
                }
                else
                {
                    AppLogger.Info(
                        "WindowsPower",
                        $"SYSTEM 자동 절전 방지 요청 해제 실패: Win32={Marshal.GetLastWin32Error()}");
                }
            }

            _requestSet = false;
            requestHandle.Dispose();
        }

        GC.SuppressFinalize(this);
    }

    private const uint PowerRequestContextVersion = 0;
    private const uint PowerRequestContextSimpleString = 0x1;

    private enum PowerRequestType
    {
        DisplayRequired = 0,
        SystemRequired = 1,
        AwayModeRequired = 2,
        ExecutionRequired = 3,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ReasonContext
    {
        public uint Version;
        public uint Flags;
        public ReasonContextUnion Reason;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct ReasonContextUnion
    {
        [FieldOffset(0)]
        public DetailedReasonContext Detailed;

        [FieldOffset(0)]
        public IntPtr SimpleReasonString;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DetailedReasonContext
    {
        public IntPtr LocalizedReasonModule;
        public uint LocalizedReasonId;
        public uint ReasonStringCount;
        public IntPtr ReasonStrings;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle PowerCreateRequest(ref ReasonContext context);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PowerSetRequest(SafeFileHandle powerRequest, PowerRequestType requestType);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PowerClearRequest(SafeFileHandle powerRequest, PowerRequestType requestType);
}
