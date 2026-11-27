import test from 'node:test';
import assert from 'node:assert/strict';
import {generateRewriteCandidate, rewriteDraft} from './codex-draft-rewrite.mjs';

test('accepts useful concrete steps without length or semantic-review rejection', async () => {
  const draft = '排查按钮不显示的原因，先不要修改代码。';
  const prompt = '排查按钮不显示的原因：先检查渲染条件和相关日志，再整理发现；不要修改代码。';
  let rules;
  const fetchLocal = async (_url, init) => {
    rules = JSON.parse(init.body).messages[0].content;
    return {ok:true, json:async () => ({done:true, message:{content:JSON.stringify({prompt})}})};
  };
  assert.deepEqual(await rewriteDraft(draft,null,fetchLocal,{detailed:true}), {status:'ok',text:prompt});
  assert.match(rules,/concrete steps/);
  assert.match(rules,/prohibitions/);
});

test('malformed model output still cannot be written back', async () => {
  const fetchLocal = async () => ({ok:true,json:async () => ({done:true,message:{content:'not json'}})});
  const draft = '排查按钮';
  const result = await rewriteDraft(draft,null,fetchLocal,{detailed:true});
  assert.equal(result.status,'ok');
  assert.ok(result.text.startsWith(draft + '\n\n'));
  assert.doesNotMatch(result.text,/not json/);
});

test('protects explicit paths, prohibitions and approval, and rejects invented targets', async () => {
  const cases = [
    ['检查 `src/app.ts` 的超时是否为 30 秒。','检查 `src/main.ts` 的超时是否为 30 秒。'],
    ['检查按钮，不要修改代码。','检查按钮并修改代码。'],
    ['先分析问题，等我确认后再修改代码。','分析问题，然后修改代码。'],
    ['先分析问题，等我确认后再修改代码。','分析按钮问题，等我确认后再修改代码。'],
    ['先分析问题，等我确认后再修改代码。','先修改代码，再等待我确认。'],
    ['列出 A 和 B 的问题。','列出 A 的问题。'],
    ['把页面改得更好看。','改进页面布局；在实施修改前，请先确认用户是否授权。'],
    ['帮我优化网站加载速度。','评估网站加载速度，并提供优化建议。']
  ];
  for (const [draft,prompt] of cases) {
    const response = async () => ({ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})});
    assert.equal((await generateRewriteCandidate(draft,null,response,{detailed:true})).status,'invalid',draft);
    assert.ok((await rewriteDraft(draft,null,response)).startsWith(draft + '\n\n'),draft);
  }
});

test('unchanged, offline and timeout results add relevant steps exactly once', async t => {
  const draft = '检查超时是否为 30 秒，不要修改配置。';
  const replies = [
    async () => ({ok:true,json:async()=>({message:{content:JSON.stringify({prompt:draft})}})}),
    async () => { throw new Error('offline'); },
    async (_url, {signal}) => { signal.throwIfAborted(); }
  ];
  for (const reply of replies) {
    const timeout = reply === replies.at(-1) ? t.mock.method(AbortSignal,'timeout',() => AbortSignal.abort()) : null;
    let calls = 0;
    const result = await rewriteDraft(draft,null,(...args) => { calls++; return reply(...args); },{selection:true});
    timeout?.mock.restore();
    assert.equal(calls,1);
    assert.ok(result.startsWith(draft + ' '));
    assert.match(result,/核对配置值及单位/);
    assert.doesNotMatch(result,/\n/);
  }
});

test('cancellation and invalid input cannot produce a fallback', async () => {
  const controller = new AbortController();
  const cancelled = await rewriteDraft('检查按钮',null,async () => {
    controller.abort();
    throw new Error('cancelled');
  },{detailed:true, signal:controller.signal});
  assert.deepEqual(cancelled,{status:'cancelled',text:''});
  assert.deepEqual(await rewriteDraft(' ',null,() => assert.fail(),{detailed:true}),{status:'invalid',text:''});
});

test('allows numbered inspection steps and equivalent prohibitions', async () => {
  const draft = '检查 `src/app.ts` 的超时是否为 30 秒，不要修改配置。';
  const prompt = '1. 定位 `src/app.ts` 的超时设置。\n2. 核对是否为 30 秒并记录差异。\n3. 保持配置不变。';
  const response = async () => ({ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})});
  assert.equal(await rewriteDraft(draft,null,response),prompt);
});

