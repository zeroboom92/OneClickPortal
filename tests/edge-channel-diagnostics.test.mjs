import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

test('Edge channel policy inspection has no registry write or browser termination path', async () => {
  const source = await readFile(resolve(root, 'EdgeChannelDiagnostics.cs'), 'utf8');
  assert.doesNotMatch(source, /\.(?:SetValue|CreateSubKey|DeleteValue|DeleteSubKey|DeleteSubKeyTree|Kill)\s*\(/);
  assert.doesNotMatch(source, /writable:\s*true/);
  assert.match(source, /OpenSubKey\(PolicyKeyPath, writable: false\)/);
});

test('actual Edge channel failure diagnostics with isolated policy snapshots',
  { timeout: 120_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-edge-channel-diagnostics-'));
    try {
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><NoWarn>CA1416</NoWarn></PropertyGroup>
        <ItemGroup>
          <Compile Include="${xml(resolve(root, 'EdgeChannelDiagnostics.cs'))}" Link="EdgeChannelDiagnostics.cs" />
          <Compile Include="${xml(resolve(root, 'EducationOffice.cs'))}" Link="EducationOffice.cs" />
        </ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      try {
        await run('dotnet', ['build', project, '--configuration', 'Release', '--nologo'],
          { timeout: 80_000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        throw new Error(error.stdout + error.stderr, { cause: error });
      }
      const assembly = join(directory, 'bin', 'Release', 'net8.0', 'Probe.dll');
      const cases = [
        ['policy-block', 'reports exact policy names, read values and scopes without assuming effective policy'],
        ['developer-overrides', 'developer tool restrictions retain allowlist and blocklist qualification'],
        ['other-office', 'reports only known education offices and guides the user to the office setting'],
        ['no-portal', 'distinguishes a working channel without the selected portal page'],
        ['invalid-response', 'distinguishes incompatible endpoint responses from an absent channel'],
        ['unreachable', 'does not diagnose a successful certificate login as a login failure'],
        ['privacy', 'diagnostic logs reject arbitrary office codes, exception text, URLs and secrets'],
        ['policy-read-failure', 'policy read failures remain actionable without aborting diagnostics'],
        ['policy-hints', 'standalone policy hints never diagnose an already discovered channel as absent'],
      ];
      for (const [scenario, name] of cases) {
        await t.test(name, async () => {
          const result = await run('dotnet', [assembly, scenario], { timeout: 15_000, maxBuffer: 1024 * 1024 });
          assert.ok(result.stdout.includes('PASS: ' + scenario), result.stdout);
        });
      }
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-edge-channel-diagnostics-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;

void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
var scenario = args.Single();
var office = EducationOfficeCatalog.GetByCode("jbe");
DevToolsDiscoveryResult Result(DevToolsProbeStatus status, string[]? codes = null, string? error = null) =>
    new(null, new[] { new DevToolsPortProbe(9222, status, codes ?? [], error) });
string Describe(DevToolsDiscoveryResult result, params EdgeChannelPolicySnapshot[] policies) =>
    EdgeChannelDiagnostics.DescribeFailure(office, result, policies);
string message;

if (scenario == "policy-block")
{
    message = Describe(Result(DevToolsProbeStatus.Unreachable),
        new(EdgePolicyScope.LocalMachine, RemoteDebuggingAllowed: 0),
        new(EdgePolicyScope.CurrentUser, DeveloperToolsAvailability: 2));
    Check(message.Contains("HKLM: RemoteDebuggingAllowed=0") && message.Contains("HKCU: DeveloperToolsAvailability=2"), "Exact restrictive values and scopes were lost.");
    Check(message.Contains("edge://policy") && message.Contains("기관 전산 담당자"), "Policy guidance is missing.");
    Check(message.Contains("확정할 수는 없습니다"), "A registry observation was treated as an effective policy decision.");
    Check(AppLogger.Lines.Any(line => line.Contains("PolicyScope=HKLM, RemoteDebuggingAllowed=0")), "Machine policy was not logged.");
}
else if (scenario == "developer-overrides")
{
    foreach (var allow in new[] { false, true })
    {
        message = Describe(Result(DevToolsProbeStatus.Unreachable),
            new(EdgePolicyScope.LocalMachine, DeveloperToolsAvailability: 2),
            new(EdgePolicyScope.CurrentUser, HasDeveloperToolsAllowlist: allow, HasDeveloperToolsBlocklist: !allow));
        Check(message.Contains("사이트별 예외") && message.Contains("정책 우선순위"), "An allowlist or blocklist was ignored across policy scopes.");
        Check(!message.Contains("정책으로 차단되었습니다"), "DeveloperToolsAvailability=2 was declared an unconditional block.");
    }
    message = Describe(Result(DevToolsProbeStatus.Unreachable),
        new EdgeChannelPolicySnapshot(EdgePolicyScope.LocalMachine, RemoteDebuggingAllowed: 1, DeveloperToolsAvailability: 1));
    Check(!message.Contains("제한 값이 확인"), "Permissive policy values became restrictions.");
}
else if (scenario == "other-office")
{
    message = Describe(Result(DevToolsProbeStatus.NoPortalTarget, ["goe", "GNE", "goe", "secret-office"]));
    Check(message.Contains("설정은 전북") && message.Contains("경기, 경남"), "Actual known office mismatch was not explained.");
    Check(message.Contains("원클릭 설정의 교육청"), "Office setting recovery instruction is missing.");
    Check(!message.Contains("secret-office"), "An unknown office code escaped into the UI.");
    Check(AppLogger.Lines.Any(line => line.Contains("OfficeCodes=goe,gne")), "Office codes were not canonicalized.");
}
else if (scenario == "no-portal")
{
    message = Describe(Result(DevToolsProbeStatus.NoPortalTarget));
    Check(message.Contains("제어 채널은 응답하지만") && message.Contains("업무 화면을 찾지 못했습니다"), "A channel without a portal was described as unreachable.");
    Check(message.Contains("교육청 설정(전북)"), "Selected office was not included in recovery guidance.");
}
else if (scenario == "invalid-response")
{
    message = Describe(Result(DevToolsProbeStatus.InvalidResponse, error: "JsonException"));
    Check(message.Contains("올바른 브라우저 제어 응답") && message.Contains("다른 프로그램의 포트 사용"), "Incompatible endpoint guidance is missing.");
    Check(AppLogger.Lines.Any(line => line.Contains("Status=InvalidResponse") && line.Contains("Failure=JsonException")), "Safe failure type was not logged.");
}
else if (scenario == "unreachable")
{
    message = Describe(Result(DevToolsProbeStatus.Unreachable, error: "TaskCanceledException"));
    Check(message.Contains("로컬 브라우저 제어 채널이 응답하지 않습니다"), "Unreachable endpoint was not reported.");
    Check(message.Contains("Edge 로그인 성공과 제어 채널 연결은 별도로 확인"), "Login success was confused with channel readiness.");
    Check(message.Contains("보안 프로그램의 로컬 통신 제한"), "Local transport investigation is missing.");
}
else if (scenario == "privacy")
{
    const string secret = "PRIVATE_TOKEN_ABC";
    const string url = "https://jbe.eduptl.kr/private?token=" + secret;
    const string title = "학생개인정보 PRIVATE_TITLE";
    message = Describe(Result((DevToolsProbeStatus)900, [url, title, "goe"], "JsonException: " + url),
        new EdgeChannelPolicySnapshot(EdgePolicyScope.CurrentUser, ReadFailureKind: "SecurityException: " + secret));
    var output = message + string.Join("\n", AppLogger.Lines);
    foreach (var forbidden in new[] { secret, url, title, "JsonException: ", "SecurityException: " })
        Check(!output.Contains(forbidden), "Sensitive arbitrary text was included in diagnostics.");
    Check(AppLogger.Lines.Any(line => line.Contains("Status=Unknown") && line.Contains("Failure=Other")), "Unknown diagnostic fields were not reduced to safe labels.");
    Check(AppLogger.Lines.All(line => !line.Contains(AppLogger.CurrentLogPath)), "The diagnostic log should not repeat the user's file path.");
}
else if (scenario == "policy-read-failure")
{
    message = Describe(Result(DevToolsProbeStatus.Unreachable),
        new EdgeChannelPolicySnapshot(EdgePolicyScope.LocalMachine, ReadFailureKind: "UnauthorizedAccessException"));
    Check(message.Contains("일부 Edge 정책은 읽지 못했습니다") && message.Contains("edge://policy"), "Policy read failure was silent or prevented recovery instructions.");
    Check(AppLogger.Lines.Any(line => line.Contains("ReadFailure=UnauthorizedAccessException")), "Policy read error type was not recorded.");
}
else if (scenario == "policy-hints")
{
    var hints = EdgeChannelDiagnostics.DescribePolicyHints(new[] {
        new EdgeChannelPolicySnapshot(EdgePolicyScope.LocalMachine, RemoteDebuggingAllowed: 0),
    });
    Check(hints.Contains("RemoteDebuggingAllowed=0") && hints.Contains("edge://policy"), "Standalone hints lost policy details.");
    Check(!hints.Contains("채널") && !hints.Contains("로그인"), "Standalone hints declared a transport or login failure.");
    Check(EdgeChannelDiagnostics.DescribePolicyHints(Array.Empty<EdgeChannelPolicySnapshot>()) == "", "Absent policies should add no generic hints.");
    Check(EdgeChannelDiagnostics.DescribePolicyHints(new[] {
        new EdgeChannelPolicySnapshot(EdgePolicyScope.CurrentUser, RemoteDebuggingAllowed: 1, DeveloperToolsAvailability: 1),
    }) == "", "Permissive policies should add no generic hints.");
    message = Describe(Result(DevToolsProbeStatus.Unreachable));
}
else throw new Exception("Unknown diagnostic scenario.");

Check(message.EndsWith(AppLogger.CurrentLogPath), "The support log path is missing.");
Check(message.Contains("원클릭 담당자에게 전달"), "The support handoff instruction is missing.");
Console.WriteLine("PASS: " + scenario);

namespace BrowserThumbnailPrototype
{
    internal enum DevToolsProbeStatus { Ready, NoPortalTarget, Unreachable, InvalidResponse }
    internal sealed record DevToolsPortProbe(int Port, DevToolsProbeStatus Status, IReadOnlyList<string> OfficeCodes, string? FailureKind = null);
    internal sealed record DevToolsDiscoveryResult(int? Port, IReadOnlyList<DevToolsPortProbe> Probes);
    internal static class AppLogger
    {
        public static string CurrentLogPath => @"C:\support\oneclickportal-test.log";
        public static List<string> Lines { get; } = [];
        public static void Info(string area, string message) => Lines.Add(area + ": " + message);
    }
}
`;
