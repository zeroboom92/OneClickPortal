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
        ['ambiguous', 'narrows ambiguous discovery by ownership and still rejects two owned ports'],
        ['preservation', 'preserves noncandidate diagnostics and the original discovery'],
        ['native', 'reads actual Windows loopback and wildcard listener ownership without changing browsers'],
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
        break;

    case "absent":
        foreach (Func<int, uint?> owner in new Func<int, uint?>[] {
            _ => 5678, _ => null, _ => 0, _ => throw new InvalidOperationException("unavailable"),
        })
        {
            var absent = BrowserEndpointOwner.ForProcess(new(9222, new[] { Port(9222) }), selectedProcess, owner);
            Check(absent.Port is null && absent.Probes.Single().Status == DevToolsProbeStatus.WindowMismatch,
                "An unverifiable or unrelated owner authorized a connection.");
        }
        var called = false;
        var noProcess = BrowserEndpointOwner.ForProcess(Discovery(Port(9222)), 0, _ => { called = true; return 0; });
        Check(noProcess.Port is null && !called && noProcess.Probes.Single().Status == DevToolsProbeStatus.WindowMismatch,
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
            var discovery = new DevToolsDiscoveryResult(port, new[] { Port(port) });
            Check(BrowserEndpointOwner.ForProcess(discovery, currentProcess).Port == port,
                "Native ownership did not authorize its own process: " + address);
            Check(BrowserEndpointOwner.ForProcess(discovery, currentProcess + 1).Port is null,
                "Native ownership authorized a different window process: " + address);
            listener.Stop();
            Check(BrowserEndpointOwner.FindListeningProcessId(port) is null, "A closed listener retained ownership.");
        }
        using (var otherLoopback = new TcpListener(IPAddress.Parse("127.0.0.2"), 0))
        {
            otherLoopback.Start();
            Check(BrowserEndpointOwner.FindListeningProcessId(((IPEndPoint)otherLoopback.LocalEndpoint).Port) is null,
                "A listener unreachable through 127.0.0.1 was accepted.");
        }
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
