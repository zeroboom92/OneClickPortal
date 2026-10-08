import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

const source = fs.readFileSync(new URL('../EdufineApprovalReader.cs', import.meta.url), 'utf8');
const script = source.split('internal static string CountScript')[1].split('return $$"""')[1].split('""";')[0];
const countScript = fullScan => script.replace('{{(fullScan ? "true" : "false")}}', String(fullScan));

// Minimal rendered DOM fixture: text nodes, nested labels, frames and computed visibility.
const text = value => ({ nodeType: 3, textContent: value });
function element(children = [], options = {}) {
  return {
    nodeType: 1, tagName: 'DIV', childNodes: children.map(c => typeof c === 'string' ? text(c) : c),
    hidden: false, style: { display: 'block', visibility: 'visible', opacity: '1' },
    getAttribute(name) { return this[name] ?? null; },
    getBoundingClientRect() { return { width: 120, height: 24, right: 200, bottom: 100 }; },
    get innerText() { return this.childNodes.map(c => c.nodeType === 3 ? c.textContent : c.innerText).join(''); },
    get textContent() { return this.innerText; },
    contains(other) {
      for (let current = other; current; current = current.parentElement) if (current === this) return true;
      return false;
    },
    querySelectorAll() {
      const descendants = [];
      const visit = e => { for (const child of e.childNodes) if (child.nodeType === 1) { descendants.push(child); visit(child); } };
      visit(this); return descendants;
    },
    closest() {
      for (let e = this; e; e = e.parentElement)
        if (/pdvMegaMenu|TopFrame|LeftFrame|TabFrame|\.tabbutton|\.tabButton/.test(e.id || '')
          || ['tab', 'tablist'].includes(e.role)) return e;
      return null;
    },
    ...options,
  };
}
function page(children, metrics = null) {
  const body = element(children);
  const all = [];
  let probedElement = null;
  const document = {
    readyState: 'complete', body,
    getElementById: id => all.find(e => e.id === id) || null,
    // By default fixtures are exposed; coveredBy simulates a different foreground page.
    elementFromPoint: () => probedElement?.coveredBy || probedElement,
    defaultView: { getComputedStyle: e => { if (metrics) metrics.styles++; return e.style; } },
    querySelectorAll(selector) {
      if (metrics) metrics.selectors.push(selector);
      if (selector === 'iframe,frame') return all.filter(e => e.tagName === 'IFRAME');
      if (selector === '[id*="TopFrame"]') return all.filter(e => String(e.id || '').includes('TopFrame'));
      return all;
    },
  };
  function attach(e, parent) {
    e.ownerDocument = document;
    e.parentElement = parent;
    all.push(e);
    const originalRect = e.getBoundingClientRect.bind(e);
    e.getBoundingClientRect = () => { if (metrics) metrics.rects++; probedElement = e; return originalRect(); };
    for (const child of e.childNodes) if (child.nodeType === 1) attach(child, e);
  }
  attach(body, null);
  return document;
}
const read = (document, extra = {}, fullScan = true) => vm.runInNewContext(countScript(fullScan), { document, ...extra }, { timeout: 1000 });
const readFast = (document, extra = {}) => vm.runInNewContext(countScript(false), { document, ...extra }, { timeout: 1000 });
const card = (label, value) => element([element([label]), element([value])]);

test('reads a label and its numeric siblings, including zero and grouped thousands', () => {
  for (const [value, expected] of [['7건', 7], ['0', 0], ['1,234건', 1234], ['(12)', 12], ['[12]', 12]]) {
    assert.equal(read(page([card('결재대기 문서', value)])), expected);
  }
});

test('urgent count is a subset of the approval total', () => {
  assert.equal(read(page([card('결재(긴급)', '12(2)')])), 12);
  assert.equal(read(page([card('결재 ( 긴급 )', '0 (0)')])), 0);
});

function screenshotHeader(total = '5', urgent = '0') {
  // Anonymized screenshot text; independent Nexacro components share one header parent.
  return element([
    element(['결재']), element(['(긴급)']), element([total]), element(['(' + urgent + ')']),
    element(['공람']), element(['216']), element(['문서진행']), element(['6']),
    element(['발송대기']), element(['0']), element(['메모(긴급)']), element(['0(0)']), element(['메일']), element(['0']),
  ], { id: 'mainframe.MainVFrameSet.TopFrame.form.divTopGrp' });
}

test('screenshot header reads 5 approvals among separate sibling counters, never 216 or 6', () => {
  assert.equal(read(page([screenshotHeader()])), 5);
  assert.equal(read(page([screenshotHeader('12', '2')])), 12);
  assert.equal(read(page([screenshotHeader('0', '0')])), 0);
});

test('fast polling reads only the verified top header, including zero and separate sibling labels', () => {
  for (const [total, urgent] of [['5', '0'], ['12', '2'], ['0', '0'], ['1,234', '2']]) {
    assert.equal(readFast(page([screenshotHeader(total, urgent), card('결재대기', '99')])), Number(total.replace(',', '')));
  }
  assert.equal(readFast(page([card('결재대기', '5')])), null);
  assert.equal(read(page([card('결재대기', '5')])), 5);
  assert.equal(readFast(page([element([card('결재', '7')], { id: 'TopFrame' })])), 7);
});

test('fast polling rejects conflicting, hidden, invalid urgent and expired top counters', () => {
  assert.equal(readFast(page([screenshotHeader('5'), screenshotHeader('6')])), null);
  assert.equal(readFast(page([element([screenshotHeader('99')], { hidden: true }), screenshotHeader()])), 5);
  assert.equal(readFast(page([screenshotHeader('5', '6')])), null);
  const header = screenshotHeader();
  header.childNodes.push(element(['사용시간이 종료되었습니다']));
  assert.equal(readFast(page([header])), null);
  const application = { mainframe: { MainVFrameSet: { TopFrame: { form: {
    divTopGrp: { form: { staUseTime: { text: '0:00' } } },
  } } } } };
  assert.equal(readFast(page([screenshotHeader()]), { application }), null);
  const loading = page([screenshotHeader()]);
  loading.readyState = 'loading';
  assert.equal(readFast(loading), null);
});

test('fast polling follows visible same-origin frames but does not fall back to their document lists', () => {
  const frame = element([], { tagName: 'IFRAME', contentDocument: page([screenshotHeader()]) });
  assert.equal(readFast(page([frame])), 5);
  frame.hidden = true;
  assert.equal(readFast(page([frame])), null);
  frame.hidden = false;
  frame.contentDocument = page([card('결재대기', '8')]);
  assert.equal(readFast(page([frame])), null);
  assert.equal(read(page([frame])), 8);
});

test('large synthetic DOM: fast polling avoids full-page style and layout reads', t => {
  // Synthetic work-list DOM, not a browser or live-site benchmark. Timing is diagnostic;
  // the stable regression assertions concern style/rectangle reads and query scope.
  const metrics = { styles: 0, rects: 0, selectors: [] };
  const rows = Array.from({ length: 4000 }, (_, row) => element(
    Array.from({ length: 6 }, (_, column) => element([`목록 ${row} 항목 ${column}`]))));
  const document = page([screenshotHeader(), element(rows)], metrics);
  const measure = reader => {
    const times = [];
    let calls;
    for (let attempt = 0; attempt < 5; attempt++) {
      metrics.styles = 0;
      metrics.rects = 0;
      metrics.selectors = [];
      const start = performance.now();
      assert.equal(reader(document), 5);
      times.push(performance.now() - start);
      calls = { styles: metrics.styles, rects: metrics.rects, selectors: [...metrics.selectors] };
    }
    return { ...calls, milliseconds: times.sort((a, b) => a - b)[2] };
  };
  const full = measure(read);
  const fast = measure(readFast);
  assert.ok(full.styles > 28000);
  assert.ok(full.rects > 56000);
  assert.ok(fast.styles < 30);
  assert.ok(fast.rects < 40);
  assert.ok(fast.selectors.every(selector => ['iframe,frame', '[id*="TopFrame"]'].includes(selector)));
  t.diagnostic(`Synthetic 4,000-row/24,000-cell DOM, median of 5: full ${full.milliseconds.toFixed(2)} ms, `
    + `${full.styles} style/${full.rects} rect calls; fast ${fast.milliseconds.toFixed(2)} ms, `
    + `${fast.styles} style/${fast.rects} rect calls. Not live-browser measurements.`);
});

test('screenshot header total remains authoritative when a filtered list reports fewer results', () => {
  assert.equal(read(page([screenshotHeader(), element(['총 5건 / 조회 2건'])])), 5);
  assert.equal(read(page([screenshotHeader(), card('결재대기', '2')])), 5);
});

test('conflicting visible header counters are unknown, hidden previous headers are ignored', () => {
  assert.equal(read(page([screenshotHeader('5'), screenshotHeader('6')])), null);
  assert.equal(read(page([element([screenshotHeader('99')], { hidden: true }), screenshotHeader()])), 5);
});

test('urgent greater than total cannot be recovered through the standalone counter fallback', () => {
  assert.equal(read(page([screenshotHeader('5', '6')])), null);
  assert.equal(read(page([element([card('결재(긴급)', '5(6)')], { id: 'TopFrame' })])), null);
});

test('header extraction does not scan document prose for an embedded counter', () => {
  const header = screenshotHeader();
  header.id = 'work.documentBody';
  assert.equal(read(page([header])), null);
});

test('does not mistake a receipt count, menu label, date or unrelated number for approval count', () => {
  for (const fixture of [
    [card('접수대기', '7')],
    [element(['결재대기']), element(['2026년 10월 8일'])],
    [element(['결재대기']), card('발송대기', '12')],
    [card('결재완료', '33')],
    [card('결재', '33')],
    [element(['결재대기 문서 5건 조회 결과 총 90건'])],
  ]) assert.equal(read(page(fixture)), null);
});

test('rejects negatives, malformed grouping, fractions and overflow', () => {
  for (const value of ['-1', '1.5', '1,2', '12,34', '2147483648', '99999999999999999', '']) {
    assert.equal(read(page([card('결재대기', value)])), null);
  }
});

test('deduplicates nested DOM copies and refuses conflicting counters', () => {
  assert.equal(read(page([element([card('결재대기', '4')]), card('결재(긴급)', '4(1)')])), 4);
  assert.equal(read(page([card('결재대기', '4'), card('결재대기', '5')])), null);
});

test('hidden ancestors and hidden text cannot supply a stale badge', () => {
  const hiddenCard = card('결재대기', '99');
  assert.equal(read(page([element([hiddenCard], { hidden: true }), card('결재대기', '3')])), 3);
  const fakeNumber = element(['99'], { style: { display: 'none', visibility: 'visible', opacity: '1' } });
  assert.equal(read(page([element([element(['결재대기']), fakeNumber])])), null);
  assert.equal(read(page([element([card('결재대기', '8')], { 'aria-hidden': 'true' })])), null);
});

test('absolutely positioned summary remains readable inside a zero-size body and wrapper', () => {
  const zeroBox = () => ({ width: 0, height: 0, right: 0, bottom: 0 });
  const wrapper = element([card('결재대기 문서', '7건')], { getBoundingClientRect: zeroBox });
  const document = page([wrapper]);
  document.body.getBoundingClientRect = zeroBox;
  assert.equal(read(document), 7);
  wrapper.style.display = 'none';
  assert.equal(read(document), null);
});

test('display:contents ancestors do not hide a rendered counter', () => {
  const wrapper = element([card('결재(긴급)', '12(2)')], {
    style: { display: 'contents', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => ({ width: 0, height: 0, right: 0, bottom: 0 }),
  });
  assert.equal(read(page([wrapper])), 12);
});

test('plain approval counter is accepted only inside the top summary, never a document action', () => {
  const summary = element([card('결재', '5')], { id: 'mainframe.MainVFrameSet.TopFrame.summary' });
  assert.equal(read(page([summary])), 5);
  assert.equal(read(page([card('결재', '5')])), null);
});

test('off-screen and transparent counters cannot override the displayed total', () => {
  const old = card('결재대기', '99');
  old.getBoundingClientRect = () => ({ width: 50, height: 20, right: -10, bottom: 100 });
  assert.equal(read(page([old, card('결재대기', '3')])), 3);
  old.getBoundingClientRect = () => ({ width: 50, height: 20, right: 100, bottom: 100 });
  old.style.opacity = '0';
  assert.equal(read(page([old, card('결재대기', '3')])), 3);
});

test('reads a visible same-origin frame and skips hidden or inaccessible frames', () => {
  const frame = element([], { tagName: 'IFRAME', contentDocument: page([card('결재대기', '6')]) });
  assert.equal(read(page([frame])), 6);
  frame.hidden = true;
  assert.equal(read(page([frame])), null);
  const crossOrigin = element([], { tagName: 'IFRAME' });
  Object.defineProperty(crossOrigin, 'contentDocument', { get() { throw new Error('cross origin'); } });
  assert.equal(read(page([crossOrigin, card('결재대기', '2')])), 2);
});

test('loading, logout and zero session timer invalidate an otherwise valid counter', () => {
  const document = page([card('결재대기', '5')]);
  document.readyState = 'loading';
  assert.equal(read(document), null);
  for (const message of ['사용시간이 종료되었습니다', '로그아웃되었습니다', '로그인이 필요합니다']) {
    assert.equal(read(page([card('결재대기', '5'), element([message])])), null);
  }
  const application = { mainframe: { MainVFrameSet: { TopFrame: { form: {
    divTopGrp: { form: { staUseTime: { text: '0:00' } } },
  } } } } };
  assert.equal(read(page([card('결재대기', '5')]), { application }), null);
});

const overviewSource = fs.readFileSync(new URL('../PortalWorkflowController.Overviews.cs', import.meta.url), 'utf8');
test('count reader uses the current renewal frame and tolerates its zero display pending a timer tick', () => {
  const current = { fv_nowUseEndTime: 1200, divTopGrp: { form: { staUseTime: { text: '0:00' } } } };
  const old = { fv_nowUseEndTime: 0, divTopGrp: { form: { staUseTime: { text: '0:00' } } } };
  const application = { gv_topFrame: { form: current }, mainframe: { MainVFrameSet: { TopFrame: { form: old } } } };
  for (const fullScan of [true, false]) {
    assert.equal(read(page([screenshotHeader()]), { application }, fullScan), 5);
    current.fv_nowUseEndTime = 0;
    assert.equal(read(page([screenshotHeader()]), { application }, fullScan), null);
    current.fv_nowUseEndTime = 1200;
    assert.equal(read(page([screenshotHeader(), element(['사용시간이 종료되었습니다'])]), { application }, true), null);
  }
});
const menuScript = overviewSource.split('var menuExpression = $$"""')[1].split('""";')[0];
function findMenu(names, elements) {
  return vm.runInNewContext(menuScript.replace('{{names}}', JSON.stringify(names)), {
    document: { querySelectorAll: selector => elements.filter(e => e.id.includes('pdvMegaMenu')) },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  });
}
const menu = (id, textContent) => ({
  id, textContent, getBoundingClientRect: () => ({ x: 10, y: 10, width: 80, height: 20 }),
});

test('approval routing selects only the exact menu and never final approval controls', () => {
  const target = menu('pdvMegaMenu.approval:text', '결재 대기');
  assert.equal(findMenu(['결재대기', '결재대기문서'], [
    menu('work.btnApprove', '결재'), menu('pdvMegaMenu.bulk:text', '일괄결재'),
    menu('work.result', '결재대기'), target,
  ]), target);
  assert.equal(findMenu(['결재대기'], [menu('work.btnApprove', '결재'), menu('work.result', '결재대기')]), null);
});

test('budget routing prefers the 담당 inquiry card and does not click budget editing controls', () => {
  const target = menu('pdvMegaMenu.owner:text', '사업관리카드(담당)');
  assert.equal(findMenu(['사업별예산현황', '사업관리카드(담당)', '사업관리카드(현액)', '사업관리카드'], [
    menu('pdvMegaMenu.edit:text', '예산등록'), menu('pdvMegaMenu.current:text', '사업관리카드(현액)'), target,
  ]), target);
});

const readyScript = overviewSource.split('internal static string OverviewReadyScript')[1].split('return $$"""')[1].split('""";')[0];
const overviewHelpers = overviewSource.split('internal static string OverviewDomHelpersScript')[1].split('return """')[1].split('""";')[0];
const expandOverviewScript = (script, names) => script
  .replace('{{OverviewDomHelpersScript()}}', overviewHelpers)
  .replace('{{JsonSerializer.Serialize(menuNames)}}', JSON.stringify(names));
function ready(document, names = ['결재대기'], approval = true) {
  return vm.runInNewContext(expandOverviewScript(readyScript, names)
    .replace('{{(approval ? "true" : "false")}}', String(approval)), { document });
}

test('overview readiness accepts a rendered page inside zero-size layout ancestors', () => {
  const document = page([element(['문서관리 > 결재 > 결재대기']), element(['조회']), element(['제목']),
    element(['문서종류']), element(['문서유형']), element(['문서번호'])]);
  document.body.getBoundingClientRect = () => ({ width: 0, height: 0, right: 0, bottom: 0 });
  assert.equal(ready(document), true);
});

function screenshotApprovalPage(rowSummary = '총 5건 / 조회 5건') {
  return [
    element(['결재대기 ( 학교 / 예시코드 )']),
    element(['문서관리 > 결재 > 결재대기']),
    element(['제목']), element(['기안자(접수자)']),
    element(['상태']), element(['문서종류']), element(['문서유형']), element(['공개여부']),
    element(['문서번호']), element(['제목']), element([rowSummary]),
  ];
}

test('screenshot approval page is ready without a standalone 조회 button', () => {
  assert.equal(ready(page(screenshotApprovalPage())), true);
  assert.equal(ready(page(screenshotApprovalPage('총 0건 / 조회 0건'))), true);
});

test('separate title, institution and search components identify the opened approval page before grid data', () => {
  assert.equal(ready(page([
    element(['결재대기']), element(['( 학교 / 예시코드 )']),
    element(['제목']), element(['기안자', element(['(접수자)'])]),
  ])), true);
  assert.equal(ready(page([
    element(['결재대기 ( 학교 )']), element(['문서제목 :']), element(['기안자 :']),
  ])), true);
});

test('Nexacro grid shell does not require separately readable headers or populated rows', () => {
  for (const grid of [element([], { role: 'grid' }), element([], { class: 'Grid griddetail' })]) {
    assert.equal(ready(page([element(['결재대기']), grid])), true);
  }
  assert.equal(ready(page([element(['결재대기'])])), false);
  assert.equal(ready(page([element([], { role: 'grid' })])), false);
});

test('component text nodes are readable even when innerText is empty in the rendered framework', () => {
  const labels = ['결재대기', '제목', '기안자(접수자)'].map(value => {
    const label = element([value]);
    Object.defineProperty(label, 'innerText', { value: '' });
    return label;
  });
  assert.equal(ready(page(labels)), true);
});

test('a waiting title and search labels alone cannot prove that the document list loaded', () => {
  assert.equal(ready(page([element(['결재대기']), element(['조회']), element(['제목'])])), false);
});

test('an old approval tab caption cannot identify the active 문서진행 list', () => {
  assert.equal(ready(page([
    element(['결재대기'], { role: 'tab' }), element(['문서진행 ( 학교 / 예시코드 )']),
    element(['문서관리 > 결재 > 문서진행']), element(['제목']),
    element(['문서종류']), element(['문서유형']), element(['문서번호']),
  ])), false);
});

test('Nexacro tab captions cannot combine with another page search controls or grid', () => {
  for (const id of ['mainframe.TabFrame.form.caption', 'work.tabs.tabbutton_0:text']) {
    assert.equal(ready(page([
      element(['결재대기'], { id }), element(['문서진행']),
      element(['제목']), element(['기안자(접수자)']), element([], { role: 'grid' }),
    ])), false);
  }
});

test('a hidden approval heading cannot leak through its visible parent into a different list', () => {
  assert.equal(ready(page([
    element([element(['결재대기'], { hidden: true })]),
    element(['문서진행']), element(['제목']), element(['기안자(접수자)']),
    element([], { role: 'grid' }),
  ])), false);
});

test('screenshot page hidden behind another task is not ready', () => {
  assert.equal(ready(page([element(screenshotApprovalPage(), { hidden: true }), element(['다른 업무'])])), false);
});

test('overview readiness rejects navigation-only labels and hidden old content', () => {
  const labels = screenshotApprovalPage();
  assert.equal(ready(page([element(labels, { id: 'pdvMegaMenu' })])), false);
  assert.equal(ready(page([element(labels, { hidden: true })])), false);
});

const tabScript = overviewSource.split('internal static string EdufineOverviewTabScript')[1].split('return $$"""')[1].split('""";')[0];
const queryScript = overviewSource.split('internal static string EdufineBudgetQueryScript')[1].split('return $$"""')[1].split('""";')[0];
const findTaskTab = document => vm.runInNewContext(expandOverviewScript(tabScript, ['결재대기', '결재대기문서']), { document });
const findBudgetQuery = document => vm.runInNewContext(expandOverviewScript(queryScript, ['사업관리카드(담당)']), { document });

test('approval activation selects the exact existing tab caption, never its close button or final approval', () => {
  const caption = element(['결재대기'], { id: 'mainframe.TabFrame.form.tabbutton_0:text' });
  const close = element(['결재대기'], { id: 'mainframe.TabFrame.form.tabbutton_0.btnClose', role: 'button' });
  const tab = element([caption, close], { role: 'tab', 'aria-selected': 'false' });
  const document = page([element([tab], { role: 'tablist' }),
    element(['결재'], { role: 'button' }), element(['결재대기'])]);
  assert.equal(findTaskTab(document), caption);
  caption.hidden = true;
  assert.equal(findTaskTab(document), null);
});

test('ambiguous or disabled waiting tabs fall back to the known menu route', () => {
  const first = element(['결재대기'], { role: 'tab' });
  const second = element(['결재대기'], { role: 'tab' });
  assert.equal(findTaskTab(page([first, second])), null);
  second.hidden = true;first['aria-disabled'] = 'true';
  assert.equal(findTaskTab(page([first, second])), null);
  assert.equal(findTaskTab(page([element(['결재대기(5)'], { role: 'tab' })])), null);
});

test('inactive approval content cannot satisfy readiness while purchase or budget is the selected task', () => {
  for (const name of ['품의등록', '사업관리카드(담당)']) {
    const approvalTab = element(['결재대기'], { role: 'tab', 'aria-selected': 'false', 'aria-controls': 'approvalPanel' });
    const otherTab = element([name], { role: 'tab', 'aria-selected': 'true', 'aria-controls': 'otherPanel' });
    const document = page([element([approvalTab, otherTab], { role: 'tablist' }),
      element(screenshotApprovalPage(), { id: 'approvalPanel', role: 'tabpanel' }),
      element([element([name])], { id: 'otherPanel', role: 'tabpanel' })]);
    assert.equal(ready(document), false);
    assert.equal(findTaskTab(document), approvalTab);
    approvalTab['aria-selected'] = 'true';otherTab['aria-selected'] = 'false';
    assert.equal(ready(document), true);
  }
});

test('Nexacro selected task status and foreground hit-testing exclude covered approval pages', () => {
  const waiting = element(['결재대기'], { id: 'mainframe.TabFrame.form.tabbutton_0', class: 'Button', userstatus: 'normal' });
  const budget = element(['사업관리카드(담당)'], { id: 'mainframe.TabFrame.form.tabbutton_1', class: 'Button', userstatus: 'selected' });
  const tabs = element([waiting, budget], { id: 'mainframe.TabFrame' });
  assert.equal(ready(page([tabs, ...screenshotApprovalPage()])), false);
  const front = element(['품의등록']);
  const behind = screenshotApprovalPage();
  behind.forEach(e => { e.coveredBy = front; });
  assert.equal(ready(page([...behind, front])), false);
});

test('selected zero-size task panels retain exposed absolute children without exposing hidden panels', () => {
  const tab = element(['결재대기'], { role: 'tab', 'aria-selected': 'true', 'aria-controls': 'approvalPanel' });
  const panel = element(screenshotApprovalPage(), { id: 'approvalPanel', role: 'tabpanel',
    getBoundingClientRect: () => ({ width: 0, height: 0, right: 0, bottom: 0 }) });
  const document = page([element([tab], { role: 'tablist' }), panel]);
  assert.equal(ready(document), true);
  panel.hidden = true;assert.equal(ready(document), false);
});

function budgetForm(queryOptions = {}, extras = []) {
  const query = element([element(['조회'])], { class: 'Button', role: 'button', id: 'budget.form.btnSearch', ...queryOptions });
  const form = element([element(['사업관리카드(담당)']), element(['회계연도']), query, ...extras],
    { class: 'Form', id: 'budget.form', role: 'tabpanel' });
  return { form, query };
}

test('budget query selection is scoped to the active business card form and preserves conditions', () => {
  const condition = element([], { tagName: 'INPUT', value: '2026' });
  const { form, query } = budgetForm({}, [condition]);
  const unrelated = element([element(['조회'], { role: 'button' })], { class: 'Form', id: 'purchase.form' });
  const document = page([form, unrelated]);
  assert.equal(findBudgetQuery(document), query);
  assert.equal(findBudgetQuery(document), query);
  assert.equal(condition.value, '2026');
  assert.equal(ready(document, ['사업관리카드(담당)'], false), true);
});

test('disabled, busy, covered and final-action controls are never budget query candidates', () => {
  for (const options of [
    { disabled: true }, { 'aria-disabled': 'true' }, { status: 'disabled' },
    { hidden: true }, { 'aria-busy': 'true' }, { id: 'budget.form.btnSave' },
    { id: 'budget.form.btnApproval' }, { coveredBy: element(['다른 업무']) },
  ]) {
    assert.equal(findBudgetQuery(page([budgetForm(options).form])), null);
  }
  const { form } = budgetForm();form['aria-busy'] = 'true';
  assert.equal(findBudgetQuery(page([form])), null);
});

test('budget query refuses ambiguous controls and never widens its scope to another task', () => {
  const duplicate = element(['조회'], { role: 'button' });
  assert.equal(findBudgetQuery(page([budgetForm({}, [duplicate]).form])), null);
  const { form, query } = budgetForm();query.hidden = true;
  const unrelated = element([element(['조회'], { role: 'button' })], { class: 'Form', id: 'other.form' });
  assert.equal(findBudgetQuery(page([form, unrelated])), null);
  assert.equal(findBudgetQuery(page([element(['사업관리카드(담당)']), element(['회계연도']), duplicate])), null);
});

test('budget query cannot use a retained card while another task tab is active', () => {
  const { form, query } = budgetForm();
  const cardTab = element(['사업관리카드(담당)'], { role: 'tab', 'aria-selected': 'false', 'aria-controls': 'budget.form' });
  const otherTab = element(['품의등록'], { role: 'tab', 'aria-selected': 'true' });
  const document = page([element([cardTab, otherTab], { role: 'tablist' }), form]);
  assert.equal(findBudgetQuery(document), null);
  cardTab['aria-selected'] = 'true';otherTab['aria-selected'] = 'false';
  assert.equal(findBudgetQuery(document), query);
});
