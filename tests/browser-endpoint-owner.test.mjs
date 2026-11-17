import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { browserForegroundStub } from './helpers/browser-foreground-fixture.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

test('browser endpoints must belong to the process of the selected window',
  { timeout: 150_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-browser-owner-'));
    try {
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>
          ${['BrowserEndpointOwner.cs', 'DevToolsAutomation.cs', 'BrowserSupport.cs', 'EducationOffice.cs']
            .map(name => `<Compile Include="${xml(resolve(root, name))}" Link="${name}" />`).join('\n')}
        </ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      await writeFile(join(directory, 'BrowserForeground.cs'), browserForegroundStub);
      await run('dotnet', ['build', project, '--configuration', 'Release', '--nologo'],
        { timeout: 90_000, maxBuffer: 1024 * 1024 }).catch(error => {
          assert.fail([error.message, error.stdout, error.stderr].filter(Boolean).join('\n'));
        });
      const assembly = join(directory, 'bin', 'Release', 'net8.0', 'Probe.dll');
      const cases = [
        ['unique', 'selects only the ready port belonging to the selected process'],
        ['absent', 'rejects unrelated, missing, inaccessible and zero process ownership'],
        ['unverified', 'unavailable owner lookup is distinguished from a verified different window'],
        ['ambiguous', 'narrows ambiguous discovery by ownership and still rejects two owned ports'],
        ['preservation', 'preserves noncandidate diagnostics and the original discovery'],
        ['native', 'reads actual Windows loopback and wildcard listener ownership without changing browsers'],
        ['dual-stack', 'verifies an IPv4 connection accepted by a dual-stack listener without guessing IPv6-only ownership'],
        ['protocol-owner', 'reported empty OS table uses a validated browser PID while retaining all mismatch guards'],
        ['owner-logging', 'unverified ownership reports the stage and native result without changing the decision'],
        ['immediate-owner', 'foreground reads prefer native ownership and expire protocol proof before a stable-focus interval'],
      ];
      for (const [scenario, name] of cases) {
        await t.test(name, async () => {
          const result = await run('dotnet', [assembly, scenario],
            { timeout: 15_000, maxBuffer: 1024 * 1024 }).catch(error => {
              assert.fail([error.message, error.stdout, error.stderr].filter(Boolean).join('\n'));
            });
          assert.match(result.stdout, new RegExp('PASS: ' + scenario));
        });
      }
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-browser-owner-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using System.Net;
using System.Net.Sockets;
using BrowserThumbnailPrototype;

var scenario = args.Single();
const uint selectedProcess = 1234;
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
DevToolsPortProbe Port(int port, DevToolsProbeStatus status = DevToolsProbeStatus.Ready) =>
    new(port, status, new[] { "goe" }, "fixture-diagnostic");
DevToolsDiscoveryResult Discovery(params DevToolsPortProbe[] probes) => new(null, probes);

switch (scenario)
{
    case "unique":
        var unique = BrowserEndpointOwner.ForProcess(Discovery(Port(9222), Port(9223)), selectedProcess,
            port => port == 9223 ? selectedProcess : 5678);
        Check(unique.Port == 9223, "The selected process did not choose its own port.");
        Check(unique.Probes[0].Status == DevToolsProbeStatus.WindowMismatch
            && unique.Probes[1].Status == DevToolsProbeStatus.Ready, "Unrelated port remained eligible.");
        Check(unique.Probes.All(probe => probe.SelectedProcessId == selectedProcess)
            && unique.Probes[0].EndpointProcessId == 5678 && unique.Probes[1].EndpointProcessId == selectedProcess,
            "Numeric window and endpoint ownership evidence was discarded.");
        break;

    case "absent":
        foreach (Func<int, uint?> owner in new Func<int, uint?>[] {
            _ => 5678, _ => null, _ => 0, _ => throw new InvalidOperationException("unavailable"),
        })
        {
            var absent = BrowserEndpointOwner.ForProcess(new(9222, new[] { Port(9222) }), selectedProcess, owner);
            Check(absent.Port is null && absent.Probes.Single().Status is
                DevToolsProbeStatus.WindowMismatch or DevToolsProbeStatus.WindowOwnerUnavailable,
                "An unverifiable or unrelated owner authorized a connection.");
        }
        var called = false;
        var noProcess = BrowserEndpointOwner.ForProcess(Discovery(Port(9222)), 0, _ => { called = true; return 0; });
        Check(noProcess.Port is null && !called && noProcess.Probes.Single().Status == DevToolsProbeStatus.WindowOwnerUnavailable,
            "An invalid window process was accepted or triggered an ownership query.");
        break;

    case "ambiguous":
        var input = Discovery(Port(9222, DevToolsProbeStatus.Ambiguous), Port(9223, DevToolsProbeStatus.Ambiguous));
        var narrowed = BrowserEndpointOwner.ForProcess(input, selectedProcess, port => port == 9222 ? selectedProcess : 5678);
        Check(narrowed.Port == 9222 && narrowed.Probes[0].Status == DevToolsProbeStatus.Ready
            && narrowed.Probes[1].Status == DevToolsProbeStatus.WindowMismatch, "Ownership did not resolve discovery ambiguity.");
        var ambiguous = BrowserEndpointOwner.ForProcess(input, selectedProcess, _ => selectedProcess);
        Check(ambiguous.Port is null && ambiguous.Probes.All(probe => probe.Status == DevToolsProbeStatus.Ambiguous),
            "Two channels belonging to the same process were silently guessed.");
        var absentAmbiguous = BrowserEndpointOwner.ForProcess(input, selectedProcess, _ => 5678);
        Check(absentAmbiguous.Port is null && absentAmbiguous.Probes.All(probe => probe.Status == DevToolsProbeStatus.WindowMismatch),
            "Unrelated ambiguous channels remained eligible.");
        break;

    case "unverified":
        foreach (Func<int, uint?> owner in new Func<int, uint?>[] {
            _ => null, _ => 0, _ => throw new InvalidOperationException("unavailable"),
        })
        {
            var result = BrowserEndpointOwner.ForProcess(Discovery(Port(9222)), selectedProcess, owner);
            Check(result.Port is null && result.Probes.Single().Status.ToString() == "WindowOwnerUnavailable",
                "An unavailable owner lookup was incorrectly reported as a different window.");
            Check(result.Probes.Single().SelectedProcessId == selectedProcess
                && result.Probes.Single().EndpointProcessId is null, "Unavailable ownership retained a false endpoint PID.");
        }
        break;

    case "preservation":
        var statuses = Enum.GetValues<DevToolsProbeStatus>().Where(status => status is not
            (DevToolsProbeStatus.Ready or DevToolsProbeStatus.Ambiguous)).ToArray();
        var probes = statuses.Select((status, index) => Port(9300 + index, status)).Append(Port(9222)).ToArray();
        var original = new DevToolsDiscoveryResult(9222, probes);
        var calls = new List<int>();
        var preserved = BrowserEndpointOwner.ForProcess(original, selectedProcess,
            port => { calls.Add(port); return selectedProcess; });
        Check(calls.SequenceEqual(new[] { 9222 }), "Ownership query inspected an ineligible endpoint.");
        Check(preserved.Probes.Take(statuses.Length).SequenceEqual(probes.Take(statuses.Length)), "Existing failure diagnostics changed.");
        Check(original.Port == 9222 && original.Probes.Last().Status == DevToolsProbeStatus.Ready,
            "The original discovery was mutated.");
        Check(preserved.Probes.Last().OfficeCodes.SequenceEqual(new[] { "goe" })
            && preserved.Probes.Last().FailureKind == "fixture-diagnostic", "Port details were discarded.");
        var empty = BrowserEndpointOwner.ForProcess(new(9222, Array.Empty<DevToolsPortProbe>()), selectedProcess,
            _ => throw new Exception("must not be called"));
        Check(empty.Port is null && empty.Probes.Count == 0, "A stale selected port survived empty discovery.");
        break;

    case "native":
        foreach (var invalid in new[] { -1, 0, 65536 })
            Check(BrowserEndpointOwner.FindListeningProcessId(invalid) is null, "Invalid TCP port was accepted.");
        if (!OperatingSystem.IsWindows())
        {
            Check(BrowserEndpointOwner.FindListeningProcessId(9222) is null, "A non-Windows platform did not fail closed.");
            Console.WriteLine("SKIP: actual TCP owner lookup is Windows-only.");
            break;
        }
        foreach (var address in new[] { IPAddress.Loopback, IPAddress.Any })
        {
            using var listener = new TcpListener(address, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            var currentProcess = (uint)Environment.ProcessId;
            Check(BrowserEndpointOwner.FindListeningProcessId(port) == currentProcess,
                "The actual TCP listener did not report the current process: " + address);
            var snapshot = BrowserEndpointOwner.InspectListeningPort(port);
            Check(snapshot.ProcessId == currentProcess && snapshot.Status == "Success"
                && snapshot.SizeQueryResult == 122 && snapshot.ReadResult == 0 && snapshot.MatchingListeners > 0,
                "The diagnostic snapshot lost native lookup evidence.");
            var discovery = new DevToolsDiscoveryResult(port, new[] { Port(port) });
            Check(BrowserEndpointOwner.ForProcess(discovery, currentProcess).Port == port,
                "Native ownership did not authorize its own process: " + address);
            Check(BrowserEndpointOwner.ForProcess(discovery, currentProcess + 1).Port is null,
                "Native ownership authorized a different window process: " + address);
            listener.Stop();
            Check(BrowserEndpointOwner.FindListeningProcessId(port) is null, "A closed listener retained ownership.");
            Check(BrowserEndpointOwner.InspectListeningPort(port).Status == "NoListener",
                "A closed listener was confused with a native query failure.");
        }
        using (var otherLoopback = new TcpListener(IPAddress.Parse("127.0.0.2"), 0))
        {
            otherLoopback.Start();
            Check(BrowserEndpointOwner.FindListeningProcessId(((IPEndPoint)otherLoopback.LocalEndpoint).Port) is null,
                "A listener unreachable through 127.0.0.1 was accepted.");
        }
        break;

    case "dual-stack":
        if (!OperatingSystem.IsWindows() || !Socket.OSSupportsIPv6) break;
        using (var dualListener = new TcpListener(IPAddress.IPv6Any, 0))
        {
            dualListener.Server.DualMode = true;
            dualListener.Start();
            var dualPort = ((IPEndPoint)dualListener.LocalEndpoint).Port;
            var dualOwner = (uint)Environment.ProcessId;
            using var stop = new CancellationTokenSource();
            var accepted = new System.Collections.Concurrent.ConcurrentBag<TcpClient>();
            var accepting = Task.Run(async () => {
                try { while (!stop.IsCancellationRequested) accepted.Add(await dualListener.AcceptTcpClientAsync(stop.Token)); }
                catch (OperationCanceledException) { }
            });
            try
            {
                Check(BrowserEndpointOwner.FindListeningProcessId(dualPort) == dualOwner,
                    "A reachable IPv4 channel backed by a dual-stack listener lost its OS owner.");
                var dualDiscovery = new DevToolsDiscoveryResult(null, [Port(dualPort)]);
                Check(BrowserEndpointOwner.ForProcess(dualDiscovery, dualOwner).Port == dualPort,
                    "The matching dual-stack browser window was rejected.");
                Check(BrowserEndpointOwner.ForProcess(dualDiscovery, dualOwner + 1).Port is null,
                    "A dual-stack endpoint authorized another window process.");
            }
            finally
            {
                stop.Cancel();
                await accepting;
                foreach (var connection in accepted) connection.Dispose();
            }
        }
        using (var ipv6Only = new TcpListener(IPAddress.IPv6Any, 0))
        {
            ipv6Only.Server.DualMode = false;
            ipv6Only.Start();
            var ipv6Port = ((IPEndPoint)ipv6Only.LocalEndpoint).Port;
            Check(BrowserEndpointOwner.FindListeningProcessId(ipv6Port) is null,
                "An IPv6-only socket was guessed as the owner of an IPv4 channel.");
        }
        break;

    case "protocol-owner":
        var missing = new BrowserEndpointOwnerSnapshot(null, "NoListener", 122, 0, 0);
        foreach (var browser in new[] { PortalBrowser.Edge, PortalBrowser.Chrome })
        {
            var nativeCalls = 0;
            var protocolCalls = 0;
            var processChecks = 0;
            Task<uint?> ResolveOwner(int port, PortalBrowser selected, CancellationToken token) =>
                BrowserEndpointOwner.ResolveProcessIdAsync(port, selected,
                    _ => { nativeCalls++; return missing; },
                    (candidate, kind, ct) => { Check(candidate == 9222 && kind == browser, "Wrong protocol port/browser."); protocolCalls++; return Task.FromResult<uint?>(8220); },
                    (pid, kind) => { processChecks++; return pid == 8220 && kind == browser; }, token);
            var reported = await BrowserEndpointOwner.ForProcessAsync(Discovery(Port(9222)), 8220, browser, ResolveOwner);
            Check(reported.Port == 9222 && reported.Probes.Single().EndpointProcessId == 8220,
                "Reported working channel and matching window still failed on an empty OS table.");
            Check(nativeCalls == 2 && protocolCalls == 1 && processChecks == 1, "The protocol owner was not independently rechecked.");
            var wrongWindow = await BrowserEndpointOwner.ForProcessAsync(Discovery(Port(9222)), 14952, browser, ResolveOwner);
            Check(wrongWindow.Port is null && wrongWindow.Probes.Single().Status == DevToolsProbeStatus.WindowMismatch,
                "The other reported Edge window was accepted.");
            var multiple = await BrowserEndpointOwner.ForProcessAsync(Discovery(Port(9222), Port(9223)), 8220, browser,
                (_, _, _) => Task.FromResult<uint?>(8220));
            Check(multiple.Port is null && multiple.Probes.All(probe => probe.Status == DevToolsProbeStatus.Ambiguous),
                "Protocol verification guessed between two owned channels.");
            foreach (var status in new[] { "ReadFailed", "LookupException", "MultipleOwners", "InvalidRowCount", "OwnerUnavailable" })
                Check(await BrowserEndpointOwner.ResolveProcessIdAsync(9222, browser,
                    _ => missing with { Status = status }, (_, _, _) => throw new Exception("Unsafe protocol fallback."), (_, _) => true) is null,
                    "A native query failure or owner conflict authorized fallback.");
            var known = await BrowserEndpointOwner.ResolveProcessIdAsync(9222, browser,
                _ => new(14952, "Success", 122, 0, 1), (_, _, _) => throw new Exception("Known owner replaced by protocol."), (_, _) => true);
            Check(known == 14952, "A verified different native owner was overwritten.");
            foreach (uint? invalid in new uint?[] { null, 0 })
                Check(await BrowserEndpointOwner.ResolveProcessIdAsync(9222, browser, _ => missing,
                    (_, _, _) => Task.FromResult(invalid), (_, _) => throw new Exception("Invalid PID process check.")) is null,
                    "A missing or zero browser PID was accepted.");
            Check(await BrowserEndpointOwner.ResolveProcessIdAsync(9222, browser, _ => missing,
                (_, _, _) => Task.FromResult<uint?>(8220), (_, _) => false) is null, "A wrong/vanished OS browser process was accepted.");
            foreach (var replacement in new[] { new BrowserEndpointOwnerSnapshot(14952, "Success", 122, 0, 1), missing with { Status = "ReadFailed" } })
            {
                var count = 0;
                Check(await BrowserEndpointOwner.ResolveProcessIdAsync(9222, browser, _ => ++count == 1 ? missing : replacement,
                    (_, _, _) => Task.FromResult<uint?>(8220), (_, _) => true) is null, "Ownership changed during protocol verification.");
            }
            var zeroWindow = await BrowserEndpointOwner.ForProcessAsync(Discovery(Port(9222)), 0, browser,
                (_, _, _) => throw new Exception("Zero window inspected a protocol endpoint."));
            Check(zeroWindow.Port is null, "An invalid window was authorized.");
            using var canceled = new CancellationTokenSource();
            canceled.Cancel();
            try
            {
                await BrowserEndpointOwner.ResolveProcessIdAsync(9222, browser,
                    _ => throw new Exception("Lookup after cancellation."), (_, _, _) => throw new Exception("Protocol after cancellation."), (_, _) => true, canceled.Token);
                throw new Exception("Cancellation was swallowed.");
            }
            catch (OperationCanceledException) { }
            using var midFlight = new CancellationTokenSource();
            try
            {
                await BrowserEndpointOwner.ResolveProcessIdAsync(9222, browser, _ => missing,
                    (_, _, _) => { midFlight.Cancel(); return Task.FromResult<uint?>(8220); },
                    (_, _) => throw new Exception("Process check after cancellation."), midFlight.Token);
                throw new Exception("Cancellation during identity verification was swallowed.");
            }
            catch (OperationCanceledException) { }
        }
        break;

    case "owner-logging":
        var noListener = new BrowserEndpointOwnerSnapshot(null, "NoListener", 122, 0, 0);
        var accessFailure = new BrowserEndpointOwnerSnapshot(null, "ReadFailed", 122, 5, 0);
        var changedOwner = new BrowserEndpointOwnerSnapshot(14952, "Success", 122, 0, 1);
        async Task CheckFailure(BrowserEndpointOwnerSnapshot first, BrowserEndpointOwnerSnapshot second,
            uint? protocolOwner, string expectedReason, BrowserEndpointOwnerSnapshot expectedSnapshot)
        {
            var reads = 0;
            var failures = new List<(string, BrowserEndpointOwnerSnapshot)>();
            var owner = await BrowserEndpointOwner.ResolveProcessIdAsync(9222, PortalBrowser.Edge,
                _ => ++reads == 1 ? first : second,
                (_, _, _) => Task.FromResult(protocolOwner), (pid, _) => pid == 8220,
                logFailure: (reason, snapshot) => failures.Add((reason, snapshot)));
            Check(owner is null && failures.SequenceEqual(new[] { (expectedReason, expectedSnapshot) }),
                "Unverified ownership did not retain the specific lookup evidence.");
        }
        await CheckFailure(accessFailure, noListener, 8220, "NativeLookup", accessFailure);
        await CheckFailure(noListener, noListener, null, "ProtocolOwnerUnavailable", noListener);
        await CheckFailure(noListener, noListener, 14952, "ProtocolProcessMismatch", noListener);
        await CheckFailure(noListener, accessFailure, 8220, "NativeRecheck", accessFailure);
        await CheckFailure(noListener, changedOwner, 8220, "OwnerChanged", changedOwner);
        break;

    case "immediate-owner":
        var emptyNative = new BrowserEndpointOwnerSnapshot(null, "NoListener", 122, 0, 0);
        long tick = 1000;
        var refreshes = 0;
        uint? Refresh(int port) { refreshes++; BrowserEndpointOwner.RememberVerifiedOwner(port, 8220, PortalBrowser.Edge, tick); return 8220; }
        uint? Immediate(BrowserEndpointOwnerSnapshot snapshot, bool alive = true) => BrowserEndpointOwner.ReadOwnerForImmediateUse(
            9222, _ => snapshot, Refresh, (pid, browser) => alive && pid == 8220 && browser == PortalBrowser.Edge, () => tick);
        Check(Immediate(emptyNative) == 8220 && refreshes == 1, "An empty table did not obtain fresh protocol proof.");
        tick = 1099;
        Check(Immediate(emptyNative) == 8220 && refreshes == 1, "One native focus burst repeated its protocol request.");
        tick = 1100;
        Check(Immediate(emptyNative) == 8220 && refreshes == 2, "Protocol proof survived the 100ms focus confirmation interval.");
        Check(Immediate(new(14952, "Success", 122, 0, 1)) == 14952, "Cached proof hid a conflicting native owner.");
        Check(Immediate(emptyNative with { Status = "ReadFailed" }) is null && refreshes == 2,
            "A failed native query used cached protocol proof or started another request.");
        BrowserEndpointOwner.RememberVerifiedOwner(9222, 8220, PortalBrowser.Edge, tick);
        Check(Immediate(emptyNative, alive: false) == 8220 && refreshes == 3, "A changed/terminated process retained old proof without refresh.");
        BrowserEndpointOwner.RememberVerifiedOwner(9222, 8220, PortalBrowser.Edge, tick + 1);
        Check(Immediate(emptyNative) == 8220 && refreshes == 4, "A reversed clock retained old protocol proof.");
        break;

    default: throw new Exception("Unknown test scenario.");
}
Console.WriteLine("PASS: " + scenario);

namespace BrowserThumbnailPrototype
{
    internal static class AppLogger
    {
        public static void Info(string area, string message) { }
        public static void Error(string area, string message, Exception exception) { }
    }
}
`;
