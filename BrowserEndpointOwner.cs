using System.Net;
using System.Runtime.InteropServices;

namespace BrowserThumbnailPrototype;

internal static class BrowserEndpointOwner
{
    private const uint ErrorInsufficientBuffer = 122;
    private const uint AfInet = 2;
    private const uint TcpTableOwnerPidListener = 3;
    private const uint ListenState = 2;

    public static DevToolsDiscoveryResult ForProcess(DevToolsDiscoveryResult discovery, uint processId) =>
        ForProcess(discovery, processId, FindListeningProcessId);

    internal static DevToolsDiscoveryResult ForProcess(DevToolsDiscoveryResult discovery, uint processId,
        Func<int, uint?> readOwner)
    {
        var candidates = discovery.Probes
            .Where(probe => probe.Status is DevToolsProbeStatus.Ready or DevToolsProbeStatus.Ambiguous)
            .ToArray();
        var matchingPorts = candidates.Where(probe => processId != 0 && HasOwner(probe.Port, processId, readOwner))
            .Select(probe => probe.Port).Distinct().ToArray();
        var selectedPort = matchingPorts.Length == 1 ? (int?)matchingPorts[0] : null;
        return new DevToolsDiscoveryResult(selectedPort, discovery.Probes.Select(probe =>
        {
            if (probe.Status is not (DevToolsProbeStatus.Ready or DevToolsProbeStatus.Ambiguous)) return probe;
            return probe with
            {
                Status = !matchingPorts.Contains(probe.Port) ? DevToolsProbeStatus.WindowMismatch
                    : selectedPort is not null ? DevToolsProbeStatus.Ready : DevToolsProbeStatus.Ambiguous,
            };
        }).ToArray());
    }

    private static bool HasOwner(int port, uint processId, Func<int, uint?> readOwner)
    {
        try { return readOwner(port) == processId; }
        catch (Exception) { return false; }
    }

    public static uint? FindListeningProcessId(int port)
    {
        if (!OperatingSystem.IsWindows() || port is < 1 or > 65535) return null;
        IntPtr table = IntPtr.Zero;
        try
        {
            uint size = 0;
            var result = GetExtendedTcpTable(IntPtr.Zero, ref size, false, AfInet, TcpTableOwnerPidListener, 0);
            if (result != ErrorInsufficientBuffer || size < sizeof(uint) || size > int.MaxValue) return null;
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var allocatedSize = size;
                table = Marshal.AllocHGlobal((int)allocatedSize);
                result = GetExtendedTcpTable(table, ref size, false, AfInet, TcpTableOwnerPidListener, 0);
                if (result == ErrorInsufficientBuffer)
                {
                    Marshal.FreeHGlobal(table);
                    table = IntPtr.Zero;
                    if (size < sizeof(uint) || size > int.MaxValue) return null;
                    continue;
                }
                if (result != 0 || size < sizeof(uint) || size > allocatedSize) return null;
                var count = unchecked((uint)Marshal.ReadInt32(table));
                var rowSize = Marshal.SizeOf<TcpRowOwnerPid>();
                if (count > (size - sizeof(uint)) / rowSize) return null;
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
                    if (row.OwningPid == 0 || (owner is not null && owner != row.OwningPid)) return null;
                    owner = row.OwningPid;
                }
                return owner;
            }
        }
        catch (Exception)
        {
            // A missing or unavailable OS ownership query must never authorize
            // attaching a selected window to another browser process.
            return null;
        }
        finally
        {
            if (table != IntPtr.Zero) Marshal.FreeHGlobal(table);
        }
        return null;
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
