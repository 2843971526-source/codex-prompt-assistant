import {containsCredential, readRecentContext, referencesPreviousTurn, rewriteDraft, translateDraft} from "./codex-draft-rewrite.mjs";

export function installButton(_referencesPreviousTurn, readRecentContext) {
  window.__localDraftButtonCleanup?.();
  window.__localDraftButtonObserver?.disconnect();
  document.querySelectorAll('[data-local-draft-tooltip]').forEach(tooltip => tooltip.remove());
  document.querySelectorAll('[data-local-draft-status]').forEach(status => status.remove());
  document.querySelectorAll('[data-local-draft-rewrite],[data-local-draft-translate],[data-local-draft-undo]').forEach(button => button.remove());
  document.querySelectorAll('[data-local-draft-actions]').forEach(panel => panel.remove());
  const label = "增强提示词";
  document.querySelector("[data-local-draft-ui]")?.remove();
  let pending, undo;
  const feedback = new WeakMap();
  const spinner = '<svg aria-hidden="true" width="1em" height="1em" viewBox="0 0 24 24" fill="none"><path d="M12 3a9 9 0 1 1-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function setLabel(button, value) {
    button.setAttribute("aria-label", value);
    const tooltip = document.querySelector('[data-local-draft-tooltip]');
    if (tooltip?.anchor === button) tooltip.textContent = tooltip.getLabel();
  }
  function attachTooltip(button, getLabel = () => button.getAttribute("aria-label")) {
    let timer;
    let tooltip;
    function hide() {
      clearTimeout(timer);
      tooltip?.remove();
      tooltip = undefined;
    }
    function show() {
      hide();
      timer = setTimeout(() => {
        if (!button.isConnected) return;
        tooltip = document.createElement("div");
        tooltip.dataset.localDraftTooltip = "";
        tooltip.anchor = button;
        tooltip.getLabel = getLabel;
        tooltip.setAttribute("role", "tooltip");
        tooltip.textContent = getLabel();
        const rect = button.getBoundingClientRect();
        Object.assign(tooltip.style, {
          position: "fixed", inset: "auto", margin: "0", left: rect.left + rect.width / 2 + "px",
          top: rect.top - 7 + "px", transform: "translate(-50%, -100%)",
          zIndex: "10000", pointerEvents: "none", whiteSpace: "nowrap",
          padding: "var(--tooltip-padding-block, 5px) var(--tooltip-padding-inline, 8px)",
          border: "1px solid var(--tooltip-border-color, transparent)",
          borderRadius: "var(--tooltip-border-radius, 6px)",
          background: "var(--tooltip-background-color, Canvas)",
          color: "var(--tooltip-text-color, var(--color-text-tooltip-shortcut, CanvasText))",
          fontSize: "var(--tooltip-font-size, 12px)",
          fontWeight: "var(--tooltip-font-weight, 430)",
          letterSpacing: "var(--tooltip-letter-spacing, normal)",
          lineHeight: "var(--tooltip-line-height, 16px)",
          boxShadow: "var(--tooltip-box-shadow, none)"
        });
        tooltip.style.setProperty("corner-shape", "var(--tooltip-corner-shape, round)");
        if (typeof tooltip.showPopover === "function") tooltip.popover = "manual";
        button.after(tooltip);
        if (tooltip.popover === "manual") tooltip.showPopover();
      }, 350);
    }
    button.addEventListener("pointerenter", event => { if (event.pointerType === "mouse") show(); });
    button.addEventListener("pointerleave", hide);
    button.addEventListener("pointercancel", hide);
    button.addEventListener("focus", () => { if (button.matches(":focus-visible")) show(); });
    button.addEventListener("blur", hide);
    button.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
    button.closest('[class*="ComposerLayoutFooter-"]')?.addEventListener("scroll", hide);
  }
  function chatIdentity(editor) {
    const selected = document.querySelector('[data-app-action-sidebar-thread-selected="true"]');
    const annotation = editor.closest(".thread-scroll-container")?.querySelector("[data-response-annotation-conversation]");
    return JSON.stringify([
      location.href,
      selected?.getAttribute("data-app-action-sidebar-thread-id"),
      annotation?.getAttribute("data-response-annotation-conversation")
    ]);
  }
  function sameChat(request) {
    return request.editor.isConnected && (request.translate || request.button.isConnected) &&
      request.editor.closest(".thread-scroll-container") === request.thread &&
      chatIdentity(request.editor) === request.chat;
  }
  function isPlainDraft(editor) {
    return [...editor.children].every(plainParagraph) &&
      !editor.querySelector('img, video, [contenteditable="false"]');
  }
  function plainParagraph(p) {
    return p?.tagName === "P" && [...p.querySelectorAll("*")].every(node =>
      node.tagName === "SPAN" && !node.matches('[style],[contenteditable],[role],[data-type],[data-node-view-wrapper]'));
  }
  function selectedPart(editor) {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const element = node => node.nodeType === 1 ? node : node.parentElement;
    const paragraph = element(range.startContainer)?.closest("p");
    if (paragraph?.parentElement !== editor || !plainParagraph(paragraph) ||
        element(range.endContainer)?.closest("p") !== paragraph || !range.toString().trim()) return false;
    const before = document.createRange();
    before.selectNodeContents(paragraph);
    before.setEnd(range.startContainer, range.startOffset);
    return {index:[...editor.children].indexOf(paragraph), start:before.toString().length,
      text:range.toString(), paragraph:paragraph.textContent};
  }
  function releasePending() {
    const request = pending;
    pending = undefined;
    clearTimeout(request.timer);
    request.editor.removeEventListener("beforeinput", request.markEdited);
    request.editor.removeEventListener("input", request.markEdited);
    request.button.removeAttribute("aria-busy");
    request.button.innerHTML = request.icon;
    setLabel(request.button, request.translate ? "翻译选中文字" : label);
    return request;
  }
  function cancel(request) {
    releasePending();
    try { window.__requestLocalDraftRewrite(JSON.stringify({key: request.key, cancel: true})); } catch {}
  }
  function editorText(editor, part, value) {
    const block = node => node.nodeName === "P" || node.nodeName === "DIV";
    const read = node => {
      if (node.nodeType === 3) return node.data;
      if (node.nodeName === "BR") return "\n";
      if (block(node) && node.childNodes.length === 1 && node.firstChild.nodeName === "BR") return "";
      let text = "", previousBlock = false, first = true;
      for (const child of node.childNodes) {
        if (child.nodeType !== 1 && child.nodeType !== 3) continue;
        const isBlock = block(child);
        if (!first && (isBlock || previousBlock)) text += "\n";
        text += child === editor.children[part?.index] && part
          ? part.paragraph.slice(0, part.start) + value + part.paragraph.slice(part.start + part.text.length)
          : read(child);
        first = false;
        previousBlock = isBlock;
      }
      return text;
    };
    return read(editor).replace(/\r\n?/g, "\n");
  }
  function finishRewrite(key, result) {
    if (!pending || pending.key !== key) return;
    const request = releasePending();
    const {editor, draft, button, part} = request;
    if (!sameChat(request)) return;
    if (request.edited || editor.innerText !== request.original || !isPlainDraft(editor)) {
      return flash(editor, button, "草稿已变更");
    }
    const {status, text: candidate} = typeof result === "object" && result ? result : {status: result ? "ok" : "invalid", text: result};
    if (status !== "ok" && status !== "review") {
      const message = {offline:"Ollama 未连接", "missing-model":"缺少 qwen3.5:4b", timeout:"Ollama 响应超时", "service-error":"Ollama 服务异常", cancelled:"已取消"}[status] || "优化失败";
      return flash(editor, button, request.translate && status === "invalid" ? "译文校验未通过，已保留原文" : message, 5000);
    }
    function replace(value, length, expected) {
      const selection = document.getSelection();
      const range = document.createRange();
      if (part) {
        const paragraph = editor.children[part.index];
        if (!plainParagraph(paragraph) || paragraph.textContent !== expected) return false;
        function point(offset) {
          const walker = document.createTreeWalker(paragraph, 4);
          for (let node; (node = walker.nextNode());) {
            if (offset <= node.length) return [node, offset];
            offset -= node.length;
          }
          return [paragraph, paragraph.childNodes.length];
        }
        range.setStart(...point(part.start));
        range.setEnd(...point(part.start + length));
      } else range.selectNodeContents(editor);
      editor.focus();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, value);
    }
    if (status === "review") return flash(editor, button, "可能改变原意，已保留原文");
    if (typeof candidate !== "string" || !candidate.trim() || candidate.trim() === draft) return flash(editor, button, request.translate ? "原文无需翻译" : "原文无需改写");
    const text = part
      ? part.text.match(/^\s*/)[0] + candidate.trim() + part.text.match(/\s*$/)[0]
      : candidate;
    if (part && /[\r\n\u2028\u2029]/.test(text)) return flash(editor, button, "选区增强仅支持单段结果");
    const before = editorText(editor);
    const expected = part ? editorText(editor, part, text) : text.replace(/\r\n?/g, "\n");
    try { replace(text, (part?.text ?? request.original).length, part?.paragraph); } catch {}
    const actual = editorText(editor);
    if (actual === expected) {
      offerUndo(request, before, expected);
      return;
    }
    flash(editor, button, actual === before ? "未回填，已保留原文" : "回填结果不一致，请检查草稿");
  }
  function clearUndo() {
    undo?.editor.removeEventListener("input", clearUndo);
    undo?.button.remove();
    undo = undefined;
  }
  function offerUndo(request, before, expected) {
    const {editor} = request;
    const star = editor.closest('[class*="ComposerLayoutFooter-"]')?.querySelector("[data-local-draft-rewrite]");
    if (!star) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.localDraftUndo = "";
    button.className = star.className;
    button.textContent = "↶";
    setLabel(button, request.translate ? "撤销翻译" : "撤销增强");
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", event => {
      event.preventDefault();
      if (undo?.button !== button) return;
      clearUndo();
      if (pending || !sameChat(request) || editorText(editor) !== expected) return;
      editor.focus();
      if (document.activeElement !== editor) return;
      try { document.execCommand("undo"); } catch {}
      if (editorText(editor) !== before) flash(editor, star, "撤销结果不一致，请检查草稿");
    });
    clearUndo();
    undo = {button, editor, request, expected};
    editor.addEventListener("input", clearUndo, {once:true});
    star.after(button);
    attachTooltip(button);
  }
  window.__finishLocalDraftRewrite = finishRewrite;
  let statusTimer;
  function flash(editor, button, message) {
    feedback.set(button, {message, chat: chatIdentity(editor), draft: editor.innerText});
    setLabel(button, message);
    clearTimeout(statusTimer);
    document.querySelector('[data-local-draft-status]')?.remove();
    const status = document.createElement("div");
    status.dataset.localDraftStatus = "";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = message;
    const rect = button.getBoundingClientRect();
    Object.assign(status.style, {position:"fixed", left:rect.left + rect.width / 2 + "px", top:rect.top - 7 + "px",
      transform:"translate(-50%, -100%)", zIndex:"10001", pointerEvents:"none", whiteSpace:"nowrap",
      padding:"var(--tooltip-padding-block, 5px) var(--tooltip-padding-inline, 8px)",
      border:"1px solid var(--tooltip-border-color, transparent)", borderRadius:"var(--tooltip-border-radius, 6px)",
      background:"var(--tooltip-background-color, Canvas)", color:"var(--tooltip-text-color, CanvasText)",
      fontSize:"var(--tooltip-font-size, 12px)", lineHeight:"var(--tooltip-line-height, 16px)",
      boxShadow:"var(--tooltip-box-shadow, none)"});
    if (typeof status.showPopover === "function") status.popover = "manual";
    button.after(status);
    if (status.popover === "manual") status.showPopover();
    statusTimer = setTimeout(() => status.remove(), 3000);
  }
  function clearStaleFeedback(editor, button) {
    const last = feedback.get(button);
    if (last && (last.chat !== chatIdentity(editor) || last.draft !== editor.innerText)) {
      feedback.delete(button);
      document.querySelector('[data-local-draft-status]')?.remove();
      setLabel(button, button.hasAttribute("data-local-draft-translate") ? "翻译选中文字" : label);
    }
  }
  function start(editor, button, translate = false) {
    if (pending) return;
    const part = selectedPart(editor);
    if (translate && !part) return;
    const original = editor.innerText;
    if (part === false) return flash(editor, button, "请选择同一段内的纯文本");
    if (part && editor.children[part.index]?.textContent !== part.paragraph) return flash(editor, button, "草稿已变更");
    const text = (part?.text ?? original).trim();
    if (!text) return flash(editor, button, "请先输入草稿");
    if (!isPlainDraft(editor)) {
      return flash(editor, button, "仅支持纯文本草稿");
    }
    if (typeof window.__requestLocalDraftRewrite !== "function") {
      return flash(editor, button, "本地连接不可用");
    }
    clearUndo();
    const key = crypto.randomUUID();
    const request = {
      key, editor, translate, draft: text, original, part, button, icon:button.innerHTML, chat: chatIdentity(editor),
      thread: editor.closest(".thread-scroll-container"), edited: false
    };
    request.markEdited = event => {
      if (event.type === "beforeinput" || editor.innerText !== original || !isPlainDraft(editor)) {
        request.edited = true;
      }
    };
    request.timer = setTimeout(() => finishRewrite(key, {status:"timeout"}), 95000);
    editor.addEventListener("beforeinput", request.markEdited);
    editor.addEventListener("input", request.markEdited);
    pending = request;
    button.setAttribute("aria-busy", "true");
    setLabel(button, translate ? "翻译中，点击取消" : "优化中，点击取消");
    button.innerHTML = spinner;
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      button.firstElementChild.animate([{transform:"rotate(0turn)"}, {transform:"rotate(1turn)"}], {duration:800, iterations:Infinity});
    }
    try {
      const context = !translate && sameChat(request) ? readRecentContext(editor) : null;
      if (!sameChat(request)) return cancel(request);
      window.__requestLocalDraftRewrite(JSON.stringify({key, text, ...(translate ? {translate:true} : {}), ...(context ? {context} : {})}));
    } catch {
      finishRewrite(key, "");
    }
  }
  function mountTranslation() {
    const selection = document.getSelection();
    const node = selection?.anchorNode;
    const editor = (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.ProseMirror[contenteditable="true"]');
    const part = editor?.closest('[class*="ComposerLayoutFooter-"]') && selectedPart(editor);
    for (const toolbar of document.querySelectorAll('[role="dialog"],[role="toolbar"]')) {
      const bold = toolbar.querySelector('button[aria-label="粗体"],button[aria-label="Bold"]');
      const italic = toolbar.querySelector('button[aria-label="斜体"],button[aria-label="Italic"]');
      if (!bold || !italic || toolbar !== bold.closest('[role="dialog"],[role="toolbar"]')) continue;
      const existing = toolbar.querySelector("[data-local-draft-translate]");
      if (!part) { existing?.remove(); continue; }
      if (existing) { existing.editor = editor; clearStaleFeedback(editor, existing); continue; }
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.localDraftTranslate = "";
      button.className = bold.className;
      button.textContent = "译";
      button.editor = editor;
      setLabel(button, "翻译选中文字");
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", event => {
        event.preventDefault();
        if (pending?.button === button) return cancel(pending);
        feedback.delete(button);
        setLabel(button, "翻译选中文字");
        start(button.editor, button, true);
      });
      const end = [...toolbar.querySelectorAll("button")].at(-1);
      end.after(button);
      attachTooltip(button);
    }
  }
  function mount() {
    if (undo && (!undo.button.isConnected || !sameChat(undo.request) ||
        editorText(undo.editor) !== undo.expected)) clearUndo();
    mountTranslation();
    if (pending && !sameChat(pending)) cancel(pending);
    for (const editor of document.querySelectorAll('.ProseMirror[contenteditable="true"]')) {
      const footer = editor.closest('[class*="ComposerLayoutFooter-"]');
      const add = footer?.querySelector('button[aria-label="添加文件等内容"], button[aria-label="Add files and more"]');
      if (!add) continue;
      const existing = footer.querySelector('[data-local-draft-rewrite]');
      if (existing) {
        clearStaleFeedback(editor, existing);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.localDraftRewrite = "";
      button.className = add.className;
      button.innerHTML = '<svg aria-hidden="true" width="1em" height="1em" viewBox="0 0 24 24" fill="none"><path d="m10 4 2.2 5.2a2 2 0 0 0 1.1 1.1l5.2 2.2-5.2 2.2a2 2 0 0 0-1.1 1.1L10 21l-2.2-5.2a2 2 0 0 0-1.1-1.1L1.5 12.5l5.2-2.2a2 2 0 0 0 1.1-1.1L10 4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M19 1.5 20 4l2.5 1L20 6l-1 2.5L18 6l-2.5-1L18 4l1-2.5Z" fill="currentColor"/></svg>';
      const nativeIconClass = add.querySelector("svg")?.getAttribute("class");
      if (nativeIconClass) button.querySelector("svg").setAttribute("class", nativeIconClass);
      setLabel(button, label);
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", event => {
        event.preventDefault();
        if (pending?.button === button) return cancel(pending);
        feedback.delete(button);
        setLabel(button, label);
        start(editor, button);
      });
      add.insertAdjacentElement("afterend", button);
      editor.addEventListener("input", () => {
        if (button.isConnected) clearStaleFeedback(editor, button);
      }, {signal: lifecycle.signal});
      attachTooltip(button, () => feedback.get(button)?.message ??
        (!pending && selectedPart(editor) ? "增强选中文字" : button.getAttribute("aria-label")));
    }
  }
  const lifecycle = new AbortController();
  document.addEventListener("selectionchange", mountTranslation, {signal:lifecycle.signal});
  window.__localDraftButtonObserver = new MutationObserver(mount);
  window.__localDraftButtonObserver.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["contenteditable", "aria-label", "data-app-action-sidebar-thread-selected",
      "data-app-action-sidebar-thread-id", "data-response-annotation-conversation"]
  });
  window.__localDraftButtonCleanup = () => {
    clearUndo();
    lifecycle.abort();
    if (pending) cancel(pending);
  };
  mount();
}

async function attachButton(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(entry => entry.type === "page" && entry.url === "app://-/index.html");
  if (!target) throw new Error("Codex window unavailable");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const send = (method, params) => socket.send(JSON.stringify({id: ++id, method, params}));
  const evaluate = (expression, contextId) => send("Runtime.evaluate", {expression, contextId});

  const requests = new Map();
  socket.onclose = () => requests.forEach(controller => controller.abort());
  socket.onmessage = async ({data}) => {
    const message = JSON.parse(data);
    if (message.method !== "Runtime.bindingCalled" ||
        message.params.name !== "__requestLocalDraftRewrite") return;
    let payload;
    try {
      payload = JSON.parse(message.params.payload);
    } catch {
      return;
    }
    if (typeof payload?.key !== "string" || payload.key.length !== 36) return;
    const {key, text, context, cancel, translate} = payload;
    if (cancel) return requests.get(key)?.abort();
    if (requests.has(key)) return;
    const controller = new AbortController();
    requests.set(key, controller);
    const options = {detailed:true, signal:controller.signal};
    const rewritten = translate === true ? await translateDraft(text, fetch, options) : await rewriteDraft(text, context, fetch, options);
    requests.delete(key);
    if (controller.signal.aborted || socket.readyState !== WebSocket.OPEN) return;
    evaluate(`window.__finishLocalDraftRewrite?.(${JSON.stringify(key)},${JSON.stringify(rewritten)})`,
      message.params.executionContextId);
  };
  const install = `(${installButton})(${referencesPreviousTurn}, editor => (${readRecentContext})(editor, ${containsCredential}))`;
  send("Runtime.addBinding", {name: "__requestLocalDraftRewrite"});
  send("Page.addScriptToEvaluateOnNewDocument", {
    source: `if (window === window.top) addEventListener("DOMContentLoaded", () => ${install}, {once: true})`
  });
  evaluate(install);
}

if (import.meta.main) await attachButton(Number(process.argv[2]));

