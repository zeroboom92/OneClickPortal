import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../PortalWorkflowController.FieldTripReports.cs', import.meta.url), 'utf8');
const template = source.split('internal static string FieldTripReportSelectionScript(')[1]
  .split('=> $$"""')[1].split('""";')[0];
const domain = 'jbe.neis.go.kr';
const reportId = 'edu/sa/eds/eaa/ae/eds_eaaae02_m01';
const title = '교외체험학습보고서관리';
const script = template.replace('{{JsonSerializer.Serialize(officeDomain)}}', JSON.stringify(domain));

function dialog({ hidden = false, display = 'block', visibility = 'visible', width = 200,
  height = 100, parentElement = null } = {}) {
  return { hidden, style: { display, visibility }, parentElement,
    getBoundingClientRect: () => ({ width, height }) };
}

// The MDI emits a cancellable selection event, as the live site does. The fixture
// intentionally exposes no report tab DOM: captions may be clipped or unrendered.
function fixture({ owner = true, tab = true, selectedReport = false } = {}) {
  const actions = { query: 0, submit: 0, menu: 0, controlReads: 0, network: 0 };
  const search = { value: '조회', enabled: true, click: () => { actions.query++; } };
  const submit = { value: '상신', click: () => { actions.submit++; } };
  const query = { status: 'IDLE', send: () => { actions.query++; } };
  const grid = { readOnly: true, checkedRows: [], getCheckRowIndices() { return this.checkedRows; } };
  const controls = { btnSearch: search, btnApproval: submit, subStdntList: query, grdMain: grid };
  const app = { app: { id: reportId }, disposed: false, lookup(key) {
    actions.controlReads++;
    return controls[key];
  } };
  const reportTab = { _menuKey: 'AMEDS40511', text: title, content: app };
  const otherTab = { _menuKey: 'OTHER', text: '개인근무상황관리', content: { app: { id: 'other/task' } } };
  const tabs = [otherTab, ...(tab ? [reportTab] : [])];
  let selected = selectedReport ? reportTab : otherTab;
  const selectionEvents = [];
  const listeners = [];
  const mdi = {
    getTabItems: () => tabs,
    getSelectedTabItem: () => selected,
    setSelectedTabItem(next) {
      const event = { oldSelection: selected, newSelection: next, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; } };
      selectionEvents.push(event);
      for (const listener of listeners) listener(event);
      if (!event.defaultPrevented) selected = next;
    },
  };
  const rootControls = { mdiCn: mdi };
  const root = { app: { id: 'app/com/main/Index' }, disposed: false,
    lookup: key => rootControls[key], getModule: () => ({ openMenuItem() { actions.menu++; } }) };
  const apps = { root, ...(owner ? { report: app } : {}) };
  const dialogs = [];
  const domQueries = [];
  const document = { readyState: 'complete', querySelectorAll(selector) {
    domQueries.push(selector);
    assert.equal(selector, '[role="dialog"],.cl-dialog', 'Navigation must not locate or click a DOM tab caption.');
    return dialogs;
  } };
  const location = { protocol: 'https:', hostname: domain };
  const context = vm.createContext({ document, location,
    cpr: { core: { Platform: { INSTANCE: { getAllRunningAppInstances: () => apps } } } },
    getComputedStyle: element => element.style,
    fetch: () => { actions.network++; throw new Error('Tab selection must never send a request.'); },
  });
  return { actions, search, submit, query, grid, controls, app, reportTab, otherTab,
    tabs, mdi, selectionEvents, listeners, rootControls, root, apps, dialogs, domQueries,
    document, location, context,
    selected: () => selected,
    run: () => vm.runInContext(script, context, { timeout: 1000 }),
    assertNoReportActions() {
      assert.deepEqual(actions, { query: 0, submit: 0, menu: 0, controlReads: 0, network: 0 });
    },
  };
}

test('an existing report uses the ordinary MDI selection once without a rendered DOM caption', () => {
  const f = fixture();
  assert.equal(f.run(), 'Selected');
  assert.equal(f.selected(), f.reportTab);
  assert.equal(f.selectionEvents.length, 1);
  assert.equal(f.selectionEvents[0].oldSelection, f.otherTab);
  assert.equal(f.selectionEvents[0].newSelection, f.reportTab);
  assert.equal(f.run(), 'Selected');
  assert.equal(f.selectionEvents.length, 1, 'Selecting the current report must be idempotent.');
  f.assertNoReportActions();
});

test('checked rows, edits, a disabled query and an in-flight query do not block opening the existing report', () => {
  for (const change of [f => { f.grid.checkedRows = [0, 1]; },
    f => { f.grid.readOnly = false; }, f => { f.search.enabled = false; },
    f => { f.query.status = 'SENDING'; }, f => { f.app.lookup = () => { throw new Error('Report still loading'); }; }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run(), 'Selected');
    assert.equal(f.selected(), f.reportTab);
    assert.equal(f.selectionEvents.length, 1);
    f.assertNoReportActions();
  }
});

test('the site can cancel selection without being bypassed or retried', () => {
  const f = fixture();
  f.listeners.push(event => event.preventDefault());
  assert.equal(f.run(), 'Busy');
  assert.equal(f.selected(), f.otherTab);
  assert.equal(f.selectionEvents.length, 1);
  assert.equal(f.selectionEvents[0].defaultPrevented, true);
  f.assertNoReportActions();
});

test('visible modals block switching away while hidden, collapsed and ancestor-hidden dialogs do not', () => {
  const blocked = fixture();
  blocked.dialogs.push(dialog());
  assert.equal(blocked.run(), 'Busy');
  assert.equal(blocked.selected(), blocked.otherTab);
  assert.equal(blocked.selectionEvents.length, 0);
  blocked.assertNoReportActions();
  for (const hiddenDialog of [dialog({ hidden: true }), dialog({ display: 'none' }),
    dialog({ visibility: 'hidden' }), dialog({ width: 0 }), dialog({ height: 0 }),
    dialog({ parentElement: dialog({ display: 'none' }) })]) {
    const f = fixture();
    f.dialogs.push(hiddenDialog);
    assert.equal(f.run(), 'Selected');
    assert.equal(f.selectionEvents.length, 1);
    f.assertNoReportActions();
  }
});

test('an already selected report keeps its current dialog and selection unchanged', () => {
  const f = fixture({ selectedReport: true });
  const modal = dialog();
  f.dialogs.push(modal);
  assert.equal(f.run(), 'Selected');
  assert.equal(f.selected(), f.reportTab);
  assert.equal(f.dialogs[0], modal);
  assert.equal(f.selectionEvents.length, 0);
  assert.equal(f.domQueries.length, 0);
  f.assertNoReportActions();
});

test('missing and still opening reports remain distinguishable without adding a second menu', () => {
  const missing = fixture({ owner: false, tab: false });
  assert.equal(missing.run(), 'Missing');
  assert.equal(missing.selectionEvents.length, 0);
  missing.assertNoReportActions();
  const opening = fixture({ owner: false });
  delete opening.reportTab.content;
  assert.equal(opening.run(), 'Opening');
  assert.equal(opening.selected(), opening.reportTab);
  assert.equal(opening.run(), 'Opening');
  assert.equal(opening.selectionEvents.length, 1);
  opening.assertNoReportActions();
});

test('duplicate live roots, report owners and report tabs fail before selecting anything', () => {
  for (const change of [f => { f.apps.copyRoot = { ...f.root }; },
    f => { f.apps.copyReport = { ...f.app }; }, f => { f.tabs.push({ ...f.reportTab }); },
    f => { f.tabs.splice(1, 1); }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run(), 'Ambiguous');
    assert.equal(f.selected(), f.otherTab);
    assert.equal(f.selectionEvents.length, 0);
    f.assertNoReportActions();
  }
  const disposed = fixture();
  disposed.apps.oldRoot = { ...disposed.root, disposed: true };
  disposed.apps.oldReport = { ...disposed.app, disposed: true };
  assert.equal(disposed.run(), 'Selected');
  disposed.assertNoReportActions();
});

test('an unrelated tab with a reused title or menu key cannot be selected', () => {
  for (const change of [f => { f.reportTab.content = { app: { id: 'other/task' } }; },
    f => { f.reportTab._menuKey = 'OTHER'; f.reportTab.content = { app: { id: 'other/task' } }; },
    f => { f.reportTab.text = '다른 화면'; f.reportTab.content = { app: { id: 'other/task' } }; }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run(), 'Ambiguous');
    assert.equal(f.selected(), f.otherTab);
    assert.equal(f.selectionEvents.length, 0);
    f.assertNoReportActions();
  }
});

test('the report app identity selects its tab even when its visible caption differs', () => {
  const f = fixture();
  f.reportTab.text = '교외체험학습보고서관리 (열림)';
  f.reportTab._menuKey = undefined;
  assert.equal(f.run(), 'Selected');
  assert.equal(f.selected(), f.reportTab);
  f.assertNoReportActions();
});

test('unofficial hosts, insecure or loading pages and incomplete MDI contracts fail without actions', () => {
  for (const change of [f => { f.location.hostname = `${domain}.example.com`; },
    f => { f.location.protocol = 'http:'; }, f => { f.document.readyState = 'loading'; },
    f => { f.context.cpr = {}; }, f => { delete f.rootControls.mdiCn; },
    f => { delete f.mdi.getTabItems; }, f => { delete f.mdi.getSelectedTabItem; },
    f => { delete f.mdi.setSelectedTabItem; }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run(), 'Unavailable');
    assert.equal(f.selectionEvents.length, 0);
    f.assertNoReportActions();
  }
});

test('notification routing activates Nice before selection and prepares only absent or opening reports', () => {
  const workflow = source.split('private async Task<WorkflowResult> OpenFieldTripReportManagementAsync(')[1]
    .split('internal static string FieldTripReportSelectionScript(')[0];
  const selection = workflow.indexOf('FieldTripReportSelectionScript(');
  assert.ok(selection > workflow.indexOf('await WaitForNiceReadyAsync('));
  assert.ok(selection > workflow.indexOf('await session.ActivateTargetAsync('));
  assert.ok(selection > workflow.indexOf('await session.MaximizeTargetWindowAsync('));
  assert.match(workflow, /if \(state is "Missing" or "Opening"\)\s*\{[\s\S]*?await EnsureFieldTripReportReadyAsync\(cancellationToken\);[\s\S]*?FieldTripReportSelectionScript\(/);
  assert.equal((workflow.match(/EnsureFieldTripReportReadyAsync\(/g) || []).length, 1);
  assert.doesNotMatch(workflow, /ClickElementCenterAsync|ClickNiceMenuAsync|NiceTaskTabSelectedExpression/);
  assert.match(workflow, /if \(state != "Selected"\)[\s\S]*?throw new InvalidOperationException/);
  assert.match(workflow, /KeepActivatedBrowser: true/);

  const notification = fs.readFileSync(new URL('../MainForm.Notifications.cs', import.meta.url), 'utf8');
  assert.match(notification, /kind == NotificationKind\.FieldTripReport\) _ = RunWorkflowAsync\(PortalTaskKind\.FieldTripReportManagement\)/);
  const controller = fs.readFileSync(new URL('../PortalWorkflowController.cs', import.meta.url), 'utf8');
  assert.match(controller, /PortalTaskKind\.FieldTripReportManagement => OpenFieldTripReportManagementAsync\(cancellationToken\)/);
  const notificationUi = fs.readFileSync(new URL('../NotificationCenterForm.cs', import.meta.url), 'utf8');
  assert.match(notificationUi, /_canOpen\(entry.Kind\)\) OpenRequested\?\.Invoke\(entry.Kind\)/);
});
