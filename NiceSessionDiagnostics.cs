using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal static class NiceSessionDiagnostics
{
    private static readonly HashSet<string> Results = new(StringComparer.Ordinal)
    {
        "Y", "N", "Y_RECENT", "STARTED", "IN_FLIGHT", "NO_JQUERY",
        "REQUEST_TIMEOUT", "REQUEST_ABORTED", "REQUEST_EXCEPTION", "NETWORK_ERROR", "HTTP_ERROR",
        "AUTH_RESPONSE", "UNEXPECTED_RESPONSE", "IN_FLIGHT_STALE",
        "LEGACY_IN_FLIGHT", "LEGACY_IN_FLIGHT_STALE", "BINDING_UNAVAILABLE", "REQUEST_NOT_TRACKED",
        "Y_RESET_UNAVAILABLE", "Y_RESET_FAILED", "Y_RESET_UNCONFIRMED", "UNKNOWN"
    };

    private static readonly HashSet<string> TimerResetResults = new(StringComparer.Ordinal)
    {
        "Y", "Y_RESET_UNAVAILABLE", "Y_RESET_FAILED", "Y_RESET_UNCONFIRMED"
    };

    private static readonly HashSet<string> EventCodes = new(StringComparer.Ordinal)
    {
        "BINDING_INSTALLED", "BINDING_REPAIRED", "BINDING_FAILED", "REQUEST_START", "RESPONSE_Y",
        "RESPONSE_N", "RESPONSE_ERROR", "TIMER_RESET_OK", "TIMER_RESET_UNAVAILABLE",
        "TIMER_RESET_FAILED", "TIMER_RESET_UNCONFIRMED", "REQUEST_NOT_TRACKED"
    };

    internal static string Script() => """
        (()=>{
          // Read fixed state and timer fields only. Do not enumerate page data,
          // inspect credentials or function source, or invoke any session operation.
          const number=value=>typeof value==='number'&&Number.isFinite(value)
            &&Math.abs(value)<=Number.MAX_SAFE_INTEGER?value:null;
          const integer=value=>Number.isSafeInteger(value)?value:null;
          const boolean=value=>typeof value==='boolean'?value:null;
          const choice=(value,allowed)=>typeof value==='string'&&allowed.includes(value)?value:null;
          const results=['Y','N','Y_RECENT','STARTED','IN_FLIGHT','NO_JQUERY','REQUEST_TIMEOUT',
            'REQUEST_ABORTED','REQUEST_EXCEPTION','NETWORK_ERROR','HTTP_ERROR','AUTH_RESPONSE',
            'UNEXPECTED_RESPONSE','IN_FLIGHT_STALE','LEGACY_IN_FLIGHT','LEGACY_IN_FLIGHT_STALE',
            'BINDING_UNAVAILABLE','REQUEST_NOT_TRACKED','Y_RESET_UNAVAILABLE','Y_RESET_FAILED',
            'Y_RESET_UNCONFIRMED','UNKNOWN'];
          const result=value=>typeof value!=='string'?null
            :/^HTTP_\d{3}$/.test(value)?'HTTP_ERROR':choice(value,results)||'UNKNOWN';
          const resetResults=['Y','Y_RESET_UNAVAILABLE','Y_RESET_FAILED','Y_RESET_UNCONFIRMED'];
          const eventCodes=['BINDING_INSTALLED','BINDING_REPAIRED','BINDING_FAILED','REQUEST_START',
            'RESPONSE_Y','RESPONSE_N','RESPONSE_ERROR','TIMER_RESET_OK','TIMER_RESET_UNAVAILABLE',
            'TIMER_RESET_FAILED','TIMER_RESET_UNCONFIRMED','REQUEST_NOT_TRACKED'];
          const state=globalThis.__oneClickNiceServerKeepAliveV3;
          const jquery=globalThis.jQuery||globalThis.$;
          const main=globalThis.voMainApp||globalThis.window?.voMainApp;
          const identity=(actual,expected)=>typeof expected==='function'
            ?typeof actual==='function'&&actual===expected:null;
          const timerSeconds=value=>{
            if(typeof value!=='string'||value.length>32)return null;
            const match=/^(\d+)분\s*(\d{1,2})초$/.exec(value.trim());
            if(!match||Number(match[2])>=60)return null;
            return integer(Number(match[1])*60+Number(match[2]));
          };
          let remaining=null;
          try{
            const timer=typeof main?.lookup==='function'&&!main.disposed?main.lookup('optTime'):null;
            remaining=timerSeconds(timer?.value)??timerSeconds(timer?.text);
          }catch{}
          if(remaining===null&&typeof document.querySelectorAll==='function'){
            try{
              const timers=Array.from(document.querySelectorAll('[id$="optTime"],[aria-label="세션 종료 시간"]'));
              if(timers.length>0&&timers.length<=4){
                const values=timers.map(timer=>timerSeconds(timer.innerText??timer.textContent));
                if(values.every(value=>value!==null&&value===values[0]))remaining=values[0];
              }
            }catch{}
          }
          const events=Array.isArray(state?.diagnosticEvents)?state.diagnosticEvents.slice(-16)
            .filter(event=>event&&eventCodes.includes(event.code))
            .map(event=>({at:integer(event.at),code:event.code,
              remaining:integer(event.remaining),requestId:integer(event.requestId)})):[];
          return JSON.stringify({schema:1,
            readyState:choice(document.readyState,['loading','interactive','complete']),
            visibility:choice(document.visibilityState,['visible','hidden','prerender']),
            timeOrigin:number(globalThis.performance?.timeOrigin),
            main:{present:!!main,disposed:boolean(main?.disposed)},
            remaining:{display:remaining},
            binding:{jqueryPresent:!!jquery,ajaxIdentity:identity(jquery?.ajax,jquery?.__oneClickAjaxWrapperV3),
              originalIdentity:identity(jquery?.ajax,jquery?.__oneClickOriginalAjaxV3)},
            state:{inFlight:boolean(state?.inFlight),startedAt:integer(state?.startedAt),
              completedAt:integer(state?.completedAt),result:result(state?.result),reported:boolean(state?.reported),
              requestSequence:integer(state?.requestSequence),requestId:integer(state?.requestId),
              ownerSource:choice(state?.ownerSource,['program','site']),serverResult:result(state?.serverResult),
              timerResetResult:choice(state?.timerResetResult,resetResults),timerResetAt:integer(state?.timerResetAt),
              diagnosticEvents:events}
          });
        })()
        """;

    internal static string Format(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return "{\"schema\":1,\"status\":\"EMPTY\"}";
        if (json.Length > 32768) return "{\"schema\":1,\"status\":\"TOO_LARGE\"}";
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 12 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || Integer(root, "schema") != 1)
                return "{\"schema\":1,\"status\":\"INVALID_SCHEMA\"}";

            var main = Object(root, "main");
            var remaining = Object(root, "remaining");
            var binding = Object(root, "binding");
            var state = Object(root, "state");
            var events = new List<object>();
            if (state.ValueKind == JsonValueKind.Object
                && state.TryGetProperty("diagnosticEvents", out var eventArray)
                && eventArray.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in eventArray.EnumerateArray().TakeLast(16))
                {
                    var code = Text(entry, "code", EventCodes);
                    if (code is null) continue;
                    events.Add(new { at = Integer(entry, "at"), code,
                        remaining = Integer(entry, "remaining"), requestId = Integer(entry, "requestId") });
                }
            }

            return JsonSerializer.Serialize(new
            {
                schema = 1, status = "OK",
                readyState = Text(root, "readyState", ["loading", "interactive", "complete"]),
                visibility = Text(root, "visibility", ["visible", "hidden", "prerender"]),
                timeOrigin = Number(root, "timeOrigin"),
                main = new { present = Boolean(main, "present"), disposed = Boolean(main, "disposed") },
                remaining = new { display = Integer(remaining, "display") },
                binding = new { jqueryPresent = Boolean(binding, "jqueryPresent"),
                    ajaxIdentity = Boolean(binding, "ajaxIdentity"), originalIdentity = Boolean(binding, "originalIdentity") },
                state = new { inFlight = Boolean(state, "inFlight"), startedAt = Integer(state, "startedAt"),
                    completedAt = Integer(state, "completedAt"), result = Result(state, "result"),
                    reported = Boolean(state, "reported"), requestSequence = Integer(state, "requestSequence"),
                    requestId = Integer(state, "requestId"), ownerSource = Text(state, "ownerSource", ["program", "site"]),
                    serverResult = Result(state, "serverResult"), timerResetResult = Text(state, "timerResetResult", TimerResetResults),
                    timerResetAt = Integer(state, "timerResetAt"), diagnosticEvents = events }
            });
        }
        catch (JsonException)
        {
            return "{\"schema\":1,\"status\":\"INVALID_JSON\"}";
        }
    }

    private static JsonElement Object(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var child)
            && child.ValueKind == JsonValueKind.Object ? child : default;

    private static double? Number(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var child)
            && child.ValueKind == JsonValueKind.Number && child.TryGetDouble(out var number)
            && double.IsFinite(number) && Math.Abs(number) <= 9007199254740991 ? number : null;

    private static long? Integer(JsonElement value, string name)
    {
        var number = Number(value, name);
        return number.HasValue && Math.Truncate(number.Value) == number.Value ? (long)number.Value : null;
    }

    private static bool? Boolean(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var child)
            && child.ValueKind is JsonValueKind.True or JsonValueKind.False ? child.GetBoolean() : null;

    private static string? Text(JsonElement value, string name, IReadOnlyCollection<string> allowed) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var child)
            && child.ValueKind == JsonValueKind.String && child.GetString() is { } text
            && allowed.Contains(text) ? text : null;

    private static string? Result(JsonElement value, string name)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(name, out var child)
            || child.ValueKind != JsonValueKind.String || child.GetString() is not { } text) return null;
        if (text.Length == 8 && text.StartsWith("HTTP_", StringComparison.Ordinal)
            && text.AsSpan(5).IndexOfAnyExceptInRange('0', '9') < 0) return "HTTP_ERROR";
        return Results.Contains(text) ? text : null;
    }
}
