import assert from "node:assert/strict";
import test from "node:test";
import {installButton} from "./codex-draft-button.mjs";
import {containsCredential, readRecentContext, referencesPreviousTurn, rewriteDraft, translateDraft} from "./codex-draft-rewrite.mjs";

test("only explicit references in the draft request conversation context", () => {
  for (const draft of ["继续改，按钮还是没跟着主题变色", "按刚才那版继续", "这个增强提示词的按钮能不能更聪明", "Continue from the last change"]) {
    assert.equal(referencesPreviousTurn(draft), true, draft);
  }
  for (const draft of [
    "解释这个报错，先别改代码",
    "写一篇继续教育的通知",
    "用「按刚才那版」当示例",
    "解释这个例子：\n> 继续改，按钮还是没变色",
    "解释这段代码：\n\x60\x60\x60js\n// 继续改\n\x60\x60\x60",
    "解释 \"same as above\" 的含义"
  ]) {
    assert.equal(referencesPreviousTurn(draft), false, draft);
  }
});

test("the Ollama request contains only the draft and any applicable paired context", async () => {
  const calls = [];
  const fetchLocal = async (url, options) => {
    calls.push({url, options, body: JSON.parse(options.body)});
    return {ok: true, json: async () => ({message: {content: JSON.stringify({prompt: "  解释这个报错，不要修改代码。  "})}})};
  };
  const context = [
    {user:"更旧的话题",assistant:"不应带入"},
    {user:"讨论按钮",assistant:"使用原生按钮"},
    {user:"按钮要和 Codex 的界面一致",assistant:"已复用原生按钮主题样式",tool:"do not include"}
  ];
  const expected = [
    {user:"讨论按钮",assistant:"使用原生按钮"},
    {user:"按钮要和 Codex 的界面一致",assistant:"已复用原生按钮主题样式"}
  ];
  const ordinary = "解释这个报错，先别改代码";
  const continued = "继续改，按钮还是没跟着主题变色";
  assert.equal(await rewriteDraft(ordinary, context, fetchLocal), "解释这个报错，不要修改代码。");
  await rewriteDraft(continued, context, fetchLocal);
  await rewriteDraft(continued, null, fetchLocal);
  for (const call of calls) {
    assert.equal(call.url, "http://127.0.0.1:11434/api/chat");
    assert.equal(call.options.redirect, "error");
    assert.equal(call.body.model, "qwen3.5:4b");
    assert.deepEqual(call.body.format.required, ["prompt"]);
    assert.deepEqual(call.body.messages.map(message => message.role), ["system", "user"]);
  }
  const inputs = calls.map(call => JSON.parse(call.body.messages[1].content));
  assert.deepEqual(inputs, [
    {draft: ordinary, recent_context: expected},
    {draft: continued, recent_context: expected},
    {draft: continued}
  ]);
});

test("unavailable, empty, and truncated Ollama results cannot replace the draft", async () => {
  for (const fetchLocal of [
    async () => { throw new Error("offline"); },
    async () => ({ok: false}),
    async () => ({ok: true, json: async () => ({message: {content: "  "}})}),
    async () => ({ok: true, json: async () => ({message: {content: '{"prompt":"  "}'}})}),
    async () => ({ok: true, json: async () => ({done_reason: "length", message: {content: "partial"}})})
  ]) {
    assert.equal(await rewriteDraft("检查按钮样式", null, fetchLocal), "");
  }
});

test("context cannot narrow a standalone test request or pick an explicitly unresolved target", async () => {
  for (const [draft,assistant,prompt] of [
    ["Run the tests.","We are discussing the undo button.","Run the tests for the undo button."],
    ["Make it rounder.","Both buttons are possible; neither has been chosen.","Make the Send button rounder."]
  ]) {
    let sent = false;
    const fetchLocal = async (_url,{body}) => {
      sent = !!JSON.parse(JSON.parse(body).messages[1].content).recent_context;
      return {ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})};
    };
    assert.equal(await rewriteDraft(draft,[{user:"Discuss the two buttons.",assistant}],fetchLocal),draft);
    assert.equal(sent,true);
  }
});

test("a short reference can use an explicitly selected name from the older turn without copying its actions", async () => {
  const turns = [
    {user:"The selected control is the translation undo button.",assistant:"Understood."},
    {user:"Keep the visual appearance simple.",assistant:"Yes."}
  ];
  const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{
    content:'{"prompt":"Make the translation undo button rounder and keep the appearance simple."}'
  }})});
  assert.equal(await rewriteDraft("Make it rounder.",turns,fetchLocal),"Make the translation undo button rounder.");
});

test("a rewrite cannot drop an explicit prohibition against editing code", async () => {
  const draft = "Explain ERR_INVALID_ARG_TYPE. Do not change code.";
  const fetchLocal = async () => ({
    ok: true, json: async () => ({message: {content: '{"prompt":"Change the code to fix ERR_INVALID_ARG_TYPE."}'}})
  });
  assert.equal(await rewriteDraft(draft, null, fetchLocal), "");
  assert.deepEqual(await rewriteDraft(draft, null, fetchLocal, {detailed:true}), {
    status:"review", text:"Change the code to fix ERR_INVALID_ARG_TYPE."
  });
});

test("rewrites cannot reverse sequences, invert conditions or introduce destructive actions", async () => {
  for (const [draft,prompt,status] of [
    ["先检查日志，再修复问题。","先修复问题，再检查日志。","review"],
    ["如果测试通过就部署。","如果测试失败就部署。","review"],
    ["先备份文件，再修改配置。","修改配置，然后备份文件。","review"],
    ["修复问题","修复问题并删除数据库","review"],
    ["First run tests, then deploy.","First deploy, then run tests.","review"],
    ["先检查日志，再修复问题。","请先检查日志，再修复问题。","ok"],
    ["Fix the button.","Fix the button.","ok"]
  ]) {
    const fetchLocal=async()=>({ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})});
    assert.equal((await rewriteDraft(draft,null,fetchLocal,{detailed:true})).status,status,prompt);
  }
});

test("equivalent restrictions pass and introduced restrictions do not", async () => {
  const run = (draft, prompt) => rewriteDraft(draft, null,
    async () => ({ok:true, json:async () => ({message:{content:JSON.stringify({prompt})}})}), {detailed:true});
  assert.equal((await run("Explain. Do not change code.", "请解释。先不要修改任何代码。")).status, "ok");
  assert.equal((await run("查一下原因", "查一下原因，不要修改代码。")).status, "review");
});

test("local failures are distinguishable without producing a replacement", async () => {
  assert.deepEqual(await rewriteDraft("test", null, async () => ({ok:false, status:404}), {detailed:true}), {status:"missing-model", text:""});
  const controller = new AbortController();
  controller.abort();
  const fetchLocal = async (_url, {signal}) => signal.throwIfAborted();
  assert.deepEqual(await rewriteDraft("test", null, fetchLocal, {detailed:true, signal:controller.signal}), {status:"cancelled", text:""});
});

test("rewrite rejects changed technical literals, lost approval and model commentary", async () => {
  const sample = "请检查 src/app.ts 的延迟，超时 30 秒，运行 `npm test`。";
  const cases = [
    [sample, "检查 src/main.ts 的延迟，超时 30 秒，运行 `npm test`。", "review"],
    [sample, "检查 src/app.ts 的延迟，超时 3 秒，运行 `npm test`。", "review"],
    [sample, "检查 src/app.ts 的延迟，超时 30 毫秒，运行 `npm test`。", "review"],
    [sample, "检查 src/app.ts 的延迟，超时 30 秒，运行 `npm run test`。", "review"],
    [sample, "检查 src/app.ts 的延迟（超时 30 秒），运行 `npm test`。", "ok"],
    ["先给方案，等我确认后再实施。", "给出方案后直接实施。", "review"],
    ["先给方案，等我确认后再实施。", "请先提供解决方案，待我确认后再接着实施。", "ok"],
    ["先给方案，等我确认后再实施。", "先给方案，等我确认后再实施。现在先实施。", "review"],
    ["只给方案。", "制定方案并立即实施。", "review"],
    ["查一下按钮为何没显示", "优化后的提示词：请检查按钮未显示的原因。", "invalid"]
  ];
  for (const [draft,prompt,status] of cases) {
    const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})});
    assert.equal((await rewriteDraft(draft,null,fetchLocal,{detailed:true})).status,status,prompt);
  }
});

test("numeric requirements cannot be swapped or assigned to another action", async () => {
  const draft = "设置连接超时为10秒，最多重试3次。";
  for (const [prompt, status] of [
    ["设置连接超时为3秒，最多重试10次。", "review"],
    ["设置重试为10秒，最多超时3次。", "review"],
    ["请设置连接超时为10秒，最多重试3次。", "ok"]
  ]) {
    const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})});
    assert.equal((await rewriteDraft(draft,null,fetchLocal,{detailed:true})).status,status,prompt);
  }
});

test("numeric bounds cannot be reversed and questions cannot become assertions", async () => {
  for (const [draft,prompt,status] of [
    ["至少等待30秒。", "最多等待30秒。", "review"],
    ["超时上限为30秒。", "超时下限为30秒。", "review"],
    ["是否支持离线模式？", "支持离线模式。", "review"],
    ["Does Codex support offline mode?", "Codex supports offline mode.", "review"],
    ["是否支持离线模式？", "请说明是否支持离线模式。", "ok"]
  ]) {
    const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})});
    assert.equal((await rewriteDraft(draft,null,fetchLocal,{detailed:true})).status,status,prompt);
  }
});

test("a request to investigate cannot grow into a request to modify", async () => {
  for (const [draft,prompt,status] of [
    ["分析按钮不显示的原因。", "分析并修复按钮不显示的问题。", "review"],
    ["继续检查按钮。", "继续检查按钮并修复。", "review"],
    ["Investigate why the button is missing.", "Investigate and fix the missing button.", "review"],
    ["检查配置。", "检查并写入配置。", "review"],
    ["Check the configuration.", "Check the configuration and save it.", "review"],
    ["分析并修复按钮不显示的问题。", "请分析并修复按钮不显示的问题。", "ok"]
  ]) {
    const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})});
    assert.equal((await rewriteDraft(draft,null,fetchLocal,{detailed:true})).status,status,prompt);
  }
});

test("checking cannot become an obligation to ensure a configuration state", async () => {
  for (const [draft,prompt,status] of [
    ["检查 `src/app.ts` 的超时，超时30秒。", "检查 `src/app.ts` 中的超时设置，确保其值为 30 秒。", "review"],
    ["排查超时问题。", "排查超时问题，保证配置正确。", "review"],
    ["Check the timeout is 30 seconds.", "Check the timeout and ensure it is 30 seconds.", "review"],
    ["检查超时是否为30秒。", "确认超时是否为30秒。", "ok"],
    ["检查配置，保证不修改文件。", "检查配置，确保不修改文件。", "ok"],
    ["检查配置，并确保超时为30秒。", "请检查配置，并确保超时为30秒。", "ok"],
    ["检查配置并按需修复。", "请检查配置并按需修复。", "ok"]
  ]) {
    const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})});
    assert.equal((await rewriteDraft(draft,null,fetchLocal,{detailed:true})).status,status,prompt);
  }
});

test("inspection phrasing is guarded without blocking an explicitly authorized setting change", async () => {
  for (const [draft,prompt,status] of [
    ["请你检查配置。", "请你检查配置并确保配置正确。", "review"],
    ["帮我查一下延迟。", "帮我检查延迟，确保结果正常。", "review"],
    ["Please help me check the timeout.", "Please help me check the timeout and ensure it is configured correctly.", "review"],
    ["检查配置并把超时改成30秒。", "检查配置并确保超时为30秒。", "ok"],
    ["Check config and set timeout to 30 seconds.", "Check config and ensure timeout is 30 seconds.", "ok"]
  ]) {
    const fetchLocal=async()=>({ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})});
    assert.equal((await rewriteDraft(draft,null,fetchLocal,{detailed:true})).status,status,prompt);
  }
});

test("a rewrite does not inject prior assistant text or a large unsolicited template", async () => {
  const history = "我们已经详细检查过界面按钮的主题状态、样式继承、不同窗口之间的数据传递以及这些环节对应的错误处理方式。";
  const context = [{user:"之前排查过按钮。",assistant:history}];
  for (const [draft,prompt,status] of [
    ["继续检查按钮。", `继续检查按钮。${history}`, "review"],
    ["检查按钮。", "请以资深软件架构师和产品专家的身份，先详细介绍项目背景与职责，再制定完整实施计划、编写测试用例、列出风险清单并进行总结。", "review"],
    [history, history, "ok"]
  ]) {
    const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})});
    assert.equal((await rewriteDraft(draft,context,fetchLocal,{detailed:true})).status,status,prompt);
  }
});

test("an analysis mentioning why is not required to remain a question", async () => {
  const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{
    content:JSON.stringify({prompt:"分析按钮不显示的原因，不要修改代码。"})
  }})});
  assert.equal((await rewriteDraft("分析按钮为什么不显示，别修改代码。",null,fetchLocal,{detailed:true})).status,"ok");
});

test("selected send button is a control, not an instruction to send", async () => {
  const turns = [{user:"我选了发送按钮",assistant:"好的。"}];
  const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{content:'{"prompt":"发送按钮"}'}})});
  assert.deepEqual(await rewriteDraft("把它改成蓝色。",turns,fetchLocal,{detailed:true}),
    {status:"ok",text:"把发送按钮改成蓝色。"});
});

test("a model cannot choose between multiple context objects without an explicit selection", async () => {
  const turns = [{user:"发送按钮和取消按钮都在。",assistant:"这两个控件都需要检查。"}];
  const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{content:'{"prompt":"发送按钮"}'}})});
  assert.deepEqual(await rewriteDraft("把它改成蓝色。",turns,fetchLocal,{detailed:true}),
    {status:"ok",text:"把它改成蓝色。"});
});

test("a rewrite cannot copy an earlier user message into the current request", async () => {
  const history = "上一轮确认原生按钮已经可以跟随主题颜色，随后还测试了鼠标悬停时提示文字的位置和深色模式下的对比度。";
  const draft = "继续检查按钮，并查看主题切换时是否有误。";
  const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{
    content:JSON.stringify({prompt:draft + history})
  }})});
  const result = await rewriteDraft(draft,[{user:history,assistant:"收到。"}],fetchLocal,{detailed:true});
  assert.equal(result.status,"review");
});

test("a newer selection replaces an older one and an unspecified switch remains unresolved", async () => {
  const fetchLocal = async () => ({ok:true,json:async()=>({done:true,message:{content:'{"prompt":"取消按钮"}'}})});
  const earlier = {user:"我选了发送按钮",assistant:"好的。"};
  const draft = "把它改成蓝色。";
  assert.deepEqual(await rewriteDraft(draft,[earlier,{user:"现在改选取消按钮",assistant:"明白。"}],fetchLocal,{detailed:true}),
    {status:"ok",text:"把取消按钮改成蓝色。"});
  assert.deepEqual(await rewriteDraft(draft,[earlier,{user:"换另一个",assistant:"明白。"}],fetchLocal,{detailed:true}),
    {status:"ok",text:draft});
});

const candidateReply = prompt => async () => ({
  ok:true, json:async () => ({done:true,message:{content:JSON.stringify({prompt})}})
});

test("a rewrite rejects newly copied short history clauses from either role", async () => {
  const draft = "继续检查按钮。";
  const context = [{user:"列出侧栏行为。",assistant:"请检查焦点。"}];
  for (const prompt of [draft + "列出侧栏行为。", "继续检查按钮，检查焦点。", draft + "\n- 请列出侧栏行为。"]) {
    const result = await rewriteDraft(draft,context,candidateReply(prompt),{detailed:true});
    assert.equal(result.status,"review",prompt);
  }
  const requested = "继续检查按钮，列出侧栏行为。";
  assert.equal(await rewriteDraft(requested,context,candidateReply("请" + requested)), "请" + requested);
});

test("a rewrite rejects an added repeat of a complete clause", async () => {
  for (const [draft,prompt] of [
    ["检查按钮。", "检查按钮，检查按钮。"],
    ["Inspect the button.", "Inspect the button. Please inspect the button."],
    ["检查按钮。检查按钮。", "检查按钮。检查按钮。检查按钮。"]
  ]) {
    assert.equal((await rewriteDraft(draft,null,candidateReply(prompt),{detailed:true})).status,"review",prompt);
  }
  const requestedRepeat = "检查按钮。检查按钮。";
  assert.equal(await rewriteDraft(requestedRepeat,null,candidateReply(requestedRepeat)),requestedRepeat);
});

test("rewriting preserves which deliverables the draft requests", async () => {
  for (const [draft,prompt] of [
    ["检查这个按钮。", "检查按钮，给报告。"],
    ["检查按钮。", "检查按钮并提供背景说明和验收报告。"],
    ["排查按钮状态。", "排查按钮状态并总结结果。"],
    ["Inspect the button.", "Inspect the button and provide a checklist."],
    ["检查按钮，提供验收清单。", "检查按钮。"]
  ]) {
    assert.equal((await rewriteDraft(draft,null,candidateReply(prompt),{detailed:true})).status,"review",prompt);
  }
  for (const [draft,prompt] of [
    ["检查按钮，提供验收清单。", "检查按钮，列出验收清单。"],
    ["检查按钮与验收报告。", "请检查按钮和验收报告。"],
    ["Inspect the button and write a brief summary.", "Inspect the button and summarize it briefly."]
  ]) {
    assert.equal(await rewriteDraft(draft,null,candidateReply(prompt)),prompt,prompt);
  }
});

test("a faithful ordinary rewrite falls back when it grows by more than four code points", async () => {
  const draft = "按钮颜色跟随主题。";
  const smallChange = "让按钮的颜色跟随当前主题。";
  const longChange = "请让按钮的颜色跟随当前界面所使用的主题。";
  assert.equal(await rewriteDraft(draft,null,candidateReply(smallChange)),smallChange);
  assert.deepEqual(await rewriteDraft(draft,null,candidateReply(longChange),{detailed:true}),
    {status:"ok",text:draft});
});

test("a shorter rewrite must keep the event that triggers a check", async () => {
  const draft = "检查切换到浅色主题时按钮背景色是否同步。";
  const staticCheck = "检查浅色主题下按钮背景色是否同步。";
  const shorter = "检查切到浅色主题时按钮背景色是否同步。";
  assert.equal((await rewriteDraft(draft,null,candidateReply(staticCheck),{detailed:true})).status,"review");
  assert.equal(await rewriteDraft(draft,null,candidateReply(shorter)),shorter);
});

test("a confirmed reference can add a longer name without copying other instructions", async () => {
  const draft = "把它改成蓝色。";
  const context = [
    {user:"我选了主页面右侧的发送按钮",assistant:"把主页面右侧的发送按钮改成蓝色。"},
    {user:"知道了。",assistant:"列出按钮的历史改动。"}
  ];
  const result = await rewriteDraft(draft,context,candidateReply("主页面右侧的发送按钮，同时列出按钮的历史改动。"));
  assert.equal(result,"把主页面右侧的发送按钮改成蓝色。");
});

test("a reference cannot be replaced when the selected name is ambiguous or unavailable", async () => {
  const draft = "把它改成蓝色。";
  const reply = candidateReply("把发送按钮改成蓝色。");
  assert.equal(await rewriteDraft(draft,[{user:"我选了发送按钮和取消按钮",assistant:"收到。"}],reply),draft);
  assert.equal(await rewriteDraft(draft,[{user:"我选了发送按钮或者取消按钮",assistant:"等你决定。"}],reply),draft);
  assert.equal(await rewriteDraft(draft,[{user:"我选了发送按钮并列出历史改动",assistant:"收到。"}],reply),draft);
  assert.equal(await rewriteDraft(draft,null,reply),draft);
});

test("rewrite enforces the response schema even when the model does not", async () => {
  for (const body of [
    {done:false,message:{content:'{"prompt":"Rewrite"}'}},
    {done:true,message:{content:'{"prompt":"Rewrite","analysis":"Not part of the response"}'}}
  ]) {
    const fetchLocal = async () => ({ok:true,json:async()=>body});
    assert.equal((await rewriteDraft("Draft",null,fetchLocal,{detailed:true})).status,"invalid");
  }
});

test("rewrite does not pass recognized credentials in the draft or previous turn", async () => {
  const credential = "Authorization: Bearer synthetic-test-token";
  let calls = 0;
  const fetchLocal = async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(options.body).messages[1].content, JSON.stringify({draft:"继续改这个按钮"}));
    return {ok:true,json:async()=>({done:true,message:{content:'{"prompt":"继续改这个按钮"}'}})};
  };
  assert.equal((await rewriteDraft(credential,null,fetchLocal,{detailed:true})).status,"invalid");
  assert.equal(calls,0);
  assert.equal(await rewriteDraft("继续改这个按钮",{user:credential,assistant:"收到"},fetchLocal),"继续改这个按钮");
  assert.equal(calls,1);
});

function verifyRendererFixture(document, window, install, references, readContext) {
  document.body.innerHTML = `
    <div data-app-action-sidebar-thread-selected="true" data-app-action-sidebar-thread-id="test-a"></div>
    <div class="thread-scroll-container">
      <div class="transcriptContent-test">
        <div data-local-conversation-user-anchor><div data-user-message-bubble>旧问题</div></div>
        <div data-local-conversation-final-assistant><div data-markdown-text-style="assistant-message">旧答复</div></div>
        <div data-local-conversation-user-anchor><div data-user-message-bubble>按钮想跟随主题<button>附件按钮</button></div></div>
        <div data-tool-output>工具输出</div>
        <div data-local-conversation-final-assistant><div data-markdown-text-style="assistant-message">按钮沿用原生样式</div></div>
        <div data-local-conversation-user-anchor><div data-user-message-bubble>&lt;hook_prompt hook_run_id="test"&gt;内部指令</div></div>
        <div data-local-conversation-final-assistant><div data-markdown-text-style="assistant-message">内部回复</div></div>
      </div>
      <div class="ComposerLayoutFooter-test">
        <div class="ProseMirror" contenteditable="true"><p>初始草稿</p></div>
        <button aria-label="添加文件等内容">+</button>
      </div>
    </div>`;
  const editor = document.querySelector(".ProseMirror");
  const transcript = document.querySelector(".transcriptContent-test");
  const sidebar = document.querySelector("[data-app-action-sidebar-thread-selected]");
  const calls = [], replacements = [];
  window.__requestLocalDraftRewrite = payload => calls.push(JSON.parse(payload));
  document.execCommand = (command, _ui, result) => {
    replacements.push({command, result});
    editor.querySelector("p").textContent = result;
    return true;
  };

  install(references, readContext);
  const button = document.querySelector("[data-local-draft-rewrite]");
  function click(draft) {
    document.getSelection().removeAllRanges();
    editor.querySelector("p").textContent = draft;
    button.click();
    return calls.at(-1);
  }
  const recentContext = readContext(editor);
  const standalone = click("解释这个报错，先别改代码");
  window.__finishLocalDraftRewrite(standalone.key, "");

  const contextual = click("继续改，按钮还是没跟着主题变色");
  editor.querySelector("p").textContent = "用户的新内容";
  editor.dispatchEvent(new Event("input"));
  editor.querySelector("p").textContent = contextual.text;
  window.__finishLocalDraftRewrite(contextual.key, "不要覆盖用户编辑");

  const moved = click("继续改");
  sidebar.setAttribute("data-app-action-sidebar-thread-id", "test-b");
  window.__finishLocalDraftRewrite(moved.key, "不要覆盖另一个聊天");

  const userBody = transcript.querySelectorAll("[data-user-message-bubble]")[1];
  const assistantBody = transcript.querySelectorAll('[data-markdown-text-style="assistant-message"]')[1];
  userBody.textContent = "😀".repeat(600);
  assistantBody.textContent = "主题".repeat(800);
  const bounded = readContext(editor);

  const unfinished = document.createElement("div");
  unfinished.setAttribute("data-local-conversation-user-anchor", "");
  unfinished.innerHTML = "<div data-user-message-bubble>尚未回复的新问题</div>";
  transcript.append(unfinished);
  const noContext = click("接着改");
  editor.querySelector("p").setAttribute("data-normalized", "");
  editor.dispatchEvent(new Event("input"));
  window.__finishLocalDraftRewrite(noContext.key, "合法改写结果");
  const reviewed = click("别改代码");
  window.__finishLocalDraftRewrite(reviewed.key, {status:"review", text:"直接修复"});
  const guarded = editor.innerText === "别改代码" && !document.querySelector("[data-local-draft-actions]");
  const cancelled = click("取消后的结果不能回填");
  button.click();
  window.__finishLocalDraftRewrite(cancelled.key, "迟到的结果");
  const cancelledLocally = calls.at(-1)?.cancel === true && !button.hasAttribute("aria-busy");
  const original = click("这是原稿");
  window.__finishLocalDraftRewrite(original.key, {status:"ok", text:"改写稿"});
  window.__localDraftButtonObserver.disconnect();

  return {
    recentContext, sentContext: contextual.context, standaloneHasContext: "context" in standalone,
    unavailableHasContext: "context" in noContext, replacements, buttonType: button.type, guarded, cancelledLocally,
    boundedLengths: [Array.from(bounded.at(-1).user).length, Array.from(bounded.at(-1).assistant).length]
  };
}

const port = process.env.CODEX_DRAFT_TEST_PORT;
async function renderFixture(fixture) {
  const targets = await (await fetch(`http://127.0.0.1:${Number(port)}/json/list`)).json();
  const target = targets.find(item => item.type === "page" && item.url === "app://-/index.html");
  assert.ok(target, "Codex renderer must be running with the local debug endpoint");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Renderer fixture timed out")), 8000);
      socket.onerror = () => { clearTimeout(timer); reject(new Error("Renderer unavailable")); };
      socket.onmessage = ({data}) => {
        const reply = JSON.parse(data);
        if (reply.id !== 1) return;
        clearTimeout(timer);
        if (reply.error || reply.result?.exceptionDetails) {
          reject(new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails)));
        } else {
          resolve(reply.result.result.value);
        }
      };
      socket.onopen = () => socket.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate", params: {returnByValue: true, awaitPromise:true, expression: `(async () => {
          const frame = globalThis.document.createElement("iframe");
          frame.style.cssText = "position:fixed;left:-2000px;width:320px;height:300px;border:0";
          globalThis.document.body.append(frame);
          try {
            const document = frame.contentDocument;
            const window = frame.contentWindow;
            const location = {href: "app://-/index.html"};
            return await (${fixture})(document, window, (${installButton}), (${referencesPreviousTurn}),
              editor => (${readRecentContext})(editor, ${containsCredential}));
          } finally { frame.remove(); }
        })()`}
      }));
    });
  } finally {
    socket.close();
  }
}

test("renderer pairs the latest real messages and ignores stale or failed rewrites", {skip: !port}, async () => {
  const context = [{user:"旧问题",assistant:"旧答复"},{user:"按钮想跟随主题",assistant:"按钮沿用原生样式"}];
  assert.deepEqual(await renderFixture(verifyRendererFixture), {
    recentContext: context, sentContext: context, standaloneHasContext: true,
    unavailableHasContext: false, replacements: ["合法改写结果", "改写稿"].map(result => ({command:"insertText", result})),
    guarded: true, cancelledLocally: true,
    buttonType: "button", boundedLengths: [500, 1500]
  });
});

function verifySelectedRewrite(document, window, install, references, readContext) {
  document.body.innerHTML = '<div class="ComposerLayoutFooter-test"><div class="ProseMirror" contenteditable="true"><p>相同，相同。</p><p>下一段</p></div><button aria-label="添加文件等内容">+</button></div>';
  const editor = document.querySelector(".ProseMirror");
  const requests = [];
  window.__requestLocalDraftRewrite = payload => requests.push(JSON.parse(payload));
  install(references, readContext);
  const button = document.querySelector("[data-local-draft-rewrite]");
  const select = (start, end, last = editor.firstChild.firstChild) => {
    const range = document.createRange();
    range.setStart(editor.firstChild.firstChild, start);
    range.setEnd(last, end);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  editor.focus();
  select(3, 5);
  button.click();
  const sent = requests.at(-1);
  select(0, 2);
  window.__finishLocalDraftRewrite(sent.key, {status:"ok", text:"改写"});
  const changed = editor.firstChild.textContent;
  document.execCommand("undo");
  const restored = editor.firstChild.textContent;
  select(3, 5);
  button.click();
  window.__finishLocalDraftRewrite(requests.at(-1).key, {status:"ok", text:"相同"});
  const noUndo = editor.firstChild.textContent === restored && button.getAttribute("aria-label") === "原文无需改写";
  select(3, 5);
  button.click();
  const cancelled = requests.at(-1);
  button.click();
  window.__finishLocalDraftRewrite(cancelled.key, {status:"ok", text:"迟到"});
  const cancelProtected = requests.at(-1).cancel === true && editor.firstChild.textContent === restored;
  select(3, 5);
  button.click();
  const stale = requests.at(-1);
  editor.firstChild.firstChild.appendData("编辑");
  editor.dispatchEvent(new Event("input"));
  window.__finishLocalDraftRewrite(stale.key, {status:"ok", text:"迟到"});
  const notOverwritten = editor.firstChild.textContent.endsWith("编辑");
  const count = requests.length;
  select(0, 1, editor.lastChild.firstChild);
  button.click();
  return {sent:sent.text, changed, restored, noUndo, notOverwritten, cancelProtected, crossParagraphBlocked: requests.length === count};
}

test("rewrites and restores only the selected occurrence", {skip: !port}, async () => {
  assert.deepEqual(await renderFixture(verifySelectedRewrite), {
    sent:"相同", changed:"相同，改写。", restored:"相同，相同。",
    noUndo:true, notOverwritten:true, cancelProtected:true, crossParagraphBlocked:true
  });
});

function verifySafetyAndUndo(document, window, install, references, readContext) {
  document.body.innerHTML = '<div class="ComposerLayoutFooter-test"><div class="ProseMirror" contenteditable="true"><p>Please check the log now.</p></div><button aria-label="添加文件等内容">+</button></div>';
  const editor = document.querySelector('.ProseMirror');
  const calls = [];
  window.__requestLocalDraftRewrite = payload => calls.push(JSON.parse(payload));
  install(references, readContext);
  const button = document.querySelector('[data-local-draft-rewrite]');
  const range = document.createRange();
  range.setStart(editor.firstChild.firstChild, 6);
  range.setEnd(editor.firstChild.firstChild, 17);
  editor.focus();
  document.getSelection().removeAllRanges();
  document.getSelection().addRange(range);
  button.click();
  window.__finishLocalDraftRewrite(calls.at(-1).key, {status:'ok',text:'inspect the'});
  const rewritten = editor.innerText;
  const undo = document.querySelector('[data-local-draft-undo][aria-label="撤销增强"]');
  undo?.click();
  const restored = editor.innerText;
  editor.innerHTML = '<p>Keep <strong>bold</strong> and <em>italic</em>.</p>';
  document.getSelection().removeAllRanges();
  const before = editor.innerHTML;
  const count = calls.length;
  button.click();
  const richBlocked = calls.length === count && editor.innerHTML === before && button.getAttribute('aria-label') === '仅支持纯文本草稿';
  const visible = document.querySelector('[data-local-draft-status]')?.textContent;
  editor.innerHTML = '<p>检查问题</p>';
  editor.dispatchEvent(new Event('input'));
  button.click();
  window.__finishLocalDraftRewrite(calls.at(-1).key, {status:'review',text:''});
  return {rewritten,hasUndo:!!undo,restored,richBlocked,visible,review:button.getAttribute('aria-label'),reviewVisible:document.querySelector('[data-local-draft-status]')?.textContent};
}

test('selection preserves spaces, rich text is protected, and review is visible with undo', {skip: !port}, async () => {
  assert.deepEqual(await renderFixture(verifySafetyAndUndo), {
    rewritten:'Please inspect the log now.',hasUndo:true,restored:'Please check the log now.',
    richBlocked:true,visible:'仅支持纯文本草稿',review:'可能改变原意，已保留原文',reviewVisible:'可能改变原意，已保留原文'
  });
});

function verifyOneButton(document, window, install, references, readContext) {
  document.body.innerHTML = '<div class="ComposerLayoutFooter-test"><div class="ProseMirror" contenteditable="true"><p>测试</p></div><button aria-label="添加文件等内容">+</button></div>';
  window.__requestLocalDraftRewrite = () => {};
  install(references, readContext);
  const button = document.querySelector("[data-local-draft-rewrite]");
  const icon = button.innerHTML;
  button.click();
  const busy = button.hasAttribute("aria-busy") && button.innerHTML !== icon;
  const single = document.querySelectorAll("button").length === 2 && !document.querySelector("[data-local-draft-actions]");
  button.click();
  return {busy, single, reset:!button.hasAttribute("aria-busy") && button.innerHTML === icon};
}

test("progress and cancellation use only the existing button", {skip: !port}, async () => {
  assert.deepEqual(await renderFixture(verifyOneButton), {busy:true, single:true, reset:true});
});

test("scope and conditional changes are not auto-filled", async () => {
  for (const [draft, prompt, status] of [
    ["只改星芒按钮，别动发送键", "同时修改星芒按钮和发送键", "review"],
    ["只改星芒按钮，别动发送键", "请仅修改星芒按钮，不要改动发送键", "ok"],
    ["只改按钮、侧栏", "只改按钮", "review"],
    ["Do not change code.", "Do not change code until the issue is diagnosed, then apply a fix.", "review"],
    ["Do not change code.", "Do not change code. Then apply a fix.", "review"],
    ["Do not change code. Then ask me for approval.", "Do not change code.", "review"],
    ["Do not change code.", "请不要修改任何代码。", "ok"],
    ["只诊断这个问题。", "只分析这个问题。然后修复。", "review"]
  ]) {
    const fetchLocal = async () => ({ok:true, json:async () => ({message:{content:JSON.stringify({prompt})}})});
    assert.equal((await rewriteDraft(draft,null,fetchLocal,{detailed:true})).status,status,prompt);
  }
});

function verifyWriteback(document, window, install, references, readContext) {
  document.body.innerHTML = '<div class="ComposerLayoutFooter-test"><div class="ProseMirror" contenteditable="true"><p>原稿</p></div><button aria-label="添加文件等内容">+</button></div>';
  const editor = document.querySelector(".ProseMirror");
  let request;
  window.__requestLocalDraftRewrite = payload => { request = JSON.parse(payload); };
  install(references, readContext);
  const button = document.querySelector("[data-local-draft-rewrite]");
  function run(actual, returned) {
    editor.firstChild.textContent = "原稿";
    document.getSelection().removeAllRanges();
    document.execCommand = () => { editor.firstChild.textContent = actual; return returned; };
    button.click();
    window.__finishLocalDraftRewrite(request.key,{status:"ok",text:"新稿"});
    return [editor.innerText,button.getAttribute("aria-label")];
  }
  return [run("原稿",true),run("部分文字",true),run("新稿",false)];
}

test("writeback reports the actual editor contents, not the command flag", {skip: !port}, async () => {
  assert.deepEqual(await renderFixture(verifyWriteback), [
    ["原稿","未回填，已保留原文"], ["部分文字","回填结果不一致，请检查草稿"], ["新稿","增强提示词"]
  ]);
});

async function verifyHoverFeedback(document, window, install, references, readContext) {
  document.body.innerHTML = '<div data-app-action-sidebar-thread-selected="true" data-app-action-sidebar-thread-id="1"></div><div class="ComposerLayoutFooter-test"><div class="ProseMirror" contenteditable="true"><p>原稿</p></div><button aria-label="添加文件等内容">+</button></div>';
  let request;
  window.__requestLocalDraftRewrite = payload => { request = JSON.parse(payload); };
  install(references, readContext);
  const button = document.querySelector("[data-local-draft-rewrite]");
  const editor = document.querySelector(".ProseMirror");
  const enter = () => button.dispatchEvent(new PointerEvent("pointerenter", {pointerType:"mouse"}));
  const leave = () => button.dispatchEvent(new PointerEvent("pointerleave", {pointerType:"mouse"}));
  const tip = () => document.querySelector("[data-local-draft-tooltip]");
  const wait = () => new Promise(resolve => setTimeout(resolve, 420));
  const finish = () => window.__finishLocalDraftRewrite(request.key,{status:"ok",text:"原稿"});
  enter();
  await wait();
  const initial = tip();
  button.click();
  const busy = tip()?.textContent;
  finish();
  const same = tip() === initial;
  const outcome = tip()?.textContent;
  button.click();
  leave();
  finish();
  await wait();
  const noPopup = !tip();
  enter();
  await wait();
  const later = tip()?.textContent;
  editor.firstChild.textContent = "新草稿";
  editor.dispatchEvent(new Event("input"));
  const cleared = tip()?.textContent;
  editor.firstChild.textContent = "原稿";
  button.click();
  finish();
  document.querySelector("[data-app-action-sidebar-thread-id]").setAttribute("data-app-action-sidebar-thread-id","2");
  await Promise.resolve();
  return {busy,same,outcome,noPopup,later,cleared,switched:tip()?.textContent};
}

test("feedback updates the existing hover without reopening after pointerleave", {skip: !port}, async () => {
  assert.deepEqual(await renderFixture(verifyHoverFeedback), {
    busy:"优化中，点击取消",same:true,outcome:"原文无需改写",noPopup:true,
    later:"原文无需改写",cleared:"增强提示词",switched:"增强提示词"
  });
});

test("translation preserves protected text and never sends conversation context", async () => {
  const mock = prompt => async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (input.candidate) {
      assert.deepEqual(input,{source:"保留 __KEEP_0__，等待 __KEEP_1__ 秒",candidate:prompt});
      return {ok:true,json:async()=>({done:true,message:{content:'{"verdict":"pass","issues":[]}'}})};
    }
    assert.deepEqual(input, {text:"保留 __KEEP_0__，等待 __KEEP_1__ 秒",target:"English"});
    return {ok:true,json:async()=>({done:true,message:{content:JSON.stringify({prompt})}})};
  };
  const draft = "保留 `src/app.ts`，等待 30 秒";
  assert.deepEqual(await translateDraft(draft,mock("Keep __KEEP_0__, wait __KEEP_1__ seconds.")), {status:"ok",text:"Keep `src/app.ts`, wait 30 seconds."});
  assert.equal((await translateDraft(draft,mock("Keep the file."))).status,"invalid");
});

test("English translation requires an explicit clean review", async () => {
  for (const [draft,prompt,verdict,issue] of [
    ["可能是缓存问题","The cache is the root cause.","fail","certainty"],
    ["已确认是缓存问题","It might be the cache.","fail","certainty"],
    ["回滚这个版本","Restart this version.","fail","terminology"],
    ["等我确认后再执行","Execute it now.","fail","action_boundary"],
    ["暂时不要部署","Do not deploy yet.","uncertain","readability"],
    ["暂时不要部署","Do not deploy yet.","pass","facts"]
  ]) {
    let calls = 0;
    const fetchLocal = async () => {
      const result = ++calls === 1 ? {prompt} : {verdict,issues:[issue]};
      return {ok:true,json:async()=>({done:true,message:{content:JSON.stringify(result)}})};
    };
    assert.deepEqual(await translateDraft(draft,fetchLocal),{status:"invalid",text:""},prompt);
    assert.equal(calls,2);
  }
});

test("cancellation during English review prevents writeback", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchLocal = async (_url, {signal}) => ({
    ok:true, json:async() => {
      if (++calls === 1) return {done:true,message:{content:'{"prompt":"Do not deploy yet."}'}};
      controller.abort();
      assert.equal(signal.aborted,true);
      return {done:true,message:{content:'{"verdict":"pass","issues":[]}'}};
    }
  });
  assert.deepEqual(await translateDraft("暂时不要部署",fetchLocal,{signal:controller.signal}),{status:"cancelled",text:""});
});

test("English review shares the time budget started before translation", async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal,"timeout",() => deadline.signal);
  let calls = 0;
  const fetchLocal = async (_url, {signal}) => ({
    ok:true,json:async() => {
      if (++calls === 1) return {done:true,message:{content:'{"prompt":"Roll back this version."}'}};
      deadline.abort();
      assert.equal(signal.aborted,true);
      return {done:true,message:{content:'{"verdict":"pass","issues":[]}'}};
    }
  });
  assert.deepEqual(await translateDraft("回滚这个版本",fetchLocal),{status:"timeout",text:""});
  assert.equal(calls,2);
});

test("translation into Chinese still uses a single request", async () => {
  let calls = 0;
  const fetchLocal = async () => {
    calls++;
    return {ok:true,json:async()=>({done:true,message:{content:'{"prompt":"暂时不要部署。"}'}})};
  };
  assert.deepEqual(await translateDraft("Do not deploy yet.",fetchLocal),{status:"ok",text:"暂时不要部署。"});
  assert.equal(calls,1);
});

test("English unit mismatches cannot be approved by the model", async () => {
  for (const [source,prompt,status] of [
    ["等待 30 秒","Wait __KEEP_0__ milliseconds.","invalid"],
    ["设为 30 秒超时","Set a __KEEP_0__-second timeout.","ok"],
    ["不要超过 30 毫秒","Do not exceed __KEEP_0__ ms.","ok"],
    ["限制为 16 MB","Limit it to __KEEP_0__ GB.","invalid"]
  ]) {
    let calls = 0;
    const fetchLocal = async () => ({ok:true,json:async()=>({
      done:true,message:{content:JSON.stringify(++calls === 1 ? {prompt} : {verdict:"pass",issues:[]})}
    })});
    assert.equal((await translateDraft(source,fetchLocal)).status,status,prompt);
  }
});

function verifyTranslateSelection(document, window, install, references, readContext) {
  document.body.innerHTML = '<div class="ComposerLayoutFooter-test"><div class="ProseMirror" contenteditable="true"><p>按钮，<span>按钮</span>。</p></div><button aria-label="添加文件等内容">+</button></div><div role="dialog" aria-label="文本格式"><div><button aria-label="粗体"></button><button aria-label="斜体"></button></div></div>';
  const editor = document.querySelector(".ProseMirror");
  let payload;
  window.__requestLocalDraftRewrite = value => { payload = JSON.parse(value); };
  install(references,readContext);
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor.querySelector("span"));
  document.getSelection().removeAllRanges();
  document.getSelection().addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  const button = document.querySelector("[data-local-draft-translate]");
  button.click();
  const toolbar = button.closest('[role="dialog"]');
  toolbar.remove();
  window.__finishLocalDraftRewrite(payload.key,{status:"ok",text:"button"});
  const changed = editor.textContent;
  document.querySelector('[data-local-draft-undo][aria-label="撤销翻译"]').click();
  return {selected:payload.text,translate:payload.translate,context:"context" in payload,changed,undo:editor.textContent};
}

test("format bar translates only the selected occurrence and preserves native undo", {skip:!port}, async () => {
  assert.deepEqual(await renderFixture(verifyTranslateSelection), {
    selected:"按钮",translate:true,context:false,changed:"按钮，button。",undo:"按钮，按钮。"
  });
});

