using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal enum ApprovalReadState { Available, PageMissing, MultiplePages, CountUnavailable }
internal sealed record ApprovalCountResult(int? Count, ApprovalReadState State);

internal static class EdufineApprovalReader
{
    public static async Task<ApprovalCountResult> ReadAsync(int port, EducationOffice office,
        CancellationToken cancellationToken, bool fullScan = true)
    {
        var targets = (await DevToolsDiscovery.GetTargetsAsync(port, cancellationToken))
            .Where(target => target.Type == "page"
                && Uri.TryCreate(target.Url, UriKind.Absolute, out var uri)
                && uri.Scheme == Uri.UriSchemeHttps
                && string.Equals(uri.Host, office.EdufineDomain, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        // Multiple open sessions can belong to different accounts. Never guess which count to use.
        if (targets.Length == 0) return new(null, ApprovalReadState.PageMissing);
        if (targets.Length != 1) return new(null, ApprovalReadState.MultiplePages);
        await using var session = await DevToolsSession.ConnectAsync(port, targets[0].Id, cancellationToken);
        await session.ResumeBackgroundPageAsync(cancellationToken);
        var value = await session.EvaluateAsync(CountScript(fullScan), cancellationToken: cancellationToken);
        return value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var count) && count >= 0
            ? new(count, ApprovalReadState.Available) : new(null, ApprovalReadState.CountUnavailable);
    }

    internal static string CountScript(bool fullScan = true)
    {
        return $$"""
            (() => {
              if (document.readyState !== 'complete') return null;
              const fullScan = {{(fullScan ? "true" : "false")}};
              const app = globalThis.nexacro?.getApplication?.() || globalThis.application;
              const topForm = app?.gv_topFrame?.form || app?.mainframe?.MainVFrameSet?.TopFrame?.form;
              const timer = String(topForm?.divTopGrp?.form?.staUseTime?.text || '').trim();
              const internalRemaining = topForm?.fv_nowUseEndTime;
              const hasInternalTime = typeof internalRemaining === 'number' && Number.isFinite(internalRemaining) && internalRemaining > 0;
              if (/^0+:0{2}(?::0{2})?$/.test(timer) && !hasInternalTime) return null;
              const normalize = text => String(text || '').replace(/\s+/g, '').replace(/[\u200B-\u200D\uFEFF]/g, '');
              const visibility = new Map();
              // Nexacro uses absolutely positioned children. A zero-size body/div (or display:contents)
              // can still contain rendered labels, so only CSS hiding is inherited from ancestors.
              const shown = element => {
                if (!element || element.nodeType !== 1) return false;
                if (visibility.has(element)) return visibility.get(element);
                const style = element.ownerDocument.defaultView.getComputedStyle(element);
                const result = !element.hidden && element.getAttribute('aria-hidden') !== 'true'
                  && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
                  && style.opacity !== '0'
                  && (!element.parentElement || shown(element.parentElement));
                visibility.set(element, result);
                return result;
              };
              const visible = element => {
                if (!shown(element)) return false;
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0;
              };
              const documents = [];
              const visit = doc => {
                if (!doc || documents.includes(doc)) return;
                documents.push(doc);
                for (const frame of doc.querySelectorAll('iframe,frame')) {
                  if (!visible(frame)) continue;
                  try { visit(frame.contentDocument); } catch {}
                }
              };
              visit(document);
              const textCache = new Map();
              const visibleText = element => {
                if (textCache.has(element)) return textCache.get(element);
                if (!shown(element) || /^(SCRIPT|STYLE|NOSCRIPT|INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) return '';
                const rect = element.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && (rect.right <= 0 || rect.bottom <= 0)) return '';
                let text = '';
                for (const child of element.childNodes) {
                  if (child.nodeType === 3) text += child.textContent;
                  else if (child.nodeType === 1) text += visibleText(child);
                }
                textCache.set(element, text);
                return text;
              };
              const number = '(\\d{1,3}(?:,\\d{3})+|\\d+)';
              // Urgent is a subset: "결재(긴급) 12(2)" means 12, never 14.
              const patterns = [
                new RegExp('^결재대기(?:문서)?[:：]?\\(?' + number + '\\)?건?$'),
                new RegExp('^결재대기(?:문서)?[:：]?\\[' + number + '\\]건?$'),
                new RegExp('^' + number + '건?결재대기(?:문서)?$'),
                new RegExp('^결재\\(긴급\\)[:：]?' + number + '건?\\(' + number + '\\)건?$')
              ];
              const counts = new Set();
              const headerCounts = new Set();
              // The screenshot's header contains independent approval/urgent/count components
              // alongside 공람/문서진행/etc. Match just the approval segment in that header.
              const headerCounter = new RegExp('결재\\(긴급\\)[:：]?' + number
                + '건?\\(' + number + '\\)건?(?=$|[^\\d,])', 'g');
              const topCounter = new RegExp('^결재[:：]?' + number + '건?$');
              const insideTopFrame = element => {
                for (let current = element; current; current = current.parentElement) {
                  if (String(current.id || '').includes('TopFrame')) return true;
                }
                return false;
              };
              for (const doc of documents) {
                if (doc.readyState !== 'complete') continue;
                const expiredText = text => /사용시간이\s*종료되었습니다|로그아웃되었습니다|로그인이\s*필요합니다/.test(text);
                // Initial/manual/minute reads retain the full-page fallback and logout check.
                // Frequent reads touch only the persistent header and its layout ancestors.
                if (fullScan && expiredText(visibleText(doc.body))) return null;
                const headers = [...doc.querySelectorAll('[id*="TopFrame"]')]
                  .filter(header => !insideTopFrame(header.parentElement));
                for (const header of headers) {
                  const headerText = visibleText(header);
                  if (expiredText(headerText)) return null;
                  const text = normalize(headerText);
                  for (const match of text.matchAll(headerCounter)) {
                    const count = Number(match[1].replace(/,/g, ''));
                    const urgent = Number(match[2].replace(/,/g, ''));
                    if (Number.isSafeInteger(count) && count >= 0 && count <= 2147483647
                      && Number.isSafeInteger(urgent) && urgent >= 0 && urgent <= count) headerCounts.add(count);
                  }
                }
                const candidatesToRead = fullScan
                  ? doc.querySelectorAll('div,span,a,button,label,td,li,p,strong,b')
                  : [...textCache.keys()].filter(element => element.ownerDocument === doc && insideTopFrame(element));
                for (const element of candidatesToRead) {
                  if (!visible(element)) continue;
                  const text = normalize(visibleText(element));
                  if (!text || text.length > 60) continue;
                  // A short "결재 n" counter is allowed only in the persistent top summary.
                  const candidates = insideTopFrame(element) ? [...patterns, topCounter] : patterns;
                  for (const pattern of candidates) {
                    const match = text.match(pattern);
                    if (!match) continue;
                    const count = Number(match[1].replace(/,/g, ''));
                    if (match[2] !== undefined) {
                      const urgent = Number(match[2].replace(/,/g, ''));
                      if (!Number.isSafeInteger(urgent) || urgent < 0 || urgent > count) continue;
                    }
                    if (Number.isSafeInteger(count) && count >= 0 && count <= 2147483647) counts.add(count);
                  }
                }
              }
              if (headerCounts.size) return headerCounts.size === 1 ? [...headerCounts][0] : null;
              return counts.size === 1 ? [...counts][0] : null;
            })()
            """;
    }
}
