using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal static class EdufineSessionDiagnostics
{
    private static readonly HashSet<string> Results = new(StringComparer.Ordinal)
    {
        "Y", "N", "Y_RECENT", "STARTED", "IN_FLIGHT", "NO_SESSION_METHOD",
        "Y_RESET_UNAVAILABLE", "Y_RESET_FAILED", "Y_RESET_UNCONFIRMED", "Y_TIMER_UNAVAILABLE",
        "REQUEST_EXCEPTION", "REQUEST_NOT_TRACKED", "OWNERSHIP_UNCONFIRMED", "RECOVERY_REQUIRED",
        "LEGACY_IN_FLIGHT", "LEGACY_IN_FLIGHT_STALE", "LEGACY_V3_IN_FLIGHT",
        "LEGACY_V3_RECOVERY_REQUIRED", "ERROR", "UNKNOWN"
    };

    private static readonly HashSet<string> EventCodes = new(StringComparer.Ordinal)
    {
        "TICK", "RESET", "CORRECTION", "TIMER_BINDING_INSTALLED", "TIMER_BINDING_REPAIRED",
        "TIMER_BINDING_FAILED", "STALE_TIMER_SUBTRACTION", "OFFICIAL_TIMER_ZERO",
        "SESSION_BINDING_REPAIRED", "REQUEST_START", "RESPONSE_Y", "RESPONSE_N",
        "RESPONSE_ERROR", "REQUEST_NOT_TRACKED", "WRAPPER_REPLACED", "HANDLER_REBOUND"
    };

    internal static string Script() => """
        (()=>{
          // Read only fixed timer/session properties. Never inspect page contents,
          // locations, target identifiers, user data or function source text.
          const number=value=>typeof value==='number'&&Number.isFinite(value)
            &&Math.abs(value)<=Number.MAX_SAFE_INTEGER?value:null;
          const boolean=value=>typeof value==='boolean'?value:null;
          const choice=(value,allowed)=>typeof value==='string'&&allowed.includes(value)?value:null;
          const result=value=>{
            if(typeof value!=='string')return null;
            if(/^ERROR_-?\d{1,8}$/.test(value))return 'ERROR';
            return choice(value,['Y','N','Y_RECENT','STARTED','IN_FLIGHT','NO_SESSION_METHOD',
              'Y_RESET_UNAVAILABLE','Y_RESET_FAILED','Y_RESET_UNCONFIRMED','Y_TIMER_UNAVAILABLE',
              'REQUEST_EXCEPTION','REQUEST_NOT_TRACKED','OWNERSHIP_UNCONFIRMED','RECOVERY_REQUIRED','LEGACY_IN_FLIGHT',
              'LEGACY_IN_FLIGHT_STALE','LEGACY_V3_IN_FLIGHT','LEGACY_V3_RECOVERY_REQUIRED','ERROR'])||'UNKNOWN';
          };
          const eventCodes=['TICK','RESET','CORRECTION','TIMER_BINDING_INSTALLED',
            'TIMER_BINDING_REPAIRED','TIMER_BINDING_FAILED','STALE_TIMER_SUBTRACTION',
            'OFFICIAL_TIMER_ZERO','SESSION_BINDING_REPAIRED','REQUEST_START','RESPONSE_Y',
            'RESPONSE_N','RESPONSE_ERROR','REQUEST_NOT_TRACKED','WRAPPER_REPLACED','HANDLER_REBOUND'];
          const app=globalThis.nexacro?.getApplication?.()||globalThis.application;
          const gv=app?.gv_topFrame?.form;
          const main=app?.mainframe?.MainVFrameSet?.TopFrame?.form;
          const form=gv||main;
          const baseline=form?.__oneClickTimerBaselineV3;
          const policy=form?.__oneClickSessionPolicyV7;
          const state=globalThis.__oneClickEdufineServerKeepAliveV4;
          const identity=(actual,expected)=>typeof expected==='function'
            ?typeof actual==='function'&&actual===expected:null;
          const text=form?.divTopGrp?.form?.staUseTime?.text;
          let displayRemaining=null;
          if(typeof text==='string'&&text.length<=32&&/^\d+:\d{2}(?::\d{2})?$/.test(text.trim())){
            const parts=text.trim().split(':').map(Number);
            if(parts.every(Number.isFinite)&&parts.slice(1).every(value=>value<60))
              displayRemaining=number(parts.length===2?parts[0]*60+parts[1]
                :parts[0]*3600+parts[1]*60+parts[2]);
          }
          const handlers=form?.ontimer?._user_handlers;
          const known=Array.isArray(handlers);
          const timerMatches=known&&typeof baseline?.timerWrapper==='function'
            ?handlers.filter(entry=>entry?.handler===baseline.timerWrapper&&entry?.target===form).length:null;
          const currentTimerMatches=known&&typeof form?.TopFrame_ontimer==='function'
            ?handlers.filter(entry=>entry?.handler===form.TopFrame_ontimer&&entry?.target===form).length:null;
          const events=Array.isArray(state?.diagnosticEvents)?state.diagnosticEvents.slice(-16)
            .filter(event=>event&&eventCodes.includes(event.code))
            .map(event=>({at:number(event.at),code:event.code,
              remaining:number(event.remaining),requestId:number(event.requestId)})):[];
          return JSON.stringify({schema:1,
            readyState:choice(document.readyState,['loading','interactive','complete']),
            visibility:choice(document.visibilityState,['visible','hidden','prerender']),
            timeOrigin:number(globalThis.performance?.timeOrigin),
            form:{gvPresent:!!gv,mainPresent:!!main,present:!!form,
              aliasesSame:gv&&main?gv===main:null},
            remaining:{display:displayRemaining,internal:number(form?.fv_nowUseEndTime)},
            alive:choice(form?.fv_aliveYn,['Y','N']),
            baseline:{revision:number(baseline?.revision),ready:boolean(baseline?.ready),
              lastTickAt:number(baseline?.lastTickAt),lastResetAt:number(baseline?.lastResetAt),
              resetAt:number(baseline?.resetAt),resetRemaining:number(baseline?.resetRemaining),
              tickCount:number(baseline?.tickCount),correctionCount:number(baseline?.correctionCount),
              lastRawRemaining:number(baseline?.lastRawRemaining),
              lastExpectedRemaining:number(baseline?.lastExpectedRemaining),
              timerIdentity:identity(form?.TopFrame_ontimer,baseline?.timerWrapper),
              resetIdentity:identity(form?.fnResetUseEndCeckTimer,baseline?.resetWrapper)},
            handlers:{known,total:known?number(handlers.length):null,timerMatches,currentTimerMatches,
              duplicates:known?Math.max(timerMatches??0,currentTimerMatches??0)>1:null},
            policy:{sessionCheckIdentity:identity(form?.fnSessionCheck,policy?.sessionCheckWrapper),
              callbackIdentity:identity(form?.fnCallback,policy?.callbackWrapper),
              gfnCallbackIdentity:identity(form?._gfnCallback,policy?.gfnCallbackWrapper)},
            state:{inFlight:boolean(state?.inFlight),startedAt:number(state?.startedAt),
              completedAt:number(state?.completedAt),result:result(state?.result),
              requestSequence:number(state?.requestSequence),diagnosticEvents:events}
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
            if (root.ValueKind != JsonValueKind.Object || Number(root, "schema") != 1)
                return "{\"schema\":1,\"status\":\"INVALID_SCHEMA\"}";

            var form = Object(root, "form");
            var remaining = Object(root, "remaining");
            var baseline = Object(root, "baseline");
            var handlers = Object(root, "handlers");
            var policy = Object(root, "policy");
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
                    events.Add(new { at = Number(entry, "at"), code,
                        remaining = Number(entry, "remaining"), requestId = Number(entry, "requestId") });
                }
            }

            return JsonSerializer.Serialize(new
            {
                schema = 1, status = "OK",
                readyState = Text(root, "readyState", ["loading", "interactive", "complete"]),
                visibility = Text(root, "visibility", ["visible", "hidden", "prerender"]),
                timeOrigin = Number(root, "timeOrigin"),
                form = new { gvPresent = Boolean(form, "gvPresent"), mainPresent = Boolean(form, "mainPresent"),
                    present = Boolean(form, "present"), aliasesSame = Boolean(form, "aliasesSame") },
                remaining = new { display = Number(remaining, "display"), @internal = Number(remaining, "internal") },
                alive = Text(root, "alive", ["Y", "N"]),
                baseline = new { revision = Number(baseline, "revision"), ready = Boolean(baseline, "ready"),
                    lastTickAt = Number(baseline, "lastTickAt"), lastResetAt = Number(baseline, "lastResetAt"),
                    resetAt = Number(baseline, "resetAt"), resetRemaining = Number(baseline, "resetRemaining"),
                    tickCount = Number(baseline, "tickCount"), correctionCount = Number(baseline, "correctionCount"),
                    lastRawRemaining = Number(baseline, "lastRawRemaining"),
                    lastExpectedRemaining = Number(baseline, "lastExpectedRemaining"),
                    timerIdentity = Boolean(baseline, "timerIdentity"), resetIdentity = Boolean(baseline, "resetIdentity") },
                handlers = new { known = Boolean(handlers, "known"), total = Number(handlers, "total"),
                    timerMatches = Number(handlers, "timerMatches"), currentTimerMatches = Number(handlers, "currentTimerMatches"),
                    duplicates = Boolean(handlers, "duplicates") },
                policy = new { sessionCheckIdentity = Boolean(policy, "sessionCheckIdentity"),
                    callbackIdentity = Boolean(policy, "callbackIdentity"), gfnCallbackIdentity = Boolean(policy, "gfnCallbackIdentity") },
                state = new { inFlight = Boolean(state, "inFlight"), startedAt = Number(state, "startedAt"),
                    completedAt = Number(state, "completedAt"), result = Text(state, "result", Results),
                    requestSequence = Number(state, "requestSequence"), diagnosticEvents = events }
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

    private static bool? Boolean(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var child)
            && child.ValueKind is JsonValueKind.True or JsonValueKind.False ? child.GetBoolean() : null;

    private static string? Text(JsonElement value, string name, IReadOnlyCollection<string> allowed) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var child)
            && child.ValueKind == JsonValueKind.String && child.GetString() is { } text
            && allowed.Contains(text) ? text : null;
}
