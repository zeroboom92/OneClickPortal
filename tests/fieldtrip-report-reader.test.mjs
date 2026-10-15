import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../NiceFieldTripReportReader.cs', import.meta.url), 'utf8');
const template = source.split('internal static string Script(')[1].split('return $$"""')[1].split('""";')[0];
const domain = 'sen.neis.go.kr';
const office = 'B10';
const script = startQuery => template
  .replace('{{JsonSerializer.Serialize(officeDomain)}}', JSON.stringify(domain))
  .replace('{{JsonSerializer.Serialize(officeCode)}}', JSON.stringify(office))
  .replace('{{(startQuery ? "true" : "false")}}', String(startQuery));
const appId = 'edu/sa/eds/eaa/ae/eds_eaaae02_m01';
const columns = ['ousExperLrnRltId', 'shlCd', 'ayr', 'eduActPrcsStsCd', 'atrzStsCd', 'atrzStsNm'];
const pending = (key = 'REPORT-A', extras = {}) => ({
  ousExperLrnRltId: key, shlCd: 'SCHOOL-A', ayr: '2026',
  eduActPrcsStsCd: '01', atrzStsCd: '', atrzStsNm: '미상신', ...extras,
});
const submitted = key => pending(key, { eduActPrcsStsCd: '02', atrzStsCd: '4', atrzStsNm: '완결' });

// Models the verified CPR app and its own 조회 submission. No network, login,
// approval-request button or report contents are needed to execute the real script.
function fixture(options = {}) {
  const searchValues = { shlCd: 'SCHOOL-A', ayr: '2026', grd: '1', cls: '1', ...options.search };
  const userValues = { userId: 'USER-A', ...options.user };
  const liveUserValues = { ...userValues, ...options.liveUser };
  let rows = options.rows ?? [pending(), ...Array.from({ length: 4 }, (_, i) => submitted(`DONE-${i}`))];
  let clicks = 0;
  let now = 1_000_000;
  let checkedRows = [];
  const listeners = new Map();
  const values = [];
  const data = {
    getColumnNames: () => [...columns],
    getRowCount: () => rows.length,
    getValue(row, name) {
      assert.ok(columns.includes(name), `Reader requested unneeded student data: ${name}`);
      values.push(name);
      return rows[row][name];
    },
  };
  const search = { getValue: name => searchValues[name], getDatas: () => ({ ...searchValues }) };
  const user = { getValue: name => userValues[name] };
  const liveUser = { getValue: name => liveUserValues[name] };
  const submission = {
    action: '../eds_eaa_ae02_002.do', status: 'IDLE', succeeded: true,
    isSuccess() { return this.succeeded; },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
    emit(name) { for (const handler of [...(listeners.get(name) ?? [])]) handler({ type: name }); },
  };
  const grid = { dataSet: data, readOnly: true, getCheckRowIndices: () => checkedRows };
  const button = {
    value: '조회', enabled: true,
    click() { clicks++; submission.status = 'SENDING'; options.onClick?.(result); },
  };
  const controls = { dsStdntListForRlt: data, dmSearch: search, dmUserInfo: user,
    subStdntList: submission, btnSearch: button, grdMain: grid };
  const app = { disposed: false, app: { id: appId }, lookup: name => controls[name] };
  const apps = { report: app, other: { disposed: false, app: { id: 'unrelated/page' } } };
  const dialogs = [];
  const document = { readyState: 'complete', body: { innerText: '' }, querySelectorAll: () => dialogs };
  const location = { protocol: 'https:', hostname: domain, pathname: '/index.html', href: `https://${domain}/index.html` };
  const context = vm.createContext({
    URL, document, location, Date: { now: () => now },
    getComputedStyle: element => element.style ?? { display: 'block', visibility: 'visible' },
    cpr: { core: { Platform: { INSTANCE: { getAllRunningAppInstances: () => apps } } } },
    createCommonUtil: () => ({ Auth: { getUserInfo: () => liveUser } }),
  });
  const result = {
    app, apps, data, search, searchValues, userValues, liveUserValues,
    submission, button, grid, controls, document, location, dialogs, context, values,
    clicks: () => clicks,
    advance: milliseconds => { now += milliseconds; },
    checked: value => { checkedRows = value; },
    rows: value => { rows = value; },
    run(startQuery = true) {
      return JSON.parse(JSON.stringify(vm.runInContext(script(startQuery), context, { timeout: 1000 })));
    },
    complete({ success = true, emitSuccess = success, status = 'DONE', done = true } = {}) {
      submission.succeeded = success;
      submission.status = status;
      submission.emit(emitSuccess ? 'submit-success' : 'submit-error');
      if (done) submission.emit('submit-done');
    },
    listenerCount: () => [...listeners.values()].reduce((count, handlers) => count + handlers.size, 0),
  };
  return result;
}

function completed(options = {}) {
  const f = fixture(options);
  assert.deepEqual(f.run(), { state: 'Started' });
  f.complete();
  return f;
}

test('queries once and reads the actual five-row pattern only after successful completion', () => {
  const f = fixture();
  assert.deepEqual(f.run(false), { state: 'SnapshotUnavailable' });
  assert.deepEqual(f.run(), { state: 'Started' });
  assert.equal(f.clicks(), 1);
  assert.deepEqual(f.run(), { state: 'Busy' });
  assert.deepEqual(f.run(false), { state: 'Started' });
  assert.equal(f.values.length, 0, 'The old dataset must not be read while querying.');
  f.complete();
  const actual = f.run(false);
  assert.deepEqual(actual, {
    state: 'Available', scope: JSON.stringify([office, 'USER-A', 'SCHOOL-A']),
    items: [JSON.stringify(['SCHOOL-A', '2026', 'REPORT-A'])],
  });
  assert.deepEqual(f.run(false), actual);
  assert.equal(f.clicks(), 1);
  assert.equal(f.listenerCount(), 0, 'Completion must remove its temporary listeners.');
});

test('a completed poll can be refreshed and every round has exactly one query', () => {
  const f = completed();
  assert.equal(f.run(false).items.length, 1);
  f.rows([pending(), pending('REPORT-B')]);
  assert.equal(f.run().state, 'Started');
  assert.equal(f.run().state, 'Busy');
  f.complete();
  assert.equal(f.run(false).items.length, 2);
  assert.equal(f.clicks(), 2);
  assert.equal(f.listenerCount(), 0);
});

test('a synchronous submission completion is still observed', () => {
  const f = fixture({ onClick: current => current.complete() });
  assert.equal(f.run().state, 'Started');
  assert.equal(f.run(false).state, 'Available');
  assert.equal(f.listenerCount(), 0);
});

test('submission error, missing success and a failed transport cannot yield a snapshot', () => {
  for (const completion of [{ success: false }, { success: true, emitSuccess: false }, { success: true, status: 'SENDING' }]) {
    const f = fixture();
    assert.equal(f.run().state, 'Started');
    f.complete(completion);
    assert.equal(f.run(false).state, 'QueryFailed');
    assert.equal(f.listenerCount(), 0);
  }
  const f = fixture();
  f.run();
  f.complete({ done: false });
  assert.equal(f.run(false).state, 'Started');
  assert.equal(f.values.length, 0);
});

test('query dispatch exceptions fail without leaving event listeners behind', () => {
  const f = fixture({ onClick: () => { throw new Error('query handler failed'); } });
  assert.equal(f.run().state, 'QueryFailed');
  assert.equal(f.run(false).state, 'QueryFailed');
  assert.equal(f.listenerCount(), 0);
  assert.equal(f.clicks(), 1);
});

test('a changed filter invalidates the previous result while the stable scope excludes class', () => {
  const f = completed();
  const first = f.run(false);
  f.searchValues.cls = '2';
  assert.equal(f.run(false).state, 'SnapshotUnavailable');
  assert.equal(f.run().state, 'Started');
  f.complete();
  const second = f.run(false);
  assert.equal(second.state, 'Available');
  assert.equal(second.scope, first.scope);
  assert.deepEqual(second.items, first.items);
});

test('account changes invalidate an in-flight snapshot and use the new account scope only after another query', () => {
  const f = fixture();
  f.run();
  f.userValues.userId = 'USER-B';
  f.liveUserValues.userId = 'USER-B';
  f.complete();
  assert.equal(f.run(false).state, 'SnapshotUnavailable');
  assert.equal(f.run().state, 'Started');
  f.complete();
  assert.equal(f.run(false).scope, JSON.stringify([office, 'USER-B', 'SCHOOL-A']));
});

test('missing identity or a mismatch with the current login prevents reads and queries', () => {
  for (const options of [{ user: { userId: '' } }, { liveUser: { userId: 'USER-B' } },
    { search: { shlCd: '' } }, { search: { ayr: '' } }]) {
    const f = fixture(options);
    assert.equal(f.run().state, 'ScopeUnavailable');
    assert.equal(f.clicks(), 0);
  }
});

test('checked rows, a disabled query or an editable grid block an automatic refresh', () => {
  for (const change of [f => f.checked([0]), f => { f.button.enabled = false; },
    f => { f.grid.readOnly = false; }, f => { f.submission.status = 'SENDING'; }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run().state, 'Busy');
    assert.equal(f.clicks(), 0);
  }
});

test('visible dialogs block refresh while hidden dialogs do not', () => {
  const dialog = { hidden: false, parentElement: null,
    getBoundingClientRect: () => ({ width: 100, height: 100 }) };
  const f = fixture();
  f.dialogs.push(dialog);
  assert.equal(f.run().state, 'Busy');
  dialog.hidden = true;
  assert.equal(f.run().state, 'Started');
});

test('duplicate live report apps are ambiguous and disposed copies are ignored', () => {
  const f = fixture();
  f.apps.copy = { ...f.app };
  assert.equal(f.run().state, 'Busy');
  assert.equal(f.clicks(), 0);
  f.apps.copy.disposed = true;
  assert.equal(f.run().state, 'Started');
});

test('an absent or unrelated report app is not a readable report page', () => {
  for (const change of [f => { delete f.apps.report; }, f => { f.app.disposed = true; },
    f => { f.app.app.id = `${appId}-other`; }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run().state, 'ReportPageMissing');
    assert.equal(f.clicks(), 0);
  }
});

test('unknown controls, a wrong dataset or a different submission action fail closed', () => {
  for (const change of [f => { delete f.controls.dmSearch; }, f => { f.grid.dataSet = {}; },
    f => { f.button.value = '상신'; }, f => { f.submission.action = '/requestApproval.do'; },
    f => { f.data.getColumnNames = () => columns.slice(1); }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run().state, 'SnapshotUnavailable');
    assert.equal(f.clicks(), 0);
  }
});

test('one invalid row key, school or year invalidates the entire result instead of accepting a valid prefix', () => {
  for (const row of [pending(''), pending('B', { shlCd: 'OTHER-SCHOOL' }), pending('B', { ayr: '2025' })]) {
    const f = completed({ rows: [pending('A'), row] });
    assert.deepEqual(f.run(false), { state: 'SnapshotUnavailable' });
  }
});

test('duplicate report rows share one durable key and completed reports do not notify', () => {
  const f = completed({ rows: [pending(), pending(), submitted('DONE')] });
  assert.deepEqual(f.run(false).items, [JSON.stringify(['SCHOOL-A', '2026', 'REPORT-A'])]);
  const empty = completed({ rows: [] });
  assert.deepEqual(empty.run(false).items, []);
});

test('inconsistent status code and label never create a pending report notification', () => {
  const f = completed({ rows: [pending('A', { atrzStsCd: '4' }), pending('B', { atrzStsNm: '완결' }),
    pending('C', { eduActPrcsStsCd: '99' }), submitted('D')] });
  assert.deepEqual(f.run(false).items, []);
});

test('a successfully completed report app is readable from an inactive internal tab', () => {
  const f = completed();
  f.app.visible = false;
  f.button.visible = false;
  f.grid.visible = false;
  assert.equal(f.run(false).state, 'Available');
  assert.equal(f.run(false).items.length, 1);
});

test('an unofficial host, HTTP, loading page or logged-out page cannot trigger 조회', () => {
  for (const change of [f => { f.location.hostname = `fake.${domain}`; },
    f => { f.location.hostname = `${domain}.example.com`; }, f => { f.location.protocol = 'http:'; },
    f => { f.document.readyState = 'loading'; }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run().state, 'SnapshotUnavailable');
    assert.equal(f.clicks(), 0);
  }
  for (const change of [f => { f.location.pathname = '/executeNeisLogout.do'; },
    f => { f.document.body.innerText = '나이스를 로그아웃 하였습니다'; }]) {
    const f = fixture();
    change(f);
    assert.equal(f.run().state, 'ScopeUnavailable');
    assert.equal(f.clicks(), 0);
  }
});

test('a timed-out observer is retired only after the submission is idle and a later query can recover', () => {
  for (const status of ['IDLE', 'DONE']) {
    const f = fixture();
    assert.equal(f.run().state, 'Started');
    f.submission.status = status;
    f.advance(30_000);
    assert.equal(f.run(false).state, 'Started', 'The observer must retain the full grace period.');
    assert.equal(f.listenerCount(), 3);
    f.advance(1);
    assert.equal(f.run(false).state, 'QueryFailed');
    assert.equal(f.listenerCount(), 0);
    assert.equal(f.run().state, 'Started');
    assert.equal(f.clicks(), 2);
    f.complete();
    assert.equal(f.run(false).state, 'Available');
    assert.equal(f.listenerCount(), 0);
  }
});

test('a genuinely outstanding submission is never queried again even after the observer timeout', () => {
  const f = fixture();
  assert.equal(f.run().state, 'Started');
  for (const elapsed of [30_001, 60_000, 3_600_000]) {
    f.advance(elapsed);
    assert.equal(f.run(false).state, 'Started');
    assert.equal(f.run().state, 'Busy');
    assert.equal(f.clicks(), 1);
    assert.equal(f.listenerCount(), 3);
  }
  f.complete();
  assert.equal(f.run(false).state, 'Available');
  assert.equal(f.listenerCount(), 0);
});

test('a replaced report app disposes the old pending observer before starting its own query', () => {
  const f = fixture();
  assert.equal(f.run().state, 'Started');
  const oldObservation = f.context.__oneClickFieldTripReportReadV1;
  assert.equal(f.listenerCount(), 3);
  f.app.disposed = true;
  f.apps.report = { ...f.app, disposed: false };
  f.submission.status = 'IDLE';
  assert.equal(f.run().state, 'Started');
  assert.equal(f.clicks(), 2);
  assert.notEqual(f.context.__oneClickFieldTripReportReadV1, oldObservation);
  assert.equal(f.listenerCount(), 3, 'Only the new observer may retain submission listeners.');
  f.complete();
  assert.equal(f.run(false).state, 'Available');
  assert.equal(f.listenerCount(), 0);
});

test('a query action on a different host or HTTP is rejected even when its pathname matches', () => {
  for (const action of [
    'https://other.example/eds_eaa_ae02_002.do',
    `https://${domain}.example.com/eds_eaa_ae02_002.do`,
    `http://${domain}/eds_eaa_ae02_002.do`,
    '//other.example/eds_eaa_ae02_002.do',
  ]) {
    const f = fixture();
    f.submission.action = action;
    assert.equal(f.run().state, 'SnapshotUnavailable');
    assert.equal(f.clicks(), 0);
    assert.equal(f.listenerCount(), 0);
  }
});
