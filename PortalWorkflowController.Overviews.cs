using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal sealed partial class PortalWorkflowController
{
    private async Task<WorkflowResult> OpenEdufineOverviewAsync(bool approval, CancellationToken cancellationToken)
    {
        var taskName = approval ? "결재" : "예산";
        var jobName = approval ? "업무관리" : "학교회계";
        var topMenu = approval ? "문서관리" : "사업관리";
        var menuNames = approval
            ? new[] { "결재대기", "결재대기문서" }
            : new[] { "사업별예산현황", "사업관리카드(담당)", "사업관리카드(현액)", "사업관리카드" };
        _reportProgress($"{taskName}: K-에듀파인 연결 확인 중");
        var target = await EnsureApplicationTargetAsync(_educationOffice.EdufineDomain, "에듀파인",
            "K-에듀파인", _educationOffice.EdufineUri, cancellationToken);
        await using var session = await DevToolsSession.ConnectAsync(_devToolsPort, target.Id, cancellationToken);
        await WaitForEdufineReadyAsync(session, cancellationToken);
        if ((await ReadEdufineSessionStateAsync(session, cancellationToken)).Expired)
            throw new PortalSessionExpiredException("K-에듀파인", "K-에듀파인에 다시 로그인해 주세요.");
        await session.ActivateTargetAsync(cancellationToken);
        await PrepareActivatedTargetForBackgroundAsync(cancellationToken);
        await TryCloseVisibleEdufineNoticeAsync(session, cancellationToken);
        if (approval)
        {
            var tabExpression = EdufineOverviewTabScript(menuNames);
            _reportProgress("결재: 열려 있는 결재대기 탭 확인 중");
            if (await ClickOverviewElementOnceAsync(session, tabExpression, cancellationToken))
            {
                // The exact, exposed tab caption has already received a native click. Waiting
                // for an unrelated page-shape heuristic only delays showing the selected tab.
                await PrepareBrowserForUserAsync(session, cancellationToken);
                return new WorkflowResult("결재대기 탭을 선택했습니다. 문서 확인과 최종 결재는 직접 진행해 주세요.",
                    KeepActivatedBrowser: true);
            }
        }
        _reportProgress($"{taskName}: {jobName} · {topMenu} 이동 중");
        await SelectEdufineJobAsync(session, jobName, cancellationToken);
        await ClickEdufineTopMenuAsync(session, topMenu, cancellationToken);

        // Only exact, known menu names inside Nexacro's mega menu may be clicked.
        // An in-document "결재", "일괄결재", "저장" or "결재요청" button can never be a candidate.
        var names = JsonSerializer.Serialize(menuNames);
        var menuExpression = $$"""
            (() => {
              const names = {{names}};
              const normalize = value => String(value || '').replace(/\s+/g, '');
              const visible = e => {
                const r = e.getBoundingClientRect(), s = getComputedStyle(e);
                return r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0
                  && s.visibility !== 'hidden' && s.display !== 'none';
              };
              const elements = [...document.querySelectorAll('[id*="pdvMegaMenu"]')].filter(visible);
              for (const name of names) {
                const matches = elements.filter(e => normalize(e.textContent) === name);
                const match = matches.find(e => e.id.endsWith(':text')) || matches.at(-1);
                if (match) return match;
              }
              return null;
            })()
            """;
        _reportProgress(approval ? "결재: 결재대기 목록으로 이동 중" : "예산: 사업별 예산현황 조회로 이동 중");
        await ClickElementCenterAsync(session, menuExpression,
            $"{taskName} 조회 메뉴를 찾지 못했습니다. K-에듀파인의 메뉴 이름과 조회 권한을 확인해 주세요.",
            TimeSpan.FromSeconds(15), cancellationToken);
        if (approval)
        {
            // Show the browser as soon as the safe navigation click completes; the site's
            // grid can continue loading visibly without an extra 5-second readiness gate.
            await PrepareBrowserForUserAsync(session, cancellationToken);
            return new WorkflowResult("결재대기 메뉴를 선택했습니다. 문서 확인과 최종 결재는 직접 진행해 주세요.",
                KeepActivatedBrowser: true);
        }

        _reportProgress("예산: 현재 조회 조건으로 조회 중");
        var queryExpression = EdufineBudgetQueryScript(menuNames);
        var queryAvailable = false;
        try
        {
            // The scoped, enabled query button is the actionable readiness evidence. A second
            // title/grid heuristic previously blocked this step for 25 seconds on a live page.
            await WaitForConditionAsync(session, $"!!({queryExpression})", TimeSpan.FromSeconds(5), cancellationToken);
            queryAvailable = true;
        }
        catch (TimeoutException exception) when (exception is not DevToolsCommandTimeoutException
            && exception.InnerException is null)
        {
            if ((await ReadEdufineSessionStateAsync(session, cancellationToken)).Expired)
                throw new PortalSessionExpiredException("K-에듀파인", "K-에듀파인에 다시 로그인해 주세요.");
            AppLogger.Info("Workflow", "예산: 조회 버튼 자동 확인 대신 열린 화면을 표시합니다.");
        }
        // Dispatch at most once. Never retry after an uncertain click or change search criteria.
        var queried = queryAvailable && await ClickOverviewElementOnceAsync(session, queryExpression, cancellationToken);
        await PrepareBrowserForUserAsync(session, cancellationToken);
        return new WorkflowResult(queried
            ? "현재 조건으로 예산 조회 버튼을 눌렀습니다. 화면에서 조회 결과를 확인해 주세요."
            : "예산 메뉴를 선택했습니다. 조회 버튼을 자동 확인하지 못했으므로 열린 화면에서 조회 결과를 확인해 주세요.",
            KeepActivatedBrowser: true);
    }

    private static async Task<bool> ClickOverviewElementOnceAsync(
        DevToolsSession session, string elementExpression, CancellationToken cancellationToken)
    {
        var expression = "(()=>{const e=(" + elementExpression + ");if(!e)return null;"
            + "const r=e.getBoundingClientRect();let x=r.x,y=r.y,view=e.ownerDocument.defaultView;"
            + "while(view&&view!==window){const frame=view.frameElement;if(!frame)break;"
            + "const rect=frame.getBoundingClientRect();x+=rect.x;y+=rect.y;view=frame.ownerDocument.defaultView;}"
            + "return {x:x+r.width/2,y:y+r.height/2};})()";
        var point = await session.EvaluateAsync(expression, cancellationToken: cancellationToken);
        if (point.ValueKind != JsonValueKind.Object) return false;
        // A transport error after dispatch is deliberately not retried: the click may have landed.
        await session.ClickAsync(point.GetProperty("x").GetDouble(), point.GetProperty("y").GetDouble(), cancellationToken);
        return true;
    }

    internal static string EdufineOverviewTabScript(string[] menuNames)
    {
        return $$"""
            (()=>{
              {{OverviewDomHelpersScript()}}
              const names={{JsonSerializer.Serialize(menuNames)}};
              const matches=[];
              for(const doc of documents){
                const candidates=all(doc).filter(e=>inTaskTabs(e)&&exposed(e)&&enabled(e)
                  &&names.includes(label(e))&&!closingControl(e));
                // Click the caption itself, away from the tab's adjacent close button.
                matches.push(...candidates.filter(e=>!candidates.some(other=>other!==e&&e.contains(other))));
              }
              return matches.length===1?matches[0]:null;
            })()
            """;
    }

    internal static string EdufineBudgetQueryScript(string[] menuNames)
    {
        return $$"""
            (()=>{
              {{OverviewDomHelpersScript()}}
              const names={{JsonSerializer.Serialize(menuNames)}};
              const matches=new Set();
              for(const doc of documents){
                const active=activeScope(doc,names);if(!active)continue;
                const headings=all(active).filter(e=>exposed(e)&&!inNavigation(e)&&names.includes(label(e)));
                for(const heading of headings){
                  for(let scope=heading.parentElement;scope&&scope!==doc.body;scope=scope.parentElement){
                    if(scope!==active&&!active.contains(scope))break;
                    const isForm=scope.getAttribute('role')==='tabpanel'
                      ||/(?:^|\s)Form(?:\s|$)/.test(scope.getAttribute('class')||'')
                      ||/\.form$/.test(String(scope.id||''));
                    if(!isForm)continue;
                    const elements=all(scope).filter(e=>exposed(e)&&!inNavigation(e));
                    if(!elements.some(e=>/^(회계연도|예산현액|예산잔액)[:：]?$/.test(label(e))))continue;
                    const buttons=elements.filter(e=>isButton(e)&&enabled(e)&&!closingControl(e)
                      &&normalize(e.innerText||e.textContent||e.getAttribute('aria-label'))==='조회');
                    const unique=buttons.filter(e=>!buttons.some(other=>other!==e&&e.contains(other)));
                    if(unique.length===1)matches.add(unique[0]);
                    // Never widen a located business form to another page to find a button.
                    break;
                  }
                }
              }
              return matches.size===1?[...matches][0]:null;
            })()
            """;
    }

    internal static string OverviewDomHelpersScript()
    {
        return """
              const normalize=text=>String(text||'').replace(/[\s\u200B-\u200D\uFEFF]/g,'');
              const all=root=>[...root.querySelectorAll('*')];
              const label=e=>normalize([...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('')
                ||e.getAttribute('aria-label'));
              const inTaskTabs=e=>{
                for(let p=e;p;p=p.parentElement)
                  if(/TabFrame|\.tabbutton|\.tabButton/.test(String(p.id||''))
                    ||['tab','tablist'].includes(p.getAttribute('role')))return true;
                return false;
              };
              const inNavigation=e=>{
                for(let p=e;p;p=p.parentElement)
                  if(/pdvMegaMenu|TopFrame|LeftFrame/.test(String(p.id||'')))return true;
                return inTaskTabs(e);
              };
              const visible=e=>{
                if(!e)return false;
                const r=e.getBoundingClientRect();
                if(r.width<=0||r.height<=0||r.right<=0||r.bottom<=0)return false;
                for(let p=e;p;p=p.parentElement){
                  const s=p.ownerDocument.defaultView.getComputedStyle(p);
                  if(p.hidden||p.getAttribute('aria-hidden')==='true'||p.getAttribute('inert')!==null
                    ||s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||s.opacity==='0')return false;
                }
                return true;
              };
              const exposed=e=>{
                if(!visible(e))return false;
                const doc=e.ownerDocument,r=e.getBoundingClientRect();
                if(typeof doc.elementFromPoint!=='function')return false;
                const x=(r.x??r.left??r.right-r.width)+r.width/2;
                const y=(r.y??r.top??r.bottom-r.height)+r.height/2;
                const hit=doc.elementFromPoint(x,y);
                return !!hit&&(hit===e||e.contains(hit)
                  ||(hit!==doc.body&&hit!==doc.documentElement&&hit.contains(e)));
              };
              const enabled=e=>{
                for(let p=e;p;p=p.parentElement){
                  if(p.disabled||p.getAttribute('aria-disabled')==='true'||p.getAttribute('aria-busy')==='true'
                    ||p.getAttribute('enable')==='false'||p.getAttribute('status')==='disabled'
                    ||/(?:^|\s)disabled(?:\s|$)/i.test(p.getAttribute('class')||''))return false;
                }
                return true;
              };
              const closingControl=e=>{
                for(let p=e;p;p=p.parentElement){
                  if(/(?:close|delete|remove|btnSave|btnApproval|btnApprove|btnSubmit)/i.test(String(p.id||''))
                    ||/^(닫기|종료|저장|결재|일괄결재|결재요청)$/.test(normalize(p.getAttribute('aria-label'))))return true;
                }
                return false;
              };
              const isButton=e=>e.tagName==='BUTTON'||e.getAttribute('role')==='button'
                ||(e.tagName==='INPUT'&&e.getAttribute('type')==='button')
                ||/(?:^|\s)Button(?:\s|$)/.test(e.getAttribute('class')||'');
              const selected=e=>e.getAttribute('aria-selected')==='true'||e.getAttribute('userstatus')==='selected'
                ||e.getAttribute('status')==='selected'||/(?:^|\s)(?:selected|active)(?:\s|$)/i.test(e.getAttribute('class')||'');
              const tabGroup=e=>{
                let buttonGroup=null;
                for(let p=e;p;p=p.parentElement){
                  if(p.getAttribute('role')==='tablist')return p;
                  if(/TabFrame/.test(String(p.id||''))&&!/TabFrame/.test(String(p.parentElement?.id||'')))return p;
                  if(/\.tabbutton/i.test(String(p.id||''))&&!/\.tabbutton/i.test(String(p.parentElement?.id||'')))
                    buttonGroup=p.parentElement;
                }
                return buttonGroup||e.parentElement;
              };
              const activeScope=(doc,names)=>{
                const groups=all(doc).filter(e=>inTaskTabs(e)&&visible(e)&&names.includes(label(e))&&!closingControl(e))
                  .map(tabGroup).filter(Boolean);
                const tabs=all(doc).filter(e=>inTaskTabs(e)&&visible(e)&&selected(e)
                  &&groups.some(group=>group.contains(e))
                  &&(e.getAttribute('role')==='tab'||isButton(e)||/\.tabbutton[^.:]*$/i.test(String(e.id||''))));
                const matching=tabs.filter(tab=>names.includes(normalize(tab.innerText||tab.textContent))
                  ||all(tab).some(e=>names.includes(label(e))&&!closingControl(e)));
                if(tabs.length&&!matching.length)return null;
                const panels=matching.map(tab=>doc.getElementById(tab.getAttribute('aria-controls'))).filter(Boolean);
                // Nexacro can give the panel itself zero size while its absolute children render.
                // Descendant exposure and inherited CSS hiding are checked at each candidate.
                if(panels.length===1)return panels[0];
                return doc.body;
              };
              const documents=[];
              const visit=doc=>{
                if(!doc||documents.includes(doc))return;documents.push(doc);
                for(const frame of doc.querySelectorAll('iframe,frame'))
                  if(exposed(frame)){try{visit(frame.contentDocument)}catch{}}
              };
              visit(document);
            """;
    }

    internal static string OverviewReadyScript(string[] menuNames, bool approval)
    {
        return $$"""
            (() => {
              const names = {{JsonSerializer.Serialize(menuNames)}};
              const approval = {{(approval ? "true" : "false")}};
              {{OverviewDomHelpersScript()}}
              return documents.some(doc => {
                const scope=activeScope(doc,names);if(!scope)return false;
                // Exclude navigation labels and old hidden tabs from the readiness evidence.
                const elements = all(scope).filter(e => exposed(e) && !inNavigation(e));
                // Use each component's own text: an outer container must not reintroduce
                // hidden panels or excluded tab captions through its aggregate innerText.
                const labels = elements.map(e => normalize(approval
                  ? ([...e.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('')
                    || e.getAttribute('aria-label'))
                  : e.innerText))
                  .filter(text => text.length > 0 && text.length < 160);
                if (approval) {
                  // Nexacro can render the title and institution suffix as independent labels.
                  // Identify the active page shell, not whether all grid headers/data have loaded.
                  const hasPage = labels.some(text =>
                    names.some(name => text === name || (text.startsWith(name + '(') && /^[^(]+\([^)]*\)$/.test(text)))
                    || text.replace(/[>›/→]/g, '') === '문서관리결재결재대기');
                  const hasSubject = labels.some(text => /^(제목|문서제목)[:：]?$/.test(text));
                  const hasAuthor = labels.some(text => /^기안자(?:\(접수자\))?[:：]?$/.test(text));
                  const columnCount = ['문서종류', '문서유형', '공개여부', '문서번호']
                    .filter(name => labels.some(text => text === name)).length;
                  const hasGrid = elements.some(e => e.getAttribute('role') === 'grid'
                    || /(?:^|\s)Grid(?:\s|$)/.test(e.getAttribute('class') || ''));
                  return hasPage && ((hasSubject && hasAuthor) || hasGrid || columnCount >= 2);
                }
                return names.some(name => labels.some(text => text === name))
                  && labels.some(text => text === '조회')
                  && labels.some(text => /^(회계연도|예산현액|예산잔액)$/.test(text));
              });
            })()
            """;
    }
}
