using System.Runtime.InteropServices;

namespace BrowserThumbnailPrototype;

internal sealed class SystemSleepGuard : IDisposable
{
    private const uint PowerRequestSystemRequired = 0;
    private IntPtr _requestHandle;
    private bool _requestSet;

    public bool TryEnable()
    {
        if (_requestSet) return true;

        var reason = new ReasonContext
        {
            Version = 0,
            Flags = 1,
            SimpleReasonString = "원클릭업무포털 세션 유지",
        };

        _requestHandle = PowerCreateRequest(ref reason);
        if (_requestHandle == IntPtr.Zero || _requestHandle == new IntPtr(-1))
        {
            _requestHandle = IntPtr.Zero;
            AppLogger.Info("WindowsPower", $"자동 절전 방지 요청 생성 실패: {Marshal.GetLastWin32Error()}");
            return false;
        }

        if (!PowerSetRequest(_requestHandle, PowerRequestSystemRequired))
        {
            AppLogger.Info("WindowsPower", $"자동 절전 방지 요청 설정 실패: {Marshal.GetLastWin32Error()}");
            CloseHandle(_requestHandle);
            _requestHandle = IntPtr.Zero;
            return false;
        }

        _requestSet = true;
        AppLogger.Info("WindowsPower", "프로그램 실행 중 자동 절전 방지를 시작했습니다.");
        return true;
    }

    public void Dispose()
    {
        if (_requestHandle == IntPtr.Zero) return;

        if (_requestSet && !PowerClearRequest(_requestHandle, PowerRequestSystemRequired))
        {
            AppLogger.Info("WindowsPower", $"자동 절전 방지 요청 해제 실패: {Marshal.GetLastWin32Error()}");
        }

        CloseHandle(_requestHandle);
        _requestHandle = IntPtr.Zero;
        _requestSet = false;
        AppLogger.Info("WindowsPower", "자동 절전 방지를 종료했습니다.");
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ReasonContext
    {
        public uint Version;
        public uint Flags;
        [MarshalAs(UnmanagedType.LPWStr)]
        public string SimpleReasonString;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr PowerCreateRequest(ref ReasonContext context);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PowerSetRequest(IntPtr powerRequest, uint requestType);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PowerClearRequest(IntPtr powerRequest, uint requestType);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
