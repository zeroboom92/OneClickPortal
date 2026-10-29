import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

async function removeProbe(directory, prefix) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith(prefix));
  await rm(directory, { recursive: true, force: true });
}

test('foreground handoff verifies the exact window instead of trusting an activation acknowledgement',
  { timeout: 180_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-browser-foreground-'));
    try {
      const source = await readFile(resolve(root, 'BrowserForeground.cs'), 'utf8');
      await writeFile(join(directory, 'BrowserForeground.cs'), source);
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), coreProbe);
      const project = join(directory, 'Probe.csproj');
      await run('dotnet', ['build', project, '--configuration', 'Release', '--nologo'],
        { timeout: 90_000, maxBuffer: 1024 * 1024 }).catch(error => assert.fail(`${error.stdout || ''}\n${error.stderr || ''}`));
      const assembly = join(directory, 'bin', 'Release', 'net8.0', 'Probe.dll');
      for (const scenario of ['grant', 'read', 'rejected', 'ack-only', 'false-but-confirmed', 'already-foreground',
        'delayed', 'transient', 'owner-changed', 'window-changed', 'cancelled', 'deadline', 'exceptions', 'diagnostics']) {
        await t.test(scenario, async () => {
          const result = await run('dotnet', [assembly, scenario], { timeout: 15_000, maxBuffer: 1024 * 1024 })
            .catch(error => assert.fail(`${error.stdout || ''}\n${error.stderr || ''}`));
          assert.match(result.stdout, new RegExp('PASS: ' + scenario));
        });
      }

      // Reintroduce false success after all foreground requests were refused.
      // Only the temporary source copy changes; the product is untouched.
      const mutant = source.replace('            throw new BrowserForegroundException(ForegroundFailure);\n        }\n        catch',
        '            return;\n        }\n        catch');
      assert.notEqual(mutant, source, 'The sensitivity fixture must replace the final failed handoff.');
      await writeFile(join(directory, 'BrowserForeground.cs'), mutant);
      await assert.rejects(run('dotnet', ['run', '--project', project, '--configuration', 'Release', '--', 'ack-only'],
        { timeout: 30_000, maxBuffer: 1024 * 1024 }), error => {
          assert.match(`${error.stdout || ''}\n${error.stderr || ''}`, /Unconfirmed foreground handoff was reported as success/);
          return true;
        });
    } finally {
      await removeProbe(directory, 'oneclick-browser-foreground-');
    }
  });

test('isolated native WinForms handles retain exact endpoint ownership and fail closed without activating user apps',
  { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-native-foreground-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>${['BrowserForeground.cs', 'BrowserEndpointOwner.cs'].map(name =>
          `<Compile Include="${xml(resolve(root, name))}" Link="${name}" />`).join('\n')}</ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), nativeProbe);
      const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        { timeout: 110_000, maxBuffer: 1024 * 1024 }).catch(error => assert.fail(`${error.stdout || ''}\n${error.stderr || ''}`));
      assert.match(result.stdout, /PASS: native HWND owner, hidden, destroyed, missing owner, cancellation and refused foreground; no native activation calls/);
    } finally {
      await removeProbe(directory, 'oneclick-native-foreground-');
    }
  });

const coreProbe = String.raw`
using BrowserThumbnailPrototype;
static class Program
{
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static async Task Failed(Func<Task> action)
    {
        try { await action(); }
        catch (BrowserForegroundException error)
        {
            Check(!error.Message.Contains("PRIVATE", StringComparison.Ordinal) && error.InnerException is null,
                "Native failure details leaked into the user message.");
            return;
        }
        throw new Exception("Unconfirmed foreground handoff was reported as success.");
    }
    static async Task Main(string[] args)
    {
        var scenario = args.Single();
        var fake = new Fixture();
        switch (scenario)
        {
            case "grant":
                Check(BrowserForeground.GrantToBrowser(11, 9444, "msedge", fake.Context), "Verified browser did not receive foreground permission.");
                Check(fake.Api.Allowed.SequenceEqual(new uint[] { 1234 }), "Permission was not limited to the exact selected owner.");
                foreach (var invalid in new[] { "no-window", "wrong-window-owner", "no-owner", "zero-owner", "any-owner", "wrong-name", "wrong-expected", "bad-expected", "owner-changes" })
                {
                    var sample = new Fixture();
                    string? expected = "msedge";
                    switch (invalid)
                    {
                        case "no-window": sample.Api.Valid = false; break;
                        case "wrong-window-owner": sample.Api.WindowOwner = 9999; break;
                        case "no-owner": sample.Owner = null; break;
                        case "zero-owner": sample.Owner = 0; break;
                        case "any-owner": sample.Owner = uint.MaxValue; sample.Api.WindowOwner = uint.MaxValue; break;
                        case "wrong-name": sample.Api.ProcessName = "PRIVATE_BROWSER"; break;
                        case "wrong-expected": expected = "chrome"; break;
                        case "bad-expected": expected = "PRIVATE_BROWSER"; break;
                        case "owner-changes": sample.OwnerRead = count => count == 1 ? 1234u : 5678u; break;
                    }
                    Check(!BrowserForeground.GrantToBrowser(11, 9444, expected, sample.Context) && sample.Api.Allowed.Count == 0,
                        "Unverified foreground grant was allowed: " + invalid);
                }
                foreach (var port in new[] { -1, 0, 65536 })
                    Check(!BrowserForeground.GrantToBrowser(11, port, "msedge", fake.Context), "Invalid grant port was accepted.");
                foreach (var browserName in new[] { "msedge", "chrome" })
                {
                    fake = new Fixture(); fake.Api.ProcessName = browserName;
                    Check(BrowserForeground.GrantToBrowser(11, 9444, null, fake.Context), "Known browser owner was rejected when no expected name was supplied: " + browserName);
                    Check(fake.Api.Allowed.SequenceEqual(new uint[] { 1234 }), "Unspecified name widened the permission beyond the verified owner.");
                }
                fake = new Fixture(); fake.Api.AllowResult = false;
                Check(!BrowserForeground.GrantToBrowser(11, 9444, "msedge", fake.Context), "Denied permission was reported as granted.");
                break;
            case "read":
                fake.Api.Foreground = 22;
                Check(BrowserForeground.ReadForegroundBrowserWindow(9444, fake.Context) == 22, "Exact visible endpoint-owner window was not returned.");
                foreach (var invalid in new[] { "zero", "invalid", "hidden", "minimized", "wrong-owner", "ambiguous-owner", "owner-changes", "foreground-changes" })
                {
                    var sample = new Fixture(); sample.Api.Foreground = 22;
                    switch (invalid)
                    {
                        case "zero": sample.Api.Foreground = 0; break;
                        case "invalid": sample.Api.Valid = false; break;
                        case "hidden": sample.Api.Visible = false; break;
                        case "minimized": sample.Api.Minimized = true; break;
                        case "wrong-owner": sample.Api.WindowOwner = 9999; break;
                        case "ambiguous-owner": sample.Owner = null; break;
                        case "owner-changes": sample.OwnerRead = count => count == 1 ? 1234u : 5678u; break;
                        case "foreground-changes": sample.Api.ForegroundRead = count => count == 1 ? 22 : 11; break;
                    }
                    Check(BrowserForeground.ReadForegroundBrowserWindow(9444, sample.Context) == 0, "An unconfirmed foreground window escaped validation: " + invalid);
                }
                break;
            case "rejected":
            case "ack-only":
                fake.Api.FocusOnSet = false; fake.Api.SetResult = scenario == "ack-only";
                await Failed(() => fake.Ensure());
                Check(fake.Api.Requested.Count is > 0 and <= 4 && fake.Api.Requested.All(window => window == 22),
                    "Denied activation retried without a bound or selected an unrelated/source window.");
                Check(fake.Now <= 800 && fake.Api.Foreground == 11, "A refusal changed the fixture foreground or exceeded the bounded delay.");
                break;
            case "false-but-confirmed":
                fake.Api.SetResult = false;
                await fake.Ensure();
                Check(fake.Api.Foreground == 22 && fake.DelayCount >= 2, "Actual foreground confirmation was replaced by the API return value.");
                break;
            case "already-foreground":
                fake.Api.Foreground = 22;
                await fake.Ensure();
                Check(fake.Api.Requested.Count == 0 && fake.DelayCount == 1, "An already active target was needlessly activated or not checked across an await.");
                break;
            case "delayed":
                fake.Api.FocusOnSet = false;
                fake.AfterDelay = count => { if (count == 2) fake.Api.Foreground = 22; };
                await fake.Ensure();
                Check(fake.Api.Requested.Count == 2 && fake.DelayCount >= 3 && fake.Api.Foreground == 22,
                    "Delayed focus was not awaited and independently confirmed.");
                break;
            case "transient":
                fake.AfterDelay = count => { if (count == 2) fake.Api.Foreground = 11; };
                await Failed(() => fake.Ensure());
                Check(fake.Api.Requested.Count == 1 && fake.Api.Foreground == 11, "A transient focus flash was accepted or followed by focus stealing.");
                break;
            case "owner-changed":
                fake.AfterDelay = _ => fake.Owner = 5678;
                await Failed(() => fake.Ensure());
                Check(fake.Api.Requested.Count == 1, "A changed endpoint owner was still activated.");
                break;
            case "window-changed":
                foreach (var kind in new[] { "closed", "hidden", "minimized", "reused" })
                {
                    var sample = new Fixture();
                    sample.AfterDelay = _ => { switch (kind) {
                        case "closed": sample.Api.Valid = false; break;
                        case "hidden": sample.Api.Visible = false; break;
                        case "minimized": sample.Api.Minimized = true; break;
                        case "reused": sample.Api.WindowOwner = 5678; break;
                    } };
                    await Failed(() => sample.Ensure());
                    Check(sample.Api.Requested.Count == 1, "Invalid or reused HWND was activated again: " + kind);
                }
                fake.Owner = null;
                await Failed(() => fake.Ensure());
                Check(fake.Api.Requested.Count == 0, "Unknown endpoint ownership caused an activation request.");
                await Failed(() => BrowserForeground.EnsureWindowForegroundAsync(0, 9444, CancellationToken.None, fake.Context));
                break;
            case "cancelled":
                foreach (var before in new[] { true, false })
                {
                    var sample = new Fixture(); using var cancellation = new CancellationTokenSource();
                    if (before) cancellation.Cancel(); else sample.AfterDelay = _ => cancellation.Cancel();
                    try { await sample.Ensure(cancellation.Token); throw new Exception("Cancellation was reported as success."); }
                    catch (OperationCanceledException error) { Check(error.CancellationToken == cancellation.Token, "Cancellation ownership changed."); }
                    Check(sample.Api.Requested.Count == (before ? 0 : 1), "Cancellation permitted another native activation request.");
                }
                break;
            case "deadline":
                fake.Api.FocusOnSet = false;
                fake.AfterDelay = _ => fake.Now = 1000;
                await Failed(() => fake.Ensure());
                Check(fake.Api.Requested.Count == 1, "Elapsed deadline still allowed another activation attempt.");
                fake = new Fixture(); fake.AfterDelay = _ => fake.Now = -1;
                await Failed(() => fake.Ensure());
                break;
            case "exceptions":
                fake.OwnerRead = _ => throw new InvalidOperationException("PRIVATE_OWNER_DATA");
                Check(!BrowserForeground.GrantToBrowser(11, 9444, "msedge", fake.Context), "Ownership exception authorized a grant.");
                Check(BrowserForeground.ReadForegroundBrowserWindow(9444, fake.Context) == 0, "Ownership exception returned a foreground HWND.");
                await Failed(() => fake.Ensure());
                fake = new Fixture(); fake.Api.SetError = new InvalidOperationException("PRIVATE_WINDOW_DATA");
                await Failed(() => fake.Ensure());
                fake = new Fixture(); fake.ThrowOnLog = true;
                await fake.Ensure();
                break;
            case "diagnostics":
                BrowserForeground.GrantToBrowser(11, 9444, "msedge", fake.Context);
                BrowserForeground.ReadForegroundBrowserWindow(9444, fake.Context);
                await fake.Ensure();
                Check(fake.Logs.Count > 0 && fake.Logs.All(message => System.Text.RegularExpressions.Regex.IsMatch(message,
                    @"^(grantValidated=(True|False);grantAllowed=(True|False)|foregroundOwnerMatched=(True|False)|foregroundRequestAccepted=(True|False)|foregroundConfirmed=(True|False))$")),
                    "Foreground diagnostics contain something other than fixed Boolean fields.");
                Check(fake.Logs.All(message => !message.Contains("1234") && !message.Contains("9444") && !message.Contains("PRIVATE")), "Foreground diagnostics leaked identifiers.");
                break;
            default: throw new Exception("Unknown fixture scenario.");
        }
        Console.WriteLine("PASS: " + scenario);
    }
}

sealed class Fixture
{
    internal readonly FakeWindows Api = new();
    internal uint? Owner = 1234;
    internal long Now;
    internal int DelayCount;
    internal int OwnerCount;
    internal Func<int, uint?>? OwnerRead;
    internal Action<int>? AfterDelay;
    internal bool ThrowOnLog;
    internal readonly List<string> Logs = [];
    internal BrowserForeground.Context Context => new(Api,
        _ => OwnerRead is null ? Owner : OwnerRead(++OwnerCount), () => Now,
        (duration, cancellation) => { cancellation.ThrowIfCancellationRequested(); Now += (long)duration.TotalMilliseconds;
            DelayCount++; AfterDelay?.Invoke(DelayCount); cancellation.ThrowIfCancellationRequested(); return Task.CompletedTask; },
        message => { if (ThrowOnLog) throw new Exception("PRIVATE_LOG_ERROR"); Logs.Add(message); });
    internal Task Ensure(CancellationToken cancellation = default) => BrowserForeground.EnsureWindowForegroundAsync(22, 9444, cancellation, Context);
}
sealed class FakeWindows : BrowserForeground.IWindowApi
{
    internal bool Valid = true, Visible = true, Minimized, AllowResult = true, SetResult = true, FocusOnSet = true;
    internal uint WindowOwner = 1234;
    internal string? ProcessName = "msedge";
    internal IntPtr Foreground = 11;
    internal Func<int, IntPtr>? ForegroundRead;
    internal int ReadCount;
    internal Exception? SetError;
    internal readonly List<uint> Allowed = [];
    internal readonly List<IntPtr> Requested = [];
    public bool IsWindow(IntPtr window) => Valid && window != 0;
    public bool IsVisible(IntPtr window) => Visible;
    public bool IsMinimized(IntPtr window) => Minimized;
    public uint ReadProcessId(IntPtr window) => WindowOwner;
    public string? ReadProcessName(uint processId) => ProcessName;
    public IntPtr ReadForeground() => ForegroundRead is null ? Foreground : ForegroundRead(++ReadCount);
    public bool AllowForeground(uint processId) { Allowed.Add(processId); return AllowResult; }
    public bool SetForeground(IntPtr window) { Requested.Add(window); if (SetError is not null) throw SetError;
        if (FocusOnSet) Foreground = window; return SetResult; }
}
namespace BrowserThumbnailPrototype
{
    internal static class BrowserEndpointOwner
    {
        public static uint? FindListeningProcessId(int port) => throw new Exception("Production ownership must not be used by the pure fixture.");
    }
    internal static class AppLogger { public static void Info(string area, string message) => throw new Exception("Production logger must not be used by the pure fixture."); }
}
`;

const nativeProbe = String.raw`
using System.Net;
using System.Net.Sockets;
using System.Drawing;
using System.Windows.Forms;
using BrowserThumbnailPrototype;

static class Program
{
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void Failed(Func<Task> action)
    {
        try { action().GetAwaiter().GetResult(); }
        catch (BrowserForegroundException) { return; }
        throw new Exception("Native unconfirmed handoff was reported as success.");
    }
    [STAThread] static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        Check(port is < 9222 or > 9232, "Fixture must not use a real browser debug port.");
        var owner = BrowserEndpointOwner.FindListeningProcessId(port);
        Check(owner == (uint)Environment.ProcessId, "Actual loopback listener ownership was not established.");
        using var target = new NoActivateFixture();
        using var other = new NoActivateFixture();
        target.Show(); other.Show(); Application.DoEvents();
        var api = new RefusingNativeWindows();
        var targetHandle = target.Handle;
        Check(api.IsWindow(targetHandle) && api.IsVisible(targetHandle) && !api.IsMinimized(targetHandle)
            && api.ReadProcessId(targetHandle) == owner, "Actual fixture HWND identity or native visibility was not established.");
        long now = 0;
        BrowserForeground.Context Context(Func<int, uint?>? ownerReader = null) => new(api,
            ownerReader ?? BrowserEndpointOwner.FindListeningProcessId, () => now,
            (duration, token) => { token.ThrowIfCancellationRequested(); now += (long)duration.TotalMilliseconds; return Task.CompletedTask; },
            _ => { });
        api.Foreground = targetHandle;
        Check(BrowserForeground.ReadForegroundBrowserWindow(port, Context()) == targetHandle,
            "A real visible fixture HWND owned by the real listener was rejected.");
        Check(!BrowserForeground.GrantToBrowser(targetHandle, port, "msedge"), "A fixture process was accepted as an installed browser.");
        Check(BrowserForeground.ReadForegroundBrowserWindow(port, Context(_ => null)) == 0,
            "A missing or ambiguous owner was guessed from the native HWND.");
        Check(BrowserForeground.ReadForegroundBrowserWindow(port, Context(_ => owner + 1)) == 0,
            "A native HWND from another listener owner was accepted.");
        target.Hide();
        Check(BrowserForeground.ReadForegroundBrowserWindow(port, Context()) == 0, "Hidden native HWND was accepted.");
        target.Show(); Application.DoEvents();
        using (var cancellation = new CancellationTokenSource())
        {
            cancellation.Cancel();
            try { BrowserForeground.EnsureWindowForegroundAsync(targetHandle, port, cancellation.Token, Context()).GetAwaiter().GetResult();
                throw new Exception("Native cancellation was reported as success."); }
            catch (OperationCanceledException error) { Check(error.CancellationToken == cancellation.Token, "Native fixture lost caller cancellation."); }
        }
        Check(api.Requests == 0, "Canceled fixture still requested foreground.");
        api.Foreground = other.Handle;
        Failed(() => BrowserForeground.EnsureWindowForegroundAsync(targetHandle, port, CancellationToken.None, Context()));
        Check(api.Requests is > 0 and <= 4 && api.Requested.All(window => window == targetHandle),
            "Native fixture refusal was unbounded or selected the other fixture/source HWND.");
        var requests = api.Requests;
        Failed(() => BrowserForeground.EnsureWindowForegroundAsync(targetHandle, port, CancellationToken.None, Context(_ => null)));
        Check(api.Requests == requests, "Missing/ambiguous owner still caused an activation request.");
        target.Close(); Application.DoEvents();
        Check(!api.IsWindow(targetHandle), "Fixture HWND was not destroyed.");
        Failed(() => BrowserForeground.EnsureWindowForegroundAsync(targetHandle, port, CancellationToken.None, Context()));
        Check(api.Requests == requests && api.AllowCalls == 0, "Destroyed HWND or native fixture issued an unsafe foreground grant.");
        Console.WriteLine("PASS: native HWND owner, hidden, destroyed, missing owner, cancellation and refused foreground; no native activation calls");
    }
}
sealed class NoActivateFixture : Form
{
    internal NoActivateFixture()
    {
        ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
        Location = new Point(-20000, -20000); Size = new Size(8, 8); Text = "";
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
    }
    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams { get { var value = base.CreateParams; value.ExStyle |= 0x08000000; return value; } }
}
sealed class RefusingNativeWindows : BrowserForeground.IWindowApi
{
    readonly BrowserForeground.Win32WindowApi native = new();
    internal IntPtr Foreground;
    internal int Requests, AllowCalls;
    internal readonly List<IntPtr> Requested = [];
    public bool IsWindow(IntPtr window) => native.IsWindow(window);
    public bool IsVisible(IntPtr window) => native.IsVisible(window);
    public bool IsMinimized(IntPtr window) => native.IsMinimized(window);
    public uint ReadProcessId(IntPtr window) => native.ReadProcessId(window);
    public string? ReadProcessName(uint processId) => native.ReadProcessName(processId);
    // Only selection and activation effects are injected. All HWND validity,
    // visibility and PID operations use the production Win32 adapter above.
    public IntPtr ReadForeground() => Foreground;
    public bool AllowForeground(uint processId) { AllowCalls++; throw new Exception("Native activation is forbidden in this fixture."); }
    public bool SetForeground(IntPtr window) { Requests++; Requested.Add(window); return false; }
}
namespace BrowserThumbnailPrototype
{
    internal enum DevToolsProbeStatus { Ready, Ambiguous, WindowMismatch }
    internal sealed record DevToolsPortProbe(int Port, DevToolsProbeStatus Status);
    internal sealed record DevToolsDiscoveryResult(int? Port, IReadOnlyList<DevToolsPortProbe> Probes);
    internal static class AppLogger { public static void Info(string area, string message) { } }
}
`;
