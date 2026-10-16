using Microsoft.Win32;
using System.Text;

namespace BrowserThumbnailPrototype;

internal enum EdgePolicyScope
{
    LocalMachine,
    CurrentUser,
}

internal sealed record EdgeChannelPolicySnapshot(
    EdgePolicyScope Scope,
    int? RemoteDebuggingAllowed = null,
    int? DeveloperToolsAvailability = null,
    bool HasDeveloperToolsAllowlist = false,
    bool HasDeveloperToolsBlocklist = false,
    string? ReadFailureKind = null);

internal static class EdgeChannelDiagnostics
{
    private const string PolicyKeyPath = @"SOFTWARE\Policies\Microsoft\Edge";
    private static readonly HashSet<string> SafeFailureKinds = new(StringComparer.Ordinal)
    {
        nameof(HttpRequestException), nameof(TaskCanceledException), nameof(OperationCanceledException),
        nameof(System.Text.Json.JsonException), nameof(InvalidOperationException), nameof(IOException),
        nameof(System.Net.WebSockets.WebSocketException), nameof(System.Net.Sockets.SocketException),
        nameof(TimeoutException), nameof(UriFormatException), nameof(UnauthorizedAccessException),
        nameof(System.Security.SecurityException),
    };

    public static string DescribeFailure(EducationOffice office, DevToolsDiscoveryResult result)
    {
        return DescribeFailure(office, result, ReadPolicies());
    }

    public static string DescribePolicyHints()
    {
        var policies = ReadPolicies();
        LogPolicyObservations(policies);
        return DescribePolicyHints(policies);
    }

    // A supplied snapshot keeps policy interpretation independently testable without
    // changing the user's browser or machine policy.
    internal static string DescribeFailure(EducationOffice office, DevToolsDiscoveryResult result,
        IReadOnlyList<EdgeChannelPolicySnapshot> policies)
    {
        var selectedOffice = EducationOfficeCatalog.GetByCode(office.Code);
        var otherOffices = result.Probes.SelectMany(probe => KnownOffices(probe.OfficeCodes))
            .Where(candidate => candidate.Code != selectedOffice.Code)
            .DistinctBy(candidate => candidate.Code).ToArray();
        LogObservations(selectedOffice, result, policies);

        var message = new StringBuilder("업무포털 자동화 제어 채널을 연결하지 못했습니다.\r\n\r\n");
        var policyHints = DescribePolicyHints(policies);
        if (policyHints.Length > 0) message.AppendLine(policyHints).AppendLine();

        if (otherOffices.Length > 0)
        {
            message.AppendLine($"현재 원클릭의 교육청 설정은 {selectedOffice.Name}입니다.");
            message.AppendLine($"제어 채널에서는 다른 교육청({string.Join(", ", otherOffices.Select(candidate => candidate.Name))})의 업무 화면을 확인했습니다.");
            message.AppendLine("원클릭 설정의 교육청이 로그인한 업무포털과 같은지 확인한 뒤 다시 연결해 주세요.");
        }
        else if (result.Probes.Any(probe => probe.Status == DevToolsProbeStatus.NoPortalTarget))
        {
            message.AppendLine("브라우저 제어 채널은 응답하지만 현재 설정된 교육청의 업무 화면을 찾지 못했습니다.");
            message.AppendLine($"원클릭의 교육청 설정({selectedOffice.Name})을 확인하고, '로그인'으로 연 Edge에서 해당 업무포털에 로그인한 뒤 다시 연결해 주세요.");
        }
        else if (result.Probes.Any(probe => probe.Status == DevToolsProbeStatus.InvalidResponse))
        {
            message.AppendLine("로컬 제어 포트에서 올바른 브라우저 제어 응답을 받지 못했습니다.");
            message.AppendLine("다른 프로그램의 포트 사용이나 로컬 통신 제한 여부를 확인해야 합니다. 원클릭의 '로그인'으로 연 Edge인지 확인해 주세요.");
        }
        else
        {
            message.AppendLine("이 PC의 로컬 브라우저 제어 채널이 응답하지 않습니다.");
            message.AppendLine("Edge 로그인 성공과 제어 채널 연결은 별도로 확인합니다. 원클릭의 '로그인'으로 연 Edge인지 확인해 주세요.");
            message.AppendLine("브라우저 정책, 다른 프로그램의 포트 사용 또는 보안 프로그램의 로컬 통신 제한 여부를 추가로 확인해야 합니다.");
        }

        message.AppendLine();
        message.AppendLine("지원 문의 시 이 안내와 아래 로그 파일을 원클릭 담당자에게 전달해 주세요.");
        message.Append(AppLogger.CurrentLogPath);
        return message.ToString();
    }

    internal static string DescribePolicyHints(IReadOnlyList<EdgeChannelPolicySnapshot> policies)
    {
        var message = new StringBuilder();
        var restrictivePolicies = policies.Where(policy => policy.RemoteDebuggingAllowed == 0
            || policy.DeveloperToolsAvailability == 2).ToArray();
        if (restrictivePolicies.Length > 0)
        {
            message.AppendLine("Edge 정책에서 다음 제한 값이 확인되었습니다.");
            foreach (var policy in restrictivePolicies)
            {
                var scope = ScopeName(policy.Scope);
                if (policy.RemoteDebuggingAllowed == 0)
                    message.AppendLine($"• {scope}: RemoteDebuggingAllowed=0");
                if (policy.DeveloperToolsAvailability == 2)
                    message.AppendLine($"• {scope}: DeveloperToolsAvailability=2");
            }
            message.AppendLine("Edge 주소창에 edge://policy를 입력해 실제 적용된 정책을 확인하고, 기관 전산 담당자에게 문의해 주세요.");
            if (policies.Any(policy => policy.HasDeveloperToolsAllowlist || policy.HasDeveloperToolsBlocklist))
                message.AppendLine("개발자 도구 허용·차단 목록도 있어 사이트별 예외와 정책 우선순위를 함께 확인해야 합니다.");
            else
                message.AppendLine("읽은 레지스트리 값만으로 최종 적용 여부를 확정할 수는 없습니다.");
        }
        if (policies.Any(policy => policy.ReadFailureKind is not null))
            message.AppendLine("일부 Edge 정책은 읽지 못했습니다. edge://policy에서 적용 상태를 확인해 주세요.");
        return message.ToString().TrimEnd();
    }

    private static IReadOnlyList<EdgeChannelPolicySnapshot> ReadPolicies()
    {
        return
        [
            ReadPolicy(Registry.LocalMachine, EdgePolicyScope.LocalMachine),
            ReadPolicy(Registry.CurrentUser, EdgePolicyScope.CurrentUser),
        ];
    }

    private static EdgeChannelPolicySnapshot ReadPolicy(RegistryKey hive, EdgePolicyScope scope)
    {
        try
        {
            using var policy = hive.OpenSubKey(PolicyKeyPath, writable: false);
            return new(scope,
                ReadInteger(policy, "RemoteDebuggingAllowed"),
                ReadInteger(policy, "DeveloperToolsAvailability"),
                HasList(policy, "DeveloperToolsAvailabilityAllowlist"),
                HasList(policy, "DeveloperToolsAvailabilityBlocklist"));
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException
            or System.Security.SecurityException or IOException)
        {
            return new(scope, ReadFailureKind: exception.GetType().Name);
        }
    }

    private static int? ReadInteger(RegistryKey? key, string name)
    {
        return key?.GetValue(name) is int value ? value : null;
    }

    private static bool HasList(RegistryKey? key, string name)
    {
        using var list = key?.OpenSubKey(name, writable: false);
        return list?.ValueCount > 0;
    }

    private static IEnumerable<EducationOffice> KnownOffices(IEnumerable<string> codes)
    {
        return EducationOfficeCatalog.All.Where(office => codes.Contains(office.Code, StringComparer.OrdinalIgnoreCase));
    }

    private static string ScopeName(EdgePolicyScope scope) => scope == EdgePolicyScope.LocalMachine ? "HKLM" : "HKCU";

    private static string SafeFailureKind(string? kind)
    {
        return kind is null ? "None" : SafeFailureKinds.Contains(kind) ? kind : "Other";
    }

    private static void LogObservations(EducationOffice office, DevToolsDiscoveryResult result,
        IReadOnlyList<EdgeChannelPolicySnapshot> policies)
    {
        AppLogger.Info("EdgeChannel", $"제어 채널 확인 실패: 교육청={office.Code}");
        foreach (var probe in result.Probes)
        {
            var status = Enum.IsDefined(probe.Status) ? probe.Status.ToString() : "Unknown";
            var codes = string.Join(",", KnownOffices(probe.OfficeCodes).Select(candidate => candidate.Code));
            AppLogger.Info("EdgeChannel", $"Port={probe.Port}, Status={status}, OfficeCodes={codes}, Failure={SafeFailureKind(probe.FailureKind)}");
        }
        LogPolicyObservations(policies);
    }

    private static void LogPolicyObservations(IReadOnlyList<EdgeChannelPolicySnapshot> policies)
    {
        foreach (var policy in policies)
        {
            AppLogger.Info("EdgeChannel", $"PolicyScope={ScopeName(policy.Scope)}, RemoteDebuggingAllowed={policy.RemoteDebuggingAllowed?.ToString() ?? "unset"}, "
                + $"DeveloperToolsAvailability={policy.DeveloperToolsAvailability?.ToString() ?? "unset"}, "
                + $"DeveloperToolsAvailabilityAllowlistPresent={policy.HasDeveloperToolsAllowlist}, "
                + $"DeveloperToolsAvailabilityBlocklistPresent={policy.HasDeveloperToolsBlocklist}, ReadFailure={SafeFailureKind(policy.ReadFailureKind)}");
        }
    }
}
