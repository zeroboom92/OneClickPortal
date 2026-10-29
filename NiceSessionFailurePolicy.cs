namespace BrowserThumbnailPrototype;

internal static class NiceSessionFailurePolicy
{
    internal static SessionSystemResult? FromResult(string? result) => result switch
    {
        "Y_RESET_UNAVAILABLE" or "Y_RESET_FAILED" or "Y_RESET_UNCONFIRMED" => new(
            "나이스", SessionSystemState.Failed,
            "나이스 서버는 응답했지만 사용시간 연장을 확인하지 못했습니다. 열린 나이스 화면을 확인해 주세요. 자동 복구를 다시 시도합니다.",
            RequiresAttention: true),
        "BINDING_UNAVAILABLE" or "REQUEST_NOT_TRACKED" => new(
            "나이스", SessionSystemState.Failed,
            "나이스 자동 사용연장을 확인하지 못했습니다. 열린 나이스 화면을 확인해 주세요. 자동 복구를 다시 시도합니다.",
            RequiresAttention: true),
        "IN_FLIGHT_STALE" or "LEGACY_IN_FLIGHT_STALE" => new(
            "나이스", SessionSystemState.Failed,
            "나이스 사용연장 요청이 응답하지 않습니다. 나이스 화면을 확인해 주세요.",
            RequiresAttention: true),
        _ => null
    };
}
