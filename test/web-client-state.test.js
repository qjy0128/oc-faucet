import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const clientSource = await readFile(new URL('../web/web-client.js', import.meta.url), 'utf8');

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

function boot(fetchImpl) {
  const intervals = [];
  const state = {
    replacedUrl: null,
    storedToken: null,
  };
  const window = {};
  const context = {
    window,
    location: {
      href: 'http://127.0.0.1/?t=test-token',
      search: '?t=test-token',
      pathname: '/',
    },
    history: {
      replaceState(_data, _title, url) { state.replacedUrl = url; },
    },
    sessionStorage: {
      setItem(_key, value) { state.storedToken = value; },
      getItem() { return state.storedToken; },
    },
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    setInterval(callback, delay) {
      const timer = { callback, delay, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { timer.cleared = true; },
  };
  vm.runInNewContext(clientSource, context, { filename: 'web-client.js' });
  return { oc: window.oc, intervals, state };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('轮询失败通知断开，下一次成功仍交付快照', async () => {
  const snapshot = { phase: 'ready', models: [] };
  let calls = 0;
  const networkError = new Error('暂时连不上');
  const app = boot(async () => {
    calls += 1;
    if (calls === 1) throw networkError;
    return response(snapshot);
  });
  const states = [];
  const errors = [];

  app.oc.onState((value) => states.push(value), (error) => errors.push(error));
  await flush();

  assert.equal(errors.length, 1, '首次请求失败应报告连接错误');
  assert.equal(errors[0], networkError);
  assert.deepEqual(states, []);
  assert.equal(app.intervals[0].delay, 1500);

  app.intervals[0].callback();
  await flush();

  assert.deepEqual(states, [snapshot], '恢复后仍应向旧回调交付快照');
  assert.equal(errors.length, 1, '成功恢复本身不再发连接错误');
});

test('同一订阅的慢请求未完成时跳过本轮，不重叠请求', async (t) => {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const app = boot(() => {
    const request = deferred();
    requests.push(request);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return request.promise.finally(() => { inFlight -= 1; });
  });
  const unsubscribe = app.oc.onState(() => {});
  t.after(unsubscribe);

  app.intervals[0].callback();
  assert.equal(requests.length, 1, '第一次请求仍在途时，定时器不能再发请求');
  assert.equal(maxInFlight, 1);

  requests[0].resolve(response({ phase: 'ready' }));
  await flush();
  app.intervals[0].callback();
  assert.equal(requests.length, 2, '前一轮完成后应继续按间隔轮询');
  assert.equal(maxInFlight, 1);

  requests[1].resolve(response({ phase: 'ready' }));
  await flush();
});

test('取消订阅后，在途成功响应不再调用状态回调', async () => {
  const request = deferred();
  const app = boot(() => request.promise);
  let callbacks = 0;
  const unsubscribe = app.oc.onState(() => { callbacks += 1; });

  unsubscribe();
  request.resolve(response({ phase: 'ready' }));
  await flush();

  assert.equal(callbacks, 0);
  assert.equal(app.intervals[0].cleared, true);
});

test('取消订阅后，在途失败响应不再调用连接错误回调', async () => {
  const requests = [deferred(), deferred()];
  let requestIndex = 0;
  const app = boot(() => requests[requestIndex++].promise);
  let callbacks = 0;
  const errors = [];
  const unsubscribe = app.oc.onState(
    () => { callbacks += 1; },
    (error) => { errors.push(error); },
  );

  requests[0].reject(new Error('第一次失败'));
  await flush();
  assert.equal(errors.length, 1, '活动订阅中的失败应通知一次');

  app.intervals[0].callback();
  assert.equal(requestIndex, 2);
  unsubscribe();
  requests[1].reject(new Error('取消后断开'));
  await flush();

  assert.equal(callbacks, 0);
  assert.equal(errors.length, 1, '取消订阅后在途失败不应再通知');
});

test('旧版单参数订阅仍可收到快照', async (t) => {
  const app = boot(async () => response({ phase: 'ready', models: ['opencode/demo'] }));
  const states = [];
  const unsubscribe = app.oc.onState((value) => states.push(value));
  t.after(unsubscribe);
  await flush();

  assert.deepEqual(states, [{ phase: 'ready', models: ['opencode/demo'] }]);
});
