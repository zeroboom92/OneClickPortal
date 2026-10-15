import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../PortalWorkflowController.FieldTripReports.cs', import.meta.url), 'utf8');
const template = source.split('internal static string FieldTripReportPreparationScript(')[1]
  .split('=> $$"""')[1].split('""";')[0];
const domain = 'jbe.neis.go.kr';
const reportId = 'edu/sa/eds/eaa/ae/eds_eaaae02_m01';
const title = '교외체험학습보고서관리';
const columns = ['MENU_ID', 'MENU_NM', 'V_MENU_ID', 'V_UP_MENU_ID', 'CALL_PAGE',
  'SHOW_YN', 'menuUseYn', 'inqAccesAuthYn'];
const script = allowOpen => template
  .replace('{{JsonSerializer.Serialize(officeDomain)}}', JSON.stringify(domain))
  .replace('{{(allowOpen ? "true" : "false")}}', String(allowOpen));

function branch(prefix, rootName = '학급담임') {
  return [rootName, '교육활동신청관리', '교외체험학습관리', title].map((name, index) => ({
    MENU_ID: index === 3 ? 'AMEDS40511' : `${prefix}-MENU-${index}`,
    MENU_NM: name, V_MENU_ID: `${prefix}-${index}`,
    V_UP_MENU_ID: index === 0 ? '' : `${prefix}-${index - 1}`,
    CALL_PAGE: index === 3 ? reportId : '', SHOW_YN: 'Y', menuUseYn: 'Y', inqAccesAuthYn: 'Y',
  }));
}

// Models the verified CPR menu hierarchy, menu permission handler and embedded app.
// No portal request, report query or approval action is executed by these fixtures.
function fixture({ report = true, rows = [...branch('teacher'), ...branch('other', '교무학사')] } = {}) {
  const opens = [];
  const tabs = [];
  const dialogs = [];
  const searchValues = { shlCd: 'SCHOOL', ayr: '2026', grd: '1', clsCd: '1' };
  const userValues = { userId: 'USER' };
  const liveUserValues = { userId: 'USER' };
  const search = { getValue: key => searchValues[key] };
  const user = { getValue: key => userValues[key] };
  const liveUser = { getValue: key => liveUserValues[key] };
  const data = {};
  const sub = { action: '/eds_eaa_ae02_002.do', status: 'IDLE' };
  const button = { value: '조회', enabled: true, click: () => { throw new Error('Preparation must never query.'); } };
  let checkedRows = [];
  const grid = { dataSet: data, readOnly: true, getCheckRowIndices: () => checkedRows };
  const controls = { dmSearch: search, dmUserInfo: user, btnSearch: button,
    subStdntList: sub, grdMain: grid, dsStdntListForRlt: data,
    cmbAyr: { getUDCApp: () => ({}) }, cmbOrgGrd: { getUDCApp: () => ({}) }, cmbClsCd: { getUDCApp: () => ({}) } };
  const app = { app: { id: reportId }, disposed: false, lookup: key => controls[key] };
  const ds = { getColumnNames: () => [...columns], getRowCount: () => rows.length,
    getValue: (index, key) => rows[index][key], getRow: index => rows[index] };
  const auth = { action: '/menuCheckAuth.do', status: 'IDLE' };
  const parameterValues = { strMenuParamVal: '' };
  const mdi = { getTabItems: () => tabs };
  const rootControls = { mdiCn: mdi, dsAllMenu: ds, subAuth: auth,
    dmMenuParam: { getValue: key => parameterValues[key] } };
  const module = { openMenuItem(argument, caller) {
    opens.push({ argument, caller });
    tabs.push({ _menuKey: 'AMEDS40511', text: title });
  } };
  const root = { app: { id: 'app/com/main/Index' }, disposed: false,
    lookup: key => rootControls[key], getModule: () => module };
  const apps = { root, ...(report ? { report: app } : {}) };
  const document = { readyState: 'complete', querySelectorAll: () => dialogs };
  const location = { protocol: 'https:', hostname: domain, href: `https://${domain}/jsp/main.jsp` };
  const context = vm.createContext({
    URL, document, location,
    cpr: { core: { Platform: { INSTANCE: { getAllRunningAppInstances: () => apps } } } },
    createCommonUtil: () => ({ Auth: { getUserInfo: () => liveUser } }),
    getComputedStyle: element => element.style ?? { display: 'block', visibility: 'visible' },
  });
  return { opens, tabs, dialogs, rows, searchValues, userValues, liveUserValues,
    data, sub, button, grid, controls, ds, auth, parameterValues, rootControls,
    module, root, app, apps, document, location, context,
    checked: value => { checkedRows = value; },
    run: (allowOpen = false) => vm.runInContext(script(allowOpen), context, { timeout: 1000 }),
  };
}

test('an existing ready report app is reused without opening a menu or clicking 조회', () => {
  const f = fixture();
  assert.equal(f.run(), 'Ready');
  assert.equal(f.run(true), 'Ready');
  assert.equal(f.opens.length, 0);
  delete f.rootControls.dsAllMenu;
  delete f.rootControls.subAuth;
  assert.equal(f.run(true), 'Ready', 'Existing app readiness must not open or reauthorize a menu.');
});

test('a missing app stays read-only until opening is explicitly allowed', () => {
  const f = fixture({ report: false });
  assert.equal(f.run(), 'Missing');
  assert.equal(f.run(), 'Missing');
  assert.equal(f.opens.length, 0);
});

test('opens exactly the authorized 학급담임 branch despite identical MENU_ID in another role', () => {
  const f = fixture({ report: false });
  assert.equal(f.run(true), 'Started');
  assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0].argument.row, f.rows[3]);
  assert.equal(f.opens[0].caller, 'btnTlbrMn');
  assert.equal(Object.keys(f.opens[0].argument).join(), 'row');
  assert.equal(f.run(), 'Opening');
  assert.equal(f.run(true), 'Opening');
  assert.equal(f.opens.length, 1, 'A pending tab must never be added twice.');
  f.apps.report = f.app;
  assert.equal(f.run(), 'Ready');
});

test('an existing pending tab is recognized by menu key, app id or exact title without duplication', () => {
  for (const tab of [{ _menuKey: 'AMEDS40511' }, { content: { app: { id: reportId } } }, { text: title }]) {
    const f = fixture({ report: false });
    f.tabs.push(tab);
    assert.equal(f.run(true), 'Opening');
    assert.equal(f.opens.length, 0);
  }
});

test('another role alone, a broken parent chain or a loop never opens a report menu', () => {
  const other = fixture({ report: false, rows: branch('other', '교무학사') });
  assert.equal(other.run(true), 'MenuMissing');
  assert.equal(other.opens.length, 0);
  for (const change of [f => { f.rows[2].V_UP_MENU_ID = 'missing'; },
    f => { f.rows[1].V_UP_MENU_ID = f.rows[2].V_MENU_ID; },
    f => { f.rows[0].MENU_NM = '다른역할'; }]) {
    const f = fixture({ report: false });
    change(f);
    assert.equal(f.run(true), 'MenuMissing');
    assert.equal(f.opens.length, 0);
  }
});

test('duplicate exact paths or ambiguous parent keys are rejected', () => {
  const paths = fixture({ report: false, rows: [...branch('teacher'), ...branch('duplicate')] });
  assert.equal(paths.run(true), 'Ambiguous');
  assert.equal(paths.opens.length, 0);
  const parents = fixture({ report: false });
  parents.rows.push({ ...parents.rows[2] });
  assert.equal(parents.run(true), 'MenuMissing');
  assert.equal(parents.opens.length, 0);
});

test('missing inquiry permission, hidden/disabled menus and unverified page targets cannot be opened', () => {
  for (const change of [f => { f.rows[3].inqAccesAuthYn = 'N'; },
    f => { f.rows[3].SHOW_YN = 'N'; }, f => { f.rows[3].menuUseYn = 'N'; },
    f => { f.rows[3].CALL_PAGE = 'unrelated/page'; }, f => { f.rows[3].MENU_NM = `${title} 상신`; }]) {
    const f = fixture({ report: false });
    change(f);
    assert.equal(f.run(true), 'MenuMissing');
    assert.equal(f.opens.length, 0);
  }
});

test('menu preparation refuses external, insecure or unrelated authorization endpoints', () => {
  for (const action of ['https://other.example/menuCheckAuth.do', `http://${domain}/menuCheckAuth.do`,
    `https://${domain}.example.com/menuCheckAuth.do`, '/requestApproval.do']) {
    const f = fixture({ report: false });
    f.auth.action = action;
    assert.equal(f.run(true), 'Unavailable');
    assert.equal(f.opens.length, 0);
  }
});

test('in-flight authorization and existing menu parameters block opening', () => {
  for (const change of [f => { f.auth.status = 'SENDING'; },
    f => { f.parameterValues.strMenuParamVal = 'existing-task-parameters'; }]) {
    const f = fixture({ report: false });
    change(f);
    assert.equal(f.run(true), 'Busy');
    assert.equal(f.opens.length, 0);
  }
});

test('visible dialogs block both reuse and opening while hidden dialogs do not', () => {
  for (const report of [false, true]) {
    const f = fixture({ report });
    const dialog = { hidden: false, parentElement: null,
      getBoundingClientRect: () => ({ width: 100, height: 100 }) };
    f.dialogs.push(dialog);
    assert.equal(f.run(true), 'Busy');
    assert.equal(f.opens.length, 0);
    dialog.hidden = true;
    assert.equal(f.run(true), report ? 'Ready' : 'Started');
  }
});

test('checked rows, an editable grid, disabled 조회 and an in-flight query block readiness', () => {
  for (const change of [f => f.checked([0]), f => { f.grid.readOnly = false; },
    f => { f.button.enabled = false; }, f => { f.sub.status = 'SENDING'; }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run(true), 'Busy');
    assert.equal(f.opens.length, 0);
  }
});

test('incomplete report controls or unfinished authorized search selectors keep preparation loading', () => {
  for (const change of [f => { delete f.controls.dmSearch; }, f => { f.searchValues.shlCd = ''; },
    f => { f.searchValues.ayr = ''; }, f => { f.userValues.userId = ''; },
    f => { f.controls.cmbOrgGrd.getUDCApp = () => null; }, f => { f.searchValues.clsCd = ''; },
    f => { f.controls.cmbClsCd.getUDCApp = undefined; },
    f => { f.controls.cmbShlCrseScCd = { getUDCApp: () => ({}) }; }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run(true), 'Loading');
    assert.equal(f.opens.length, 0);
  }
  const f = fixture();
  delete f.controls.cmbOrgGrd;
  delete f.controls.cmbClsCd;
  assert.equal(f.run(), 'Ready', 'Removed authorized selectors must not block readiness.');
});

test('wrong account, query action, dataset or button label fail without a query or menu action', () => {
  for (const change of [f => { f.liveUserValues.userId = 'OTHER'; },
    f => { f.sub.action = 'https://other.example/eds_eaa_ae02_002.do'; },
    f => { f.sub.action = `http://${domain}/eds_eaa_ae02_002.do`; },
    f => { f.sub.action = '/requestApproval.do'; },
    f => { f.grid.dataSet = {}; }, f => { f.button.value = '상신'; }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run(true), 'Unavailable');
    assert.equal(f.opens.length, 0);
  }
});

test('unofficial hosts, insecure pages, missing menu contracts and loading documents fail closed', () => {
  for (const change of [f => { f.location.hostname = `${domain}.example.com`; },
    f => { f.location.protocol = 'http:'; }, f => { f.document.readyState = 'loading'; },
    f => { delete f.rootControls.subAuth; }, f => { f.module.openMenuItem = undefined; },
    f => { f.ds.getColumnNames = () => columns.slice(1); },
    f => { f.context.cpr = {}; }]) {
    const f = fixture({ report: false });
    change(f);
    assert.equal(f.run(true), 'Unavailable');
    assert.equal(f.opens.length, 0);
  }
});

test('duplicate live roots, report apps or report tabs are ambiguous; disposed apps are ignored', () => {
  for (const change of [f => { f.apps.rootCopy = { ...f.root }; },
    f => { f.apps.reportCopy = { ...f.app }; },
    f => { f.tabs.push({ text: title }, { _menuKey: 'AMEDS40511' }); }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run(true), 'Ambiguous');
    assert.equal(f.opens.length, 0);
  }
  const f = fixture();
  f.apps.oldRoot = { ...f.root, disposed: true };
  f.apps.oldReport = { ...f.app, disposed: true };
  assert.equal(f.run(), 'Ready');
});
