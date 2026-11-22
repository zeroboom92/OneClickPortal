import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../PortalWorkflowController.NiceApproval.cs', import.meta.url), 'utf8');
const dispatch = fs.readFileSync(new URL('../PortalWorkflowController.cs', import.meta.url), 'utf8');
const domain = 'jbe.neis.go.kr';
const appId = 'edu/cm/wam/woa/pm/wam_woapm02_m00';
const title = '미결/협조함';
const row = () => ({ menuNm: title, menuId: 'AMWAM40012', pgeId: 'wam_woapm02_m00', callPage: appId });
const template = source.split('internal static string NiceApprovalNavigationScript(')[1]
  .split('=> $$"""')[1].split('""";')[0];
function script(allowOpen) {
  const result = template.replace('{{JsonSerializer.Serialize(officeDomain)}}', JSON.stringify(domain))
    .replace('{{(allowOpen ? "true" : "false")}}', String(allowOpen));
  assert.doesNotMatch(result, /\{\{/);
  return result;
}
function fixture({ existing = false, selected = false, rows = [row()], onOpen } = {}) {
  const actions = { final: 0, network: 0, documentReads: 0 };
  const owners = {};
  const dialogs = [];
  const opens = [];
  const selections = [];
  const otherTab = { _menuKey: 'other', text: '다른 업무', content: { app: { id: 'other/app' } } };
  const target = { _menuKey: appId, text: title, content: { app: { id: appId } } };
  const tabs = [otherTab, ...(existing ? [target] : [])];
  let current = existing && selected ? target : otherTab;
  let preventSelection = false;
  const mdi = {
    getTabItems: () => tabs,
    getSelectedTabItem: () => current,
    setSelectedTabItem(next) {
      selections.push(next);
      if (!preventSelection) current = next;
    },
  };
  const values = { userId: 'ACCOUNT-A' };
  const liveValues = { userId: 'ACCOUNT-A' };
  const parameters = { strMenuParamVal: '' };
  const data = { getColumnNames: () => ['menuNm', 'menuId', 'pgeId', 'callPage', 'apvlCnt'],
    getRowCount: () => rows.length, getValue: (index, key) => rows[index][key] };
  const auth = { status: 'IDLE' };
  const module = { doOpenNoMenu(...args) {
    opens.push(args);
    onOpen?.(f);
  } };
  const controls = { mdiCn: mdi, dsApproval: data, dmUserInfo: { getValue: key => values[key] },
    subAuth: auth, dmMenuParam: { getValue: key => parameters[key] } };
  const root = { app: { id: 'app/com/main/Index' }, disposed: false,
    lookup(key) {
      assert.ok(Object.hasOwn(controls, key), `Unexpected control access: ${key}`);
      return controls[key];
    }, getModule: () => module };
  const child = { app: { id: appId }, disposed: false,
    lookup() { actions.documentReads++; throw new Error('Documents must never be read.'); } };
  if (existing) owners.child = child;
  const apps = { root, ...owners };
  const document = { readyState: 'complete', body: { innerText: '' },
    querySelectorAll(selector) {
      assert.equal(selector, '[role="dialog"],.cl-dialog');
      return dialogs;
    } };
  const location = { protocol: 'https:', hostname: domain, pathname: '/jsp/main.jsp' };
  const context = vm.createContext({ URL, document, location,
    cpr: { core: { Platform: { INSTANCE: { getAllRunningAppInstances: () => apps } } } },
    createCommonUtil: () => ({ Auth: { getUserInfo: () => ({ getValue: key => liveValues[key] }) } }),
    getComputedStyle: element => element.style ?? { display: 'block', visibility: 'visible' },
    fetch() { actions.network++; throw new Error('Direct requests are forbidden.'); },
    XMLHttpRequest() { actions.network++; throw new Error('Direct requests are forbidden.'); },
  });
  const f = { rows, opens, selections, actions, root, child, tabs, target, apps, dialogs,
    auth, module, controls, data, values, liveValues, parameters, document, location, context,
    read: (allow = false) => vm.runInContext(script(allow), context),
    preventSelection: value => { preventSelection = value; },
    selected: () => current,
  };
  return f;
}
const modal = ({ hidden = false, display = 'block', visibility = 'visible' } = {}) => ({
  hidden, style: { display, visibility }, parentElement: null,
  getBoundingClientRect: () => ({ width: 100, height: 100 }),
});

test('opens only the verified normal Nice approval menu and reuses the resulting tab', () => {
  const f = fixture();
  assert.equal(f.read(), 'Missing');
  assert.equal(f.opens.length, 0);
  assert.equal(f.read(true), 'Started');
  assert.deepEqual(f.opens, [[appId, title]], 'Use the exact two arguments used by onSnavAppvlItemClick.');
  // Slow loading and polling must not create another request.
  assert.equal(f.read(), 'Missing');
  assert.equal(f.opens.length, 1);
  f.tabs.push(f.target);
  assert.equal(f.read(), 'Opening');
  f.apps.child = f.child;
  assert.equal(f.read(), 'Selected');
  assert.equal(f.selected(), f.target);
  assert.equal(f.opens.length, 1);
  assert.deepEqual(f.actions, { final: 0, network: 0, documentReads: 0 });
});

test('existing approval tabs preserve the normal cancellable selection behavior', () => {
  const f = fixture({ existing: true });
  f.preventSelection(true);
  assert.equal(f.read(true), 'Busy');
  assert.equal(f.opens.length, 0);
  f.preventSelection(false);
  assert.equal(f.read(), 'Selected');
  assert.equal(f.selected(), f.target);
  const selections = f.selections.length;
  assert.equal(f.read(true), 'Selected');
  assert.equal(f.selections.length, selections, 'Already selected tabs need no further selection.');
  assert.equal(f.actions.documentReads, 0);
});

test('visible modals and in-flight menu requests block opening and selecting', () => {
  for (const existing of [false, true]) {
    const f = fixture({ existing });
    f.dialogs.push(modal());
    assert.equal(f.read(true), 'Busy');
    assert.equal(f.opens.length + f.selections.length, 0);
    f.dialogs[0].hidden = true;
    f.auth.status = 'SENDING';
    assert.equal(f.read(true), 'Busy');
    f.auth.status = 'IDLE';
    f.parameters.strMenuParamVal = '{"ongoing":"menu"}';
    assert.equal(f.read(true), 'Busy');
  }
  const f = fixture();
  f.dialogs.push(modal({ display: 'none' }));
  assert.equal(f.read(true), 'Started');
});

test('missing, altered and duplicate approval menu rows are rejected before opening', () => {
  for (const key of ['menuId', 'menuNm', 'pgeId', 'callPage']) {
    const changed = row();
    changed[key] = key === 'callPage' ? 'edu/cm/wam/woa/pm/wam_woapm03_m00' : 'OTHER';
    const f = fixture({ rows: [changed] });
    assert.equal(f.read(true), 'MenuMissing', key);
    assert.equal(f.opens.length, 0);
  }
  for (const [rows, state] of [[[], 'MenuMissing'], [[row(), row()], 'Ambiguous']]) {
    const f = fixture({ rows });
    assert.equal(f.read(true), state);
    assert.equal(f.opens.length, 0);
  }
  const missingSchema = fixture();
  missingSchema.data.getColumnNames = () => ['menuId', 'callPage'];
  assert.equal(missingSchema.read(true), 'Unavailable');
});

test('multiple roots, tabs, owners and conflicting page identities cannot pick an arbitrary target', () => {
  const mutations = [
    f => { f.apps.root2 = f.root; },
    f => { f.tabs.push({ ...f.target }); },
    f => { f.apps.child2 = f.child; },
    f => { f.target.content = { app: { id: 'other/app' } }; },
  ];
  for (const mutate of mutations) {
    const f = fixture({ existing: true });
    mutate(f);
    assert.equal(f.read(true), 'Ambiguous');
    assert.equal(f.opens.length + f.selections.length, 0);
  }
  const orphan = fixture();
  orphan.apps.child = orphan.child;
  assert.equal(orphan.read(true), 'Ambiguous');
});

test('logged-out or changed accounts and other hosts cannot navigate', () => {
  const cases = [
    [f => { f.location.pathname = '/executeNeisLogout.do'; }, 'Expired'],
    [f => { f.document.body.innerText = '나이스를 로그아웃하였습니다'; }, 'Expired'],
    [f => { f.values.userId = ''; }, 'Expired'],
    [f => { f.liveValues.userId = 'ACCOUNT-B'; }, 'Expired'],
    [f => { f.location.protocol = 'http:'; }, 'Unavailable'],
    [f => { f.location.hostname = `${domain}.example.com`; }, 'Unavailable'],
    [f => { f.document.readyState = 'loading'; }, 'Unavailable'],
  ];
  for (const [mutate, expected] of cases) {
    const f = fixture({ existing: true });
    mutate(f);
    assert.equal(f.read(true), expected);
    assert.equal(f.opens.length + f.selections.length, 0);
  }
});

test('Nice approval dispatch uses only list navigation and retains the shared target presentation flow', () => {
  assert.match(dispatch, /AbsenceReportManagement,\s*NiceApproval,/);
  assert.match(dispatch, /PortalTaskKind\.NiceApproval => OpenNiceApprovalAsync\(cancellationToken\)/);
  assert.match(source, /await GetFieldTripNiceTargetAsync\(cancellationToken\)/);
  assert.match(source, /await WaitForNiceReadyAsync\(session, cancellationToken\)/);
  assert.match(source, /await PrepareBrowserForUserAsync\(session, cancellationToken\)/);
  assert.match(source, /KeepActivatedBrowser: true/);
  assert.equal((source.match(/allowOpen: true/g) ?? []).length, 1);
  assert.doesNotMatch(source, /\.click\(|\.send\(|fetch\(|XMLHttpRequest|btnApproval|btnSubmit|QueryStudentManagementAsync|\.addItemWithApp\(/);
});
