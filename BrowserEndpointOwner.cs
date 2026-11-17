using System.Net;
using System.Diagnostics;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace BrowserThumbnailPrototype;

internal sealed record BrowserEndpointOwnerSnapshot(uint? ProcessId, string Status,
    uint? SizeQueryResult = null, uint? ReadResult = null, int MatchingListeners = 0);

internal static class BrowserEndpointOwner
{
    private const uint ErrorInsufficientBuffer = 122;
    private const uint AfInet = 2;
    private const uint TcpTableOwnerPidListener = 3;
    private const uint ListenState = 2;
    private sealed record RecentOwner(uint ProcessId, PortalBrowser Browser, long CapturedAt);
    private static readonly ConcurrentDictionary<int, RecentOwner> RecentOwners = new();

    public static DevToolsDiscoveryResult ForProcess(DevToolsDiscoveryResult discovery, uint processId) =>
        ForProcess(discovery, processId, FindListeningProcessId);

    public static Task<DevToolsDiscoveryResult> ForProcessAsync(DevToolsDiscoveryResult discovery,
        uint processId, PortalBrowser browser, CancellationToken cancellationToken = default) =>
        ForProcessAsync(discovery, processId, browser,
            (port, kind, token) => ResolveProcessIdAsync(port, kind, token, logFailure: true), cancellationToken);

    internal static async Task<DevToolsDiscoveryResult> ForProcessAsync(DevToolsDiscoveryResult discovery,
        uint processId, PortalBrowser browser,
        Func<int, PortalBrowser, CancellationToken, Task<uint?>> resolveOwner,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (processId == 0) return ForProcess(discovery, 0, _ => null);
        var ports = discovery.Probes.Where(probe => probe.Status is DevToolsProbeStatus.Ready or DevToolsProbeStatus.Ambiguous)
            .Select(probe => probe.Port).Distinct().ToArray();
        var resolved = await Task.WhenAll(ports.Select(async port =>
            new KeyValuePair<int, uint?>(port, await resolveOwner(port, browser, cancellationToken))));
        cancellationToken.ThrowIfCancellationRequested();
        var owners = resolved.ToDictionary(entry => entry.Key, entry => entry.Value);
        return ForProcess(discovery, processId, port => owners[port]);
    }

    public static Task<uint?> ResolveProcessIdAsync(int port, PortalBrowser browser,
        CancellationToken cancellationToken = default) =>
        ResolveProcessIdAsync(port, browser, cancellationToken, logFailure: false);

    private static async Task<uint?> ResolveProcessIdAsync(int port, PortalBrowser browser,
        CancellationToken cancellationToken, bool logFailure)
    {
        void LogFailure(string reason, BrowserEndpointOwnerSnapshot snapshot) =>
            AppLogger.Info("BrowserChannel", $"소유자 확인 실패: Port={port}, Browser={BrowserSupport.GetDisplayName(browser)}, "
                + $"Reason={reason}, NativeStatus={snapshot.Status}, SizeQueryResult={snapshot.SizeQueryResult}, "
                + $"ReadResult={snapshot.ReadResult}, MatchingListeners={snapshot.MatchingListeners}");

        var owner = await ResolveProcessIdAsync(port, browser,
            InspectListeningPort, DevToolsDiscovery.ReadBrowserProcessIdAsync, IsBrowserProcess,
            cancellationToken, logFailure ? LogFailure : null);
        if (owner is > 0 && IsBrowserProcess(owner.Value, browser))
            RememberVerifiedOwner(port, owner.Value, browser, Environment.TickCount64);
        else RecentOwners.TryRemove(port, out _);
        return owner;
    }

    // Foreground permission must be granted on the user's synchronous click path.
    // An empty OS table gets a bounded off-thread protocol check; reads in the same
    // native focus burst reuse it for <100 ms, and still check native ownership first.
    public static uint? ReadOwnerForImmediateUse(int port) => ReadOwnerForImmediateUse(port, InspectListeningPort,
        candidate => Task.Run(async () => await ResolveProcessIdAsync(candidate, PortalBrowser.Edge)
            ?? await ResolveProcessIdAsync(candidate, PortalBrowser.Chrome)).GetAwaiter().GetResult(),
        IsBrowserProcess, () => Environment.TickCount64);

    internal static void RememberVerifiedOwner(int port, uint owner, PortalBrowser browser, long capturedAt) =>
        RecentOwners[port] = new(owner, browser, capturedAt);

    internal static uint? ReadOwnerForImmediateUse(int port, Func<int, BrowserEndpointOwnerSnapshot> readNative,
        Func<int, uint?> refreshOwner, Func<uint, PortalBrowser, bool> verifyProcess, Func<long> now)
    {
        if (port is < 1 or > 65535) return null;
        var native = readNative(port);
        if (native.ProcessId is > 0)
        {
            RecentOwners.TryRemove(port, out _);
            return native.ProcessId;
        }
        if (!IsMissingListener(native))
        {
            RecentOwners.TryRemove(port, out _);
            return null;
        }
        if (RecentOwners.TryGetValue(port, out var recent))
        {
            var age = now() - recent.CapturedAt;
            if (age is >= 0 and < 100 && verifyProcess(recent.ProcessId, recent.Browser)) return recent.ProcessId;
            RecentOwners.TryRemove(port, out _);
        }
        return refreshOwner(port);
    }

    internal static async Task<uint?> ResolveProcessIdAsync(int port, PortalBrowser browser,
        Func<int, BrowserEndpointOwnerSnapshot> readNative,
        Func<int, PortalBrowser, CancellationToken, Task<uint?>> readProtocol,
        Func<uint, PortalBrowser, bool> isBrowserProcess, CancellationToken cancellationToken = default,
        Action<string, BrowserEndpointOwnerSnapshot>? logFailure = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (port is < 1 or > 65535) return null;

        uint? Unverified(string reason, BrowserEndpointOwnerSnapshot snapshot)
        {
            logFailure?.Invoke(reason, snapshot);
            return null;
        }

        var native = readNative(port);
        if (native.ProcessId is > 0) return native.ProcessId;
        // Only a successful but empty OS table gets the independent browser check.
        // Access failures, malformed tables and conflicting owners remain unverified.
        if (!IsMissingListener(native)) return Unverified("NativeLookup", native);
        var owner = await readProtocol(port, browser, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (owner is not > 0) return Unverified("ProtocolOwnerUnavailable", native);
        if (!isBrowserProcess(owner.Value, browser)) return Unverified("ProtocolProcessMismatch", native);
        var current = readNative(port);
        if (current.ProcessId is > 0) return current.ProcessId == owner ? owner : Unverified("OwnerChanged", current);
        if (!IsMissingListener(current)) return Unverified("NativeRecheck", current);
        AppLogger.Info("BrowserChannel", $"소유자 확인 보완: Port={port}, Browser={BrowserSupport.GetDisplayName(browser)}, "
            + $"Source=BrowserProtocol, ProcessId={owner}");
        return owner;
    }

    private static bool IsMissingListener(BrowserEndpointOwnerSnapshot snapshot) =>
        snapshot.Status == "NoListener" && snapshot.SizeQueryResult == ErrorInsufficientBuffer
        && snapshot.ReadResult == 0 && snapshot.MatchingListeners == 0;

    private static bool IsBrowserProcess(uint processId, PortalBrowser browser)
    {
        if (processId is 0 or > int.MaxValue) return false;
        try
        {
            using var process = Process.GetProcessById((int)processId);
            return string.Equals(process.ProcessName, BrowserSupport.GetProcessName(browser), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    internal static DevToolsDiscoveryResult ForProcess(DevToolsDiscoveryResult discovery, uint processId,
        Func<int, uint?> readOwner)
    {
        var candidates = discovery.Probes
            .Where(probe => probe.Status is DevToolsProbeStatus.Ready or DevToolsProbeStatus.Ambiguous)
            .ToArray();
        var owners = candidates.Select(probe => probe.Port).Distinct()
            .ToDictionary(port => port, port => processId != 0 ? ReadOwner(port, readOwner) : null);
        var matchingPorts = owners.Where(entry => processId != 0 && entry.Value == processId)
            .Select(entry => entry.Key).ToArray();
        var selectedPort = matchingPorts.Length == 1 ? (int?)matchingPorts[0] : null;
        return new DevToolsDiscoveryResult(selectedPort, discovery.Probes.Select(probe =>
        {
            if (probe.Status is not (DevToolsProbeStatus.Ready or DevToolsProbeStatus.Ambiguous)) return probe;
            return probe with
            {
                SelectedProcessId = processId,
                EndpointProcessId = owners[probe.Port],
                Status = processId == 0 || owners[probe.Port] is null ? DevToolsProbeStatus.WindowOwnerUnavailable
                    : !matchingPorts.Contains(probe.Port) ? DevToolsProbeStatus.WindowMismatch
                    : selectedPort is not null ? DevToolsProbeStatus.Ready : DevToolsProbeStatus.Ambiguous,
            };
        }).ToArray());
    }

    private static uint? ReadOwner(int port, Func<int, uint?> readOwner)
    {
        try
        {
            var owner = readOwner(port);
            return owner is > 0 ? owner : null;
        }
        catch (Exception) { return null; }
    }

    public static uint? FindListeningProcessId(int port) => InspectListeningPort(port).ProcessId;

    internal static BrowserEndpointOwnerSnapshot InspectListeningPort(int port)
    {
        if (!OperatingSystem.IsWindows()) return new(null, "UnsupportedPlatform");
        if (port is < 1 or > 65535) return new(null, "InvalidPort");
        IntPtr table = IntPtr.Zero;
        uint? sizeQueryResult = null;
        uint? readResult = null;
        var matches = 0;
        BrowserEndpointOwnerSnapshot Snapshot(uint? owner, string status) =>
            new(owner, status, sizeQueryResult, readResult, matches);
        try
        {
            uint size = 0;
            var result = GetExtendedTcpTable(IntPtr.Zero, ref size, false, AfInet, TcpTableOwnerPidListener, 0);
            sizeQueryResult = result;
            if (result != ErrorInsufficientBuffer) return Snapshot(null, "SizeQueryFailed");
            if (size < sizeof(uint) || size > int.MaxValue) return Snapshot(null, "InvalidBufferSize");
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var allocatedSize = size;
                table = Marshal.AllocHGlobal((int)allocatedSize);
                result = GetExtendedTcpTable(table, ref size, false, AfInet, TcpTableOwnerPidListener, 0);
                readResult = result;
                if (result == ErrorInsufficientBuffer)
                {
                    Marshal.FreeHGlobal(table);
                    table = IntPtr.Zero;
                    if (size < sizeof(uint) || size > int.MaxValue) return Snapshot(null, "InvalidBufferSize");
                    continue;
                }
                if (result != 0) return Snapshot(null, "ReadFailed");
                if (size < sizeof(uint) || size > allocatedSize) return Snapshot(null, "InvalidBufferSize");
                var count = unchecked((uint)Marshal.ReadInt32(table));
                var rowSize = Marshal.SizeOf<TcpRowOwnerPid>();
                if (count > (size - sizeof(uint)) / rowSize) return Snapshot(null, "InvalidRowCount");
                uint? owner = null;
                for (var index = 0; index < count; index++)
                {
                    var row = Marshal.PtrToStructure<TcpRowOwnerPid>(
                        IntPtr.Add(table, checked(sizeof(uint) + index * rowSize)));
                    var localPort = ((row.LocalPort & 0xff) << 8) | ((row.LocalPort & 0xff00) >> 8);
                    var localAddress = new IPAddress(row.LocalAddress);
                    // Discovery connects to exactly 127.0.0.1, so a listener bound to
                    // another local interface (including 127.0.0.2) cannot own it.
                    if (row.State != ListenState || localPort != port
                        || (!localAddress.Equals(IPAddress.Loopback) && !localAddress.Equals(IPAddress.Any))) continue;
                    matches++;
                    if (row.OwningPid == 0) return Snapshot(null, "OwnerUnavailable");
                    if (owner is not null && owner != row.OwningPid) return Snapshot(null, "MultipleOwners");
                    owner = row.OwningPid;
                }
                return Snapshot(owner, owner is null ? "NoListener" : "Success");
            }
        }
        catch (Exception)
        {
            // A missing or unavailable OS ownership query must never authorize
            // attaching a selected window to another browser process.
            return Snapshot(null, "LookupException");
        }
        finally
        {
            if (table != IntPtr.Zero) Marshal.FreeHGlobal(table);
        }
        return Snapshot(null, "RetryLimit");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TcpRowOwnerPid
    {
        public uint State;
        public uint LocalAddress;
        public uint LocalPort;
        public uint RemoteAddress;
        public uint RemotePort;
        public uint OwningPid;
    }

    [DllImport("iphlpapi.dll", ExactSpelling = true)]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref uint size,
        [MarshalAs(UnmanagedType.Bool)] bool order, uint addressFamily, uint tableClass, uint reserved);
}
