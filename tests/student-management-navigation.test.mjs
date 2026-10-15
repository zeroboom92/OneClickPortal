import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../PortalWorkflowController.StudentManagement.cs', import.meta.url), 'utf8');
const domain = 'jbe.neis.go.kr';
const configurations = [
  { kind: 'FieldTripApplicationManagement', suffix: '01', menuId: 'AMEDS40501',
    title: '교외체험학습신청서관리', parent: '교외체험학습관리', dataId: 'dsStdntListForAply' },
  { kind: 'AbsenceReportManagement', suffix: '03', menuId: 'AMEDS40531',
    title: '결석신고서관리', parent: '출결관리', dataId: 'dsStdntListForAbe' },
  { kind: 'FieldTripReportManagement', suffix: '02', menuId: 'AMEDS40511',
    title: '교외체험학습보고서관리', parent: '교외체험학습관리', dataId: 'dsStdntListForRlt' },
].map(config => ({ ...config, appId: `edu/sa/eds/eaa/ae/eds_eaaae${config.suffix}_m01`,
  endpoint: `/eds_eaa_ae${config.suffix}_002.do` }));
const columns = ['MENU_ID', 'MENU_NM', 'V_MENU_ID', 'V_UP_MENU_ID', 'CALL_PAGE',
  'SHOW_YN', 'menuUseYn', 'inqAccesAuthYn'];
const rawTemplate = method => source.split(`internal static string ${method}(`)[1]
  .split('=> $$"""')[1].split('""";')[0];
const navigationTemplate = rawTemplate('StudentManagementNavigationScript');
const queryTemplate = rawTemplate('StudentManagementQueryScript');
function script(template, kind, flagName, flag) {
  const rendered = template
    .replace('{{JsonSerializer.Serialize(officeDomain)}}', JSON.stringify(domain))
    .replace('{{JsonSerializer.Serialize(kind.ToString())}}', JSON.stringify(kind))
    .replace(`{{(${flagName} ? "true" : "false")}}`, String(flag));
  assert.doesNotMatch(rendered, /\{\{/, 'Every production interpolation must be explicitly rendered.');
  return rendered;
}

function branch(config, prefix, role = '학급담임') {
  return [role, '교육활동신청관리', config.parent, config.title].map((name, index) => ({
    MENU_ID: index === 3 ? config.menuId : `${prefix}-MENU-${index}`,
    MENU_NM: name, V_MENU_ID: `${prefix}-${index}`, V_UP_MENU_ID: index ? `${prefix}-${index - 1}` : '',
    CALL_PAGE: index === 3 ? config.appId : '', SHOW_YN: 'Y', menuUseYn: 'Y', inqAccesAuthYn: 'Y',
  }));
}
function dialog({ hidden = false, display = 'block', visibility = 'visible', width = 100,
  height = 100, parentElement = null } = {}) {
  return { hidden, style: { display, visibility }, parentElement,
    getBoundingClientRect: () => ({ width, height }) };
}

// Runs the production JS against the verified CPR contracts. Student row reads,
// approval controls and direct network access fail immediately if attempted.
function fixture(config, { owner = true, tab = true, selected = true, rows, onClick, openAddsTab = true } = {}) {
  const actions = { query: 0, submit: 0, network: 0, rowReads: 0, appControlReads: 0 };
  let now = 1_000_000;
  let checkedRows = [];
  let modified = false;
  let editRow = -1;
  const listeners = new Map();
  const searchValues = { shlCd: 'SCHOOL-A', ayr: '2026', grd: '1', clsCd: '1' };
  const userValues = { userId: 'USER-A' };
  const liveUserValues = { userId: 'USER-A' };
  const data = {
    isModified: () => modified,
    getRowCount() { actions.rowReads++; throw new Error('Notification navigation must not read students.'); },
    getValue() { actions.rowReads++; throw new Error('Notification navigation must not read student values.'); },
  };
  const search = { getValue: key => searchValues[key], getDatas: () => ({ ...searchValues }) };
  const user = { getValue: key => userValues[key] };
  const liveUser = { getValue: key => liveUserValues[key] };
  const submission = {
    action: config.endpoint, status: 'IDLE', succeeded: true,
    isSuccess() { return this.succeeded; },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
    emit(name) { for (const handler of [...(listeners.get(name) ?? [])]) handler({ type: name }); },
  };
  const button = { value: '조회', enabled: true, click() {
    actions.query++;
    submission.status = 'SENDING';
    onClick?.(f);
  } };
  const approval = { value: '상신', click() { actions.submit++; throw new Error('Approval is not authorized.'); } };
  const grid = { dataSet: data, readOnly: false,
    getCheckRowIndices: () => checkedRows, getEditRowIndex: () => editRow };
  const controls = { [config.dataId]: data, dmSearch: search, dmUserInfo: user,
    btnSearch: button, subStdntList: submission, grdMain: grid, btnApproval: approval,
    cmbAyr: { getUDCApp: () => ({}) }, cmbOrgGrd: { getUDCApp: () => ({}) },
    cmbClsCd: { getUDCApp: () => ({}) } };
  const app = { app: { id: config.appId }, disposed: false,
    lookup(key) { actions.appControlReads++; return controls[key]; } };
  const targetTab = { _menuKey: config.menuId, text: config.title, content: app };
  const otherTab = { _menuKey: 'OTHER', text: '개인근무상황관리', content: { app: { id: 'other/page' } } };
  const tabs = [otherTab, ...(tab ? [targetTab] : [])];
  let selectedTab = selected && tab ? targetTab : otherTab;
  const selectionEvents = [];
  const selectionListeners = [];
  const mdi = { getTabItems: () => tabs, getSelectedTabItem: () => selectedTab,
    setSelectedTabItem(next) {
      const event = { oldSelection: selectedTab, newSelection: next, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; } };
      selectionEvents.push(event);
      for (const listener of selectionListeners) listener(event);
      if (!event.defaultPrevented) selectedTab = next;
    } };
  rows ??= [...branch(config, 'teacher'), ...branch(config, 'other', '교무학사')];
  const menuData = { getColumnNames: () => [...columns], getRowCount: () => rows.length,
    getValue: (index, key) => rows[index][key], getRow: index => rows[index] };
  const auth = { action: '/menuCheckAuth.do', status: 'IDLE' };
  const menuParameters = { strMenuParamVal: '' };
  const rootControls = { mdiCn: mdi, dsAllMenu: menuData, subAuth: auth,
    dmMenuParam: { getValue: key => menuParameters[key] } };
  const opens = [];
  const module = { openMenuItem(argument, caller) {
    opens.push({ argument, caller });
    auth.status = 'SENDING';
    if (openAddsTab) tabs.push({ _menuKey: config.menuId, text: config.title });
  } };
  const root = { app: { id: 'app/com/main/Index' }, disposed: false,
    lookup: key => rootControls[key], getModule: () => module };
  const apps = { root, ...(owner ? { target: app } : {}) };
  const dialogs = [];
  const domQueries = [];
  const document = { readyState: 'complete', querySelectorAll(selector) {
    domQueries.push(selector);
    assert.equal(selector, '[role="dialog"],.cl-dialog', 'Use CPR tab objects rather than DOM captions.');
    return dialogs;
  } };
  const location = { protocol: 'https:', hostname: domain, origin: `https://${domain}`,
    href: `https://${domain}/jsp/main.jsp` };
  const context = vm.createContext({ URL, document, location, Date: { now: () => now },
    cpr: { core: { Platform: { INSTANCE: { getAllRunningAppInstances: () => apps } } } },
    createCommonUtil: () => ({ Auth: { getUserInfo: () => liveUser } }),
    getComputedStyle: element => element.style,
    fetch() { actions.network++; throw new Error('Use the site’s own query control.'); },
    XMLHttpRequest() { actions.network++; throw new Error('Direct network is forbidden.'); },
  });
  const f = { config, actions, listeners, searchValues, userValues, liveUserValues,
    data, search, user, submission, button, approval, grid, controls, app, targetTab, otherTab,
    tabs, selectionEvents, selectionListeners, mdi, rows, menuData, auth, menuParameters,
    rootControls, opens, module, root, apps, dialogs, domQueries, document, location, context,
    selected: () => selectedTab, select: value => { selectedTab = value; },
    checked: value => { checkedRows = value; }, modified: value => { modified = value; },
    editRow: value => { editRow = value; }, advance: milliseconds => { now += milliseconds; },
    navigate: (allowOpen = false, kind = config.kind) => vm.runInContext(
      script(navigationTemplate, kind, 'allowOpen', allowOpen), context, { timeout: 1000 }),
    query: (startQuery = true, kind = config.kind) => vm.runInContext(
      script(queryTemplate, kind, 'startQuery', startQuery), context, { timeout: 1000 }),
    complete({ success = true, emitSuccess = success, status = 'DONE', done = true } = {}) {
      submission.succeeded = success;
      submission.status = status;
      submission.emit(emitSuccess ? 'submit-success' : 'submit-error');
      if (done) submission.emit('submit-done');
    },
    listenerCount: () => [...listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0),
    assertNoUnsafeActions() {
      assert.equal(actions.submit, 0);
      assert.equal(actions.network, 0);
      assert.equal(actions.rowReads, 0);
    },
  };
  return f;
}

for (const config of configurations) {
  test(`${config.title}: existing tab selection is ordinary, idempotent and independent of data/query state`, () => {
    for (const change of [() => {}, f => f.checked([0]), f => f.modified(true),
      f => f.editRow(0), f => { f.submission.status = 'SENDING'; },
      f => { f.button.enabled = false; }, f => { f.app.lookup = () => { throw new Error('Loading'); }; }]) {
      const f = fixture(config, { selected: false });
      change(f);
      assert.equal(f.navigate(), 'Selected');
      assert.equal(f.selected(), f.targetTab);
      assert.equal(f.selectionEvents.length, 1);
      assert.equal(f.navigate(true), 'Selected');
      assert.equal(f.selectionEvents.length, 1);
      assert.equal(f.actions.appControlReads, 0);
      assert.equal(f.actions.query, 0);
      assert.equal(f.opens.length, 0);
      f.assertNoUnsafeActions();
    }
  });

  test(`${config.title}: canceled selection and visible dialogs cannot be bypassed`, () => {
    const canceled = fixture(config, { selected: false });
    canceled.selectionListeners.push(event => event.preventDefault());
    assert.equal(canceled.navigate(), 'Busy');
    assert.equal(canceled.selected(), canceled.otherTab);
    assert.equal(canceled.selectionEvents.length, 1);
    canceled.assertNoUnsafeActions();
    const blocked = fixture(config, { selected: false });
    blocked.dialogs.push(dialog());
    assert.equal(blocked.navigate(true), 'Busy');
    assert.equal(blocked.selectionEvents.length, 0);
    blocked.select(blocked.targetTab);
    assert.equal(blocked.navigate(), 'Selected', 'An already-selected tab keeps the current dialog.');
    assert.equal(blocked.selectionEvents.length, 0);
    assert.equal(blocked.query(), 'Busy', 'The dialog still blocks refreshing the page.');
    for (const hidden of [dialog({ hidden: true }), dialog({ display: 'none' }),
      dialog({ visibility: 'hidden' }), dialog({ width: 0 }), dialog({ height: 0 }),
      dialog({ parentElement: dialog({ display: 'none' }) })]) {
      const f = fixture(config, { selected: false });
      f.dialogs.push(hidden);
      assert.equal(f.navigate(), 'Selected');
      assert.equal(f.query(), 'Started');
      f.assertNoUnsafeActions();
    }
  });

  test(`${config.title}: a missing menu opens only the exact authorized homeroom branch once`, () => {
    const f = fixture(config, { owner: false, tab: false });
    assert.equal(f.navigate(), 'Missing');
    assert.equal(f.opens.length, 0);
    assert.equal(f.navigate(true), 'Started');
    assert.equal(f.opens.length, 1);
    assert.equal(f.opens[0].argument.row, f.rows[3]);
    assert.deepEqual(Object.keys(f.opens[0].argument), ['row']);
    assert.equal(f.opens[0].caller, 'btnTlbrMn');
    assert.equal(f.navigate(), 'Opening');
    assert.equal(f.navigate(true), 'Opening');
    assert.equal(f.opens.length, 1);
    f.apps.target = f.app;
    f.tabs.at(-1).content = f.app;
    assert.equal(f.navigate(), 'Selected');
    assert.equal(f.actions.query, 0);
    f.assertNoUnsafeActions();
  });

  test(`${config.title}: pending authorization without a tab is never dispatched twice`, () => {
    const f = fixture(config, { owner: false, tab: false, openAddsTab: false });
    assert.equal(f.navigate(true), 'Started');
    assert.equal(f.navigate(), 'Missing');
    assert.equal(f.navigate(true), 'Busy');
    assert.equal(f.opens.length, 1);
    f.assertNoUnsafeActions();
  });

  test(`${config.title}: menu permissions, role hierarchy and endpoint are checked before opening`, () => {
    for (const change of [f => { f.rows.splice(0, 4); }, f => { f.rows[2].V_UP_MENU_ID = 'absent'; },
      f => { f.rows[1].V_UP_MENU_ID = f.rows[2].V_MENU_ID; },
      f => { f.rows[3].inqAccesAuthYn = 'N'; }, f => { f.rows[3].SHOW_YN = 'N'; },
      f => { f.rows[3].menuUseYn = 'N'; }, f => { f.rows[3].CALL_PAGE = 'other/page'; },
      f => { f.rows[3].MENU_NM += ' 상신'; }]) {
      const f = fixture(config, { owner: false, tab: false });
      change(f);
      assert.equal(f.navigate(true), 'MenuMissing');
      assert.equal(f.opens.length, 0);
      f.assertNoUnsafeActions();
    }
    for (const action of ['https://other.example/menuCheckAuth.do',
      `http://${domain}/menuCheckAuth.do`, `https://${domain}.example.com/menuCheckAuth.do`, '/requestApproval.do']) {
      const f = fixture(config, { owner: false, tab: false });
      f.auth.action = action;
      assert.equal(f.navigate(true), 'Unavailable');
      assert.equal(f.opens.length, 0);
    }
    for (const change of [f => { f.menuParameters.strMenuParamVal = 'existing'; },
      f => { f.auth.status = 'SENDING'; }, f => f.dialogs.push(dialog())]) {
      const f = fixture(config, { owner: false, tab: false });
      change(f);
      assert.equal(f.navigate(true), 'Busy');
      assert.equal(f.opens.length, 0);
    }
  });

  test(`${config.title}: duplicate owners, roots, tabs and exact menu paths are rejected`, () => {
    for (const change of [f => { f.apps.rootCopy = { ...f.root }; },
      f => { f.apps.appCopy = { ...f.app }; }, f => f.tabs.push({ ...f.targetTab }),
      f => { f.targetTab.content = { app: { id: 'unrelated/app' } }; },
      f => f.tabs.splice(1, 1)]) {
      const f = fixture(config, { selected: false });
      change(f);
      assert.equal(f.navigate(), 'Ambiguous');
      assert.equal(f.selectionEvents.length, 0);
      assert.equal(f.actions.query, 0);
    }
    const duplicate = fixture(config, { owner: false, tab: false,
      rows: [...branch(config, 'one'), ...branch(config, 'two')] });
    assert.equal(duplicate.navigate(true), 'Ambiguous');
    assert.equal(duplicate.opens.length, 0);
    const disposed = fixture(config);
    disposed.apps.oldRoot = { ...disposed.root, disposed: true };
    disposed.apps.oldApp = { ...disposed.app, disposed: true };
    assert.equal(disposed.navigate(), 'Selected');
    assert.equal(disposed.query(), 'Started');
  });

  test(`${config.title}: explicit 조회 clicks once and requires success, done and the successful transport`, () => {
    const f = fixture(config);
    assert.equal(f.query(false), 'Unavailable');
    assert.equal(f.query(), 'Started');
    assert.equal(f.actions.query, 1);
    assert.equal(f.listenerCount(), 3);
    assert.equal(f.query(), 'Busy');
    assert.equal(f.query(false), 'Started');
    f.complete({ done: false });
    assert.equal(f.query(false), 'Started', 'submit-success alone must never confirm completion.');
    f.submission.emit('submit-done');
    assert.equal(f.query(false), 'Complete');
    assert.equal(f.query(false), 'Complete');
    assert.equal(f.actions.query, 1);
    assert.equal(f.listenerCount(), 0);
    assert.equal(f.opens.length, 0);
    f.assertNoUnsafeActions();
    assert.equal(f.query(), 'Started', 'A later explicit click may perform another refresh.');
    assert.equal(f.actions.query, 2);
    f.complete();
    assert.equal(f.query(false), 'Complete');
  });

  test(`${config.title}: dirty, checked, actively edited and disabled grids are not refreshed`, () => {
    for (const change of [f => f.modified(true), f => f.checked([0]), f => f.editRow(0),
      f => { f.button.enabled = false; }, f => { f.submission.status = 'SENDING'; },
      f => { f.submission.status = 'RECEIVING'; }]) {
      const f = fixture(config);
      change(f);
      assert.equal(f.query(), 'Busy');
      assert.equal(f.actions.query, 0);
      assert.equal(f.listenerCount(), 0);
      f.assertNoUnsafeActions();
    }
    for (const change of [f => f.modified(undefined), f => f.checked(null), f => f.editRow(-2),
      f => f.editRow(0.5), f => { delete f.grid.getEditRowIndex; }]) {
      const f = fixture(config);
      change(f);
      assert.equal(f.query(), 'Unavailable');
      assert.equal(f.actions.query, 0);
    }
    for (const readOnly of [false, true]) {
      const f = fixture(config);
      f.grid.readOnly = readOnly;
      assert.equal(f.query(), 'Started', 'An editable but untouched grid is safe for an explicit 조회.');
      f.assertNoUnsafeActions();
    }
  });

  test(`${config.title}: official host, selected app, query endpoint and account must match`, () => {
    for (const change of [f => { f.location.hostname += '.example.com'; },
      f => { f.location.hostname = `fake.${domain}`; }, f => { f.location.protocol = 'http:'; },
      f => { f.document.readyState = 'loading'; }, f => { f.context.cpr = {}; },
      f => { f.grid.dataSet = {}; }, f => { f.button.value = '상신'; },
      f => { f.submission.action = '/requestApproval.do'; },
      f => { f.submission.action = 'https://other.example' + config.endpoint; },
      f => { f.submission.action = `http://${domain}` + config.endpoint; },
      f => { f.submission.action = `https://${domain}.example.com` + config.endpoint; }]) {
      const f = fixture(config);
      change(f);
      assert.equal(f.query(), 'Unavailable');
      assert.equal(f.actions.query, 0);
      f.assertNoUnsafeActions();
    }
    const inactive = fixture(config, { selected: false });
    assert.equal(inactive.query(), 'Busy');
    assert.equal(inactive.actions.query, 0);
    const mismatch = fixture(config);
    mismatch.liveUserValues.userId = 'OTHER';
    assert.equal(mismatch.query(), 'ScopeChanged');
    assert.equal(mismatch.actions.query, 0);
    const missing = fixture(config, { owner: false });
    assert.equal(missing.query(), 'Missing');
    assert.equal(missing.actions.query, 0);
  });

  test(`${config.title}: unfinished search controls never trigger 조회 or change conditions`, () => {
    for (const change of [f => { f.searchValues.shlCd = ''; }, f => { f.searchValues.ayr = ''; },
      f => { f.userValues.userId = ''; }, f => { delete f.controls.dmSearch; },
      f => { f.controls.cmbOrgGrd.getUDCApp = () => null; }, f => { f.searchValues.clsCd = ''; },
      f => { f.controls.cmbShlCrseScCd = { getUDCApp: () => ({}) }; }]) {
      const f = fixture(config);
      change(f);
      const before = { ...f.searchValues };
      assert.equal(f.query(), 'Loading');
      assert.equal(f.actions.query, 0);
      assert.deepEqual(f.searchValues, before);
      f.assertNoUnsafeActions();
    }
    const optional = fixture(config);
    delete optional.controls.cmbOrgGrd;
    delete optional.controls.cmbClsCd;
    assert.equal(optional.query(), 'Started');
  });

  test(`${config.title}: failed, incomplete and out-of-order submission events never confirm completion`, () => {
    for (const completion of [{ success: false }, { success: true, emitSuccess: false },
      { success: true, status: 'SENDING' }]) {
      const f = fixture(config);
      assert.equal(f.query(), 'Started');
      f.complete(completion);
      assert.equal(f.query(false), 'QueryFailed');
      assert.equal(f.listenerCount(), 0);
      f.assertNoUnsafeActions();
    }
    const reversed = fixture(config);
    reversed.query();
    reversed.submission.status = 'DONE';
    reversed.submission.emit('submit-done');
    reversed.submission.emit('submit-success');
    assert.equal(reversed.query(false), 'QueryFailed');
    assert.equal(reversed.listenerCount(), 0);
    const throws = fixture(config, { onClick: () => { throw new Error('Query handler failed.'); } });
    assert.equal(throws.query(), 'QueryFailed');
    assert.equal(throws.query(false), 'QueryFailed');
    assert.equal(throws.listenerCount(), 0);
  });

  test(`${config.title}: synchronous success is observed and removes temporary listeners`, () => {
    const f = fixture(config, { onClick: current => current.complete() });
    assert.equal(f.query(), 'Started');
    assert.equal(f.query(false), 'Complete');
    assert.equal(f.listenerCount(), 0);
    assert.equal(f.actions.query, 1);
    f.assertNoUnsafeActions();
  });

  test(`${config.title}: changed filters and accounts invalidate completion without another automatic query`, () => {
    for (const change of [f => { f.searchValues.clsCd = '2'; },
      f => { f.searchValues.shlCd = 'SCHOOL-B'; },
      f => { f.userValues.userId = f.liveUserValues.userId = 'USER-B'; }]) {
      const f = fixture(config);
      assert.equal(f.query(), 'Started');
      change(f);
      assert.equal(f.query(false), 'ScopeChanged');
      assert.equal(f.query(), 'Busy');
      assert.equal(f.actions.query, 1);
      f.complete();
      assert.equal(f.query(false), 'ScopeChanged');
      assert.equal(f.listenerCount(), 0);
      assert.equal(f.query(), 'Started', 'Only a new explicit action may query the changed scope.');
      f.complete();
      assert.equal(f.query(false), 'Complete');
      assert.equal(f.actions.query, 2);
      f.assertNoUnsafeActions();
    }
  });

  test(`${config.title}: timed-out idle observers recover while outstanding requests are never duplicated`, () => {
    for (const status of ['IDLE', 'DONE']) {
      const f = fixture(config);
      assert.equal(f.query(), 'Started');
      f.submission.status = status;
      f.advance(30_000);
      assert.equal(f.query(false), 'Started');
      assert.equal(f.listenerCount(), 3);
      f.advance(1);
      assert.equal(f.query(false), 'QueryFailed');
      assert.equal(f.listenerCount(), 0);
      assert.equal(f.query(), 'Started');
      f.complete();
      assert.equal(f.query(false), 'Complete');
      assert.equal(f.actions.query, 2);
    }
    const f = fixture(config);
    assert.equal(f.query(), 'Started');
    for (const elapsed of [30_001, 60_000, 3_600_000]) {
      f.advance(elapsed);
      assert.equal(f.query(false), 'Started');
      assert.equal(f.query(), 'Busy');
      assert.equal(f.actions.query, 1);
      assert.equal(f.listenerCount(), 3);
    }
    f.complete();
    assert.equal(f.query(false), 'Complete');
    assert.equal(f.listenerCount(), 0);
    f.assertNoUnsafeActions();
  });
}

test('actual 결석신고서 trailing menu/tab whitespace is accepted without broad caption matching', () => {
  const config = configurations[1];
  const menu = fixture(config, { owner: false, tab: false });
  menu.rows[3].MENU_NM += ' ';
  assert.equal(menu.navigate(true), 'Started');
  assert.equal(menu.opens[0].argument.row, menu.rows[3]);
  const pending = fixture(config, { owner: false, selected: false });
  delete pending.targetTab.content;
  pending.targetTab.text += ' ';
  assert.equal(pending.navigate(), 'Opening');
  assert.equal(pending.selected(), pending.targetTab);
  assert.equal(pending.opens.length, 0);
});

test('unknown task kinds cannot choose any menu or query control', () => {
  const f = fixture(configurations[0]);
  assert.equal(f.navigate(true, 'UnknownTask'), 'Unavailable');
  assert.equal(f.query(true, 'UnknownTask'), 'Unavailable');
  assert.equal(f.actions.query, 0);
  assert.equal(f.actions.appControlReads, 0);
  assert.equal(f.opens.length, 0);
  f.assertNoUnsafeActions();
});

test('navigation checks the exact official host and complete CPR MDI contracts', () => {
  for (const change of [f => { f.location.hostname += '.example.com'; },
    f => { f.location.protocol = 'http:'; }, f => { f.document.readyState = 'loading'; },
    f => { f.context.cpr = {}; }, f => { delete f.rootControls.mdiCn; },
    f => { delete f.mdi.getTabItems; }, f => { delete f.mdi.getSelectedTabItem; },
    f => { delete f.mdi.setSelectedTabItem; }]) {
    const f = fixture(configurations[0], { selected: false });
    change(f);
    assert.equal(f.navigate(true), 'Unavailable');
    assert.equal(f.selectionEvents.length, 0);
    assert.equal(f.opens.length, 0);
    f.assertNoUnsafeActions();
  }
});

test('per-app observation records keep concurrent task queries and their completion separate', () => {
  const f = fixture(configurations[0]);
  const report = fixture(configurations[2]);
  f.apps.report = report.app;
  const reportTab = report.targetTab;
  f.tabs.push(reportTab);
  assert.equal(f.query(), 'Started');
  f.select(reportTab);
  assert.equal(f.query(true, configurations[2].kind), 'Started');
  assert.equal(f.actions.query, 1);
  assert.equal(report.actions.query, 1);
  report.complete();
  assert.equal(f.query(false, configurations[2].kind), 'Complete');
  f.select(f.targetTab);
  assert.equal(f.query(false), 'Started');
  f.complete();
  assert.equal(f.query(false), 'Complete');
  assert.equal(f.context.__oneClickStudentManagementQueryV1.size, 2);
  f.assertNoUnsafeActions();
  report.assertNoUnsafeActions();
});

test('disposed owners are cleaned before their replacement query is observed', () => {
  const f = fixture(configurations[0]);
  assert.equal(f.query(), 'Started');
  assert.equal(f.listenerCount(), 3);
  f.app.disposed = true;
  const replacement = { ...f.app, disposed: false };
  f.apps.target = replacement;
  f.targetTab.content = replacement;
  f.submission.status = 'IDLE';
  assert.equal(f.query(), 'Started');
  assert.equal(f.context.__oneClickStudentManagementQueryV1.size, 1);
  assert.equal(f.listenerCount(), 3, 'Only replacement listeners may remain.');
  f.complete();
  assert.equal(f.query(false), 'Complete');
  assert.equal(f.listenerCount(), 0);
});

test('replacing a submission cannot abandon an outstanding request or dispatch another query', () => {
  const f = fixture(configurations[0]);
  assert.equal(f.query(), 'Started');
  const replacement = { ...f.submission, status: 'IDLE' };
  f.controls.subStdntList = replacement;
  assert.equal(f.query(), 'Busy');
  assert.equal(f.actions.query, 1);
  assert.equal(f.listenerCount(), 3);
  f.submission.status = 'DONE';
  assert.equal(f.query(), 'Started');
  assert.equal(f.actions.query, 2);
  assert.equal(f.listenerCount(), 3);
});

test('the existing background report reader cannot be duplicated by an explicit notification click', () => {
  for (const elapsed of [0, 30_000, 30_001, 3_600_000]) {
    const f = fixture(configurations[2]);
    let cleanups = 0;
    const reader = { app: f.app, sub: f.submission, inFlight: true,
      startedAt: 1_000_000, done: false, success: true, cleanup() { cleanups++; } };
    f.context.__oneClickFieldTripReportReadV1 = reader;
    f.submission.status = 'SENDING';
    f.advance(elapsed);
    assert.equal(f.query(), 'Busy');
    assert.equal(f.actions.query, 0);
    assert.equal(cleanups, 0);
    assert.equal(reader.inFlight, true);
    f.assertNoUnsafeActions();
  }
  for (const status of ['IDLE', 'DONE']) {
    const f = fixture(configurations[2]);
    let cleanups = 0;
    const reader = { app: f.app, sub: f.submission, inFlight: true,
      startedAt: 1_000_000, done: false, success: true, cleanup() { cleanups++; } };
    f.context.__oneClickFieldTripReportReadV1 = reader;
    f.submission.status = status;
    f.advance(30_000);
    assert.equal(f.query(), 'Busy');
    assert.equal(cleanups, 0);
    f.advance(1);
    assert.equal(f.query(), 'Started');
    assert.equal(f.actions.query, 1);
    assert.equal(cleanups, 1);
    assert.equal(reader.inFlight, false);
    assert.equal(reader.done, true);
    assert.equal(reader.success, false);
    f.complete();
    assert.equal(f.query(false), 'Complete');
    assert.equal(f.listenerCount(), 0);
    f.assertNoUnsafeActions();
  }
});

test('a background reader owned by another app does not interfere with an explicit application query', () => {
  const f = fixture(configurations[0]);
  const other = fixture(configurations[2]);
  let cleanups = 0;
  const reader = { app: other.app, sub: other.submission, inFlight: true,
    startedAt: 1_000_000, cleanup() { cleanups++; } };
  f.context.__oneClickFieldTripReportReadV1 = reader;
  assert.equal(f.query(), 'Started');
  assert.equal(cleanups, 0);
  assert.equal(reader.inFlight, true);
  f.complete();
  assert.equal(f.query(false), 'Complete');
  f.assertNoUnsafeActions();
});

test('workflow selects or authorizes once, then checks actual 조회 completion without final submission', () => {
  const opening = source.split('private async Task<WorkflowResult> OpenStudentManagementAsync(')[1]
    .split('internal async Task QueryStudentManagementAsync(')[0];
  assert.ok(opening.indexOf('StudentManagementNavigationScript(') > opening.indexOf('WaitForNiceReadyAsync('));
  assert.ok(opening.indexOf('StudentManagementNavigationScript(') > opening.indexOf('ActivateTargetAsync('));
  assert.match(opening, /if \(state == "Missing"\)[\s\S]*?allowOpen: true/);
  assert.equal((opening.match(/allowOpen: true/g) ?? []).length, 1);
  assert.match(opening, /await QueryStudentManagementAsync\(kind, cancellationToken\)/);
  assert.match(opening, /KeepActivatedBrowser: true/);
  const querying = source.split('internal async Task QueryStudentManagementAsync(')[1]
    .split('// Only the verified CPR menu contracts')[0];
  assert.equal((querying.match(/startQuery: true/g) ?? []).length, 1);
  assert.match(querying, /var queryStarted = state == "Started"/);
  assert.match(querying, /while \(state is "Started" or "Loading"\)[\s\S]*?startQuery: !queryStarted/);
  assert.match(querying, /if \(state == "Started"\) queryStarted = true/);
  assert.match(querying, /if \(state != "Complete"\)/);
  assert.doesNotMatch(source, /ClickElementCenterAsync|ClickNiceMenuAsync|\.send\(|fetch\(|XMLHttpRequest|requestApproval|승인요청/);
});
