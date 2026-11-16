/* pi-web-ask 侧边栏：类 Cursor 的对话面板 */

const DAEMON = "http://127.0.0.1:7649";
const LS_SESSION = "piWebAsk.sessionId";
const LS_DRAFT = "piWebAsk.draft";

const $ = (id) => document.getElementById(id);
const els = {
  dot: $("dot"),
  brandTitle: $("brandTitle"),
  btnNew: $("btn-new"),
  btnTerm: $("btn-term"),
  btnHistory: $("btn-history"),
  btnBack: $("btn-back"),
  historyView: $("historyView"),
  chatView: $("chatView"),
  messages: $("messages"),
  welcome: $("welcome"),
  ctxbar: $("ctxbar"),
  chips: $("chips"),
  input: $("input"),
  send: $("send"),
  sendIcon: $("sendIcon"),
  hint: $("hint"),
  hsearch: $("hsearch"),
  hcount: $("hcount"),
  hlist: $("hlist"),
  hempty: $("hempty"),
};

let sessionId = localStorage.getItem(LS_SESSION) || null;
let sessionUrl = null;
let sessionPath = null;
let streaming = false;
let abortCtrl = null;
let view = "chat";
let tabInfo = { title: "", url: "", selLen: 0, selHead: "" };
let suppressSel = false; // 用户主动去掉选中文字
let selSig = ""; // 选中内容的指纹，用来判断“换了新的选中”
let historyCache = [];
let searchTerm = "";

/* ================= Markdown ================= */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function inlineMd(s) {
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );
  return s;
}

function renderMd(src) {
  const lines = String(src).split("\n");
  const out = [];
  let i = 0;
  let listType = null;

  const closeList = () => {
    if (listType) {
      out.push(listType === "ul" ? "</ul>" : "</ol>");
      listType = null;
    }
  };
  const isHr = (l) => /^\s*([-*_])\s*(?:\1\s*){2,}$/.test(l);
  const startsBlock = (l) =>
    /^\s*```/.test(l) ||
    /^\s*#{1,6}\s+/.test(l) ||
    isHr(l) ||
    /^\s*>\s?/.test(l) ||
    /^\s*[-*+]\s+/.test(l) ||
    /^\s*\d+[.)]\s+/.test(l) ||
    /^\s*\|/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
      continue;
    }

    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }

    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lv = Math.min(h[1].length + 2, 6);
      out.push(`<h${lv}>` + inlineMd(esc(h[2])) + `</h${lv}>`);
      i++;
      continue;
    }

    if (isHr(line)) {
      closeList();
      out.push("<hr>");
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push("<blockquote>" + inlineMd(esc(buf.join(" "))) + "</blockquote>");
      continue;
    }

    // 表格
    if (/^\s*\|/.test(line)) {
      closeList();
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      if (rows.length >= 2 && /^\s*\|[\s:|-]+\|\s*$/.test(rows[1])) {
        const cells = (r) =>
          r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        let html = "<table><thead><tr>";
        for (const c of cells(rows[0])) html += "<th>" + inlineMd(esc(c)) + "</th>";
        html += "</tr></thead><tbody>";
        for (const r of rows.slice(2)) {
          html += "<tr>";
          for (const c of cells(r)) html += "<td>" + inlineMd(esc(c)) + "</td>";
          html += "</tr>";
        }
        html += "</tbody></table>";
        out.push(html);
      } else {
        out.push("<p>" + rows.map((r) => inlineMd(esc(r))).join("<br>") + "</p>");
      }
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push("<li>" + inlineMd(esc(ul[1])) + "</li>");
      i++;
      continue;
    }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push("<li>" + inlineMd(esc(ol[1])) + "</li>");
      i++;
      continue;
    }

    closeList();
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push("<p>" + buf.map((l) => inlineMd(esc(l))).join("<br>") + "</p>");
  }
  closeList();
  return out.join("");
}

/* ================= 工具 ================= */
function relTime(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60e3) return "刚刚";
  if (d < 3600e3) return Math.floor(d / 60e3) + " 分钟前";
  if (d < 86400e3) return Math.floor(d / 3600e3) + " 小时前";
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + " 天前";
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

function hostOf(u) {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function setHint(t) {
  els.hint.textContent = t || "";
}

function setBusy(on) {
  streaming = on;
  els.dot.classList.toggle("busy", on);
  els.send.classList.toggle("stop", on);
  els.sendIcon.textContent = on ? "■" : "↑";
  els.send.title = on ? "停止生成" : "发送 (Enter)";
}

async function api(path, opts = {}) {
  const r = await fetch(DAEMON + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!r.ok) {
    let msg = `daemon ${r.status}`;
    try {
      const j = await r.json();
      if (j && j.error) msg = j.error;
    } catch {}
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/* ================= 上下文 ================= */
async function activeTab() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const t = tabs && tabs[0];
    if (t && t.url && !/^(moz-extension|about):/.test(t.url)) return t;
  } catch {}
  try {
    const w = await browser.windows.getLastFocused({ populate: true });
    if (w && w.tabs) return w.tabs.find((t) => t.active) || null;
  } catch {}
  return null;
}

async function sendToTab(tabId, msg) {
  try {
    return await browser.tabs.sendMessage(tabId, msg);
  } catch (e) {
    await browser.tabs.executeScript(tabId, { file: "content.js" });
    return await browser.tabs.sendMessage(tabId, msg);
  }
}

async function peekContext() {
  try {
    const tab = await activeTab();
    if (!tab) return;
    let info = { title: tab.title || "", url: tab.url || "", selLen: 0, selHead: "" };
    if (tab.id != null) {
      try {
        const r = await sendToTab(tab.id, { type: "pi-web-ask:peek" });
        if (r && r.ok)
          info = {
            title: r.title || info.title,
            url: r.url || info.url,
            selLen: r.selLen || 0,
            selHead: r.selHead || "",
          };
      } catch {}
    }
    tabInfo = info;
    // 页面上换了新的选中内容 → 自动取消“忽略选中”
    const sig = `${info.selLen}|${info.selHead}`;
    if (suppressSel && sig !== selSig) suppressSel = false;
    selSig = sig;
  } catch {}
  renderCtxbar();
}

function toggleSuppressSel() {
  suppressSel = !suppressSel;
  renderCtxbar();
  setHint(suppressSel ? "已忽略选中文字，本次只发问题" : "会重新带上选中文字");
}

function renderCtxbar() {
  const t = tabInfo.title || "(无标题页面)";
  const hasSel = tabInfo.selLen > 0 && !suppressSel;
  const sel = hasSel ? ` · ✂️ 选中 <b>${tabInfo.selLen}</b> 字` : "";

  // 选中文字后面跟一个可点的 ✕ / ↺
  let selBtn = "";
  if (hasSel) {
    selBtn = `<button class="x" title="不带这段选中文字（只发问题）">✕</button>`;
  } else if (suppressSel && tabInfo.selLen > 0) {
    selBtn = `<button class="x undo" title="重新带上选中文字">⊘ 忽略中 ↺</button>`;
  }

  const otherPage = !!(sessionId && sessionUrl && tabInfo.url && sessionUrl !== tabInfo.url);

  els.ctxbar.innerHTML =
    `<span class="c">📄 <span>${esc(t.slice(0, 44))}</span>${sel}</span>` +
    selBtn +
    (otherPage
      ? `<button class="warn" title="当前对话属于另一个页面，点这里开新对话">⚠ 换页了 · 新开对话</button>`
      : "") +
    `<span style="flex:1"></span>` +
    `<button class="refresh" title="重新读取当前标签页">⟳</button>`;

  els.ctxbar.querySelector(".refresh").addEventListener("click", peekContext);
  const x = els.ctxbar.querySelector(".x");
  if (x) x.addEventListener("click", toggleSuppressSel);
  const warn = els.ctxbar.querySelector(".warn");
  if (warn) warn.addEventListener("click", () => newChat());
}

/* ================= 定位原文 / 切换标签页 ================= */
function flashBtn(btn, txt, back) {
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = txt;
  setTimeout(() => (btn.textContent = old), 1400);
}

async function locateOnPage(text, btn) {
  const needle = String(text || "").trim();
  if (!needle) return;
  try {
    const tab = await activeTab();
    if (!tab || tab.id == null) throw new Error("没有活动标签页");
    const r = await sendToTab(tab.id, { type: "pi-web-ask:locate", text: needle });
    if (r && r.ok) {
      flashBtn(btn, "↙ 已定位");
    } else {
      setHint("定位失败：" + ((r && r.reason) || "页面上找不到这段文字"));
      flashBtn(btn, "✗ 没找到");
    }
  } catch (e) {
    setHint("定位失败：" + (e.message || e));
  }
}

async function focusUrl(url) {
  if (!url) return;
  try {
    const tabs = await browser.tabs.query({});
    const hit = tabs.find((t) => t.url === url);
    if (hit) {
      await browser.tabs.update(hit.id, { active: true });
      await browser.windows.update(hit.windowId, { focused: true });
    } else {
      await browser.tabs.create({ url });
    }
  } catch (e) {
    setHint("切换页面失败：" + (e.message || e));
  }
}

/** 给渲染后的 Markdown 里的引用块挂上「定位原文」按钮 */
function decorateQuotes(md) {
  md.querySelectorAll("blockquote").forEach((bq) => {
    if (bq.querySelector(".locbtn")) return;
    const text = (bq.textContent || "").trim();
    if (text.length < 6) return;
    const btn = document.createElement("button");
    btn.className = "locbtn";
    btn.textContent = "↗ 定位原文";
    btn.addEventListener("click", () => locateOnPage(text, btn));
    bq.appendChild(btn);
  });
}

/* ================= 渲染消息 ================= */
function hideWelcome() {
  els.welcome.classList.add("hidden");
}

function showWelcome() {
  els.welcome.classList.remove("hidden");
}

function scrollBottom(force) {
  const m = els.chatView;
  const near = m.scrollHeight - m.scrollTop - m.clientHeight < 140;
  if (force || near) m.scrollTop = m.scrollHeight;
}

function appendUser(text, meta = {}) {
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  const attached = document.createElement("div");
  attached.className = "attached";

  const addChip = (label, title, onClick) => {
    if (onClick) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title || label;
      b.addEventListener("click", onClick);
      attached.appendChild(b);
    } else {
      const s = document.createElement("span");
      s.textContent = label;
      if (title) s.title = title;
      attached.appendChild(s);
    }
  };

  if (meta.pageTitle) {
    addChip(
      `📄 ${meta.pageTitle.slice(0, 40)}`,
      meta.pageUrl ? `切到这一页：${meta.pageUrl}` : "",
      meta.pageUrl ? () => focusUrl(meta.pageUrl) : null
    );
  }
  if (meta.selText) {
    addChip(`✂️ ${meta.selLen || meta.selText.length} 字`, `定位回原文：${meta.selText.slice(0, 60)}…`, () =>
      locateOnPage(meta.selText)
    );
  } else if (meta.selLen) {
    addChip(`✂️ ${meta.selLen} 字`, "这段选中文字的原文未保存，无法跳回");
  }
  if (meta.withContext) addChip("整页正文已附加");

  if (attached.childNodes.length) wrap.appendChild(attached);

  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  wrap.appendChild(b);
  els.messages.appendChild(wrap);
  scrollBottom(true);
  return wrap;
}

function appendAssistant() {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = '<span style="color:#6a7285">…</span>';
  wrap.appendChild(md);
  els.messages.appendChild(wrap);
  scrollBottom(true);
  return { wrap, md };
}

function addActions(wrap, text) {
  if (wrap.querySelector(".actions")) return;
  const a = document.createElement("div");
  a.className = "actions";
  const copy = document.createElement("button");
  copy.textContent = "复制";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "已复制";
      setTimeout(() => (copy.textContent = "复制"), 1200);
    } catch {
      copy.textContent = "复制失败";
    }
  });
  a.appendChild(copy);
  wrap.appendChild(a);
}

function renderMessages(list) {
  els.messages.innerHTML = "";
  if (!list.length) {
    showWelcome();
    return;
  }
  hideWelcome();
  for (const m of list) {
    if (m.role === "user") {
      appendUser(m.text, {
        pageTitle: m.pageTitle,
        pageUrl: m.pageUrl,
        selLen: m.selLen,
        selText: m.selText,
        withContext: m.withContext,
      });
    } else {
      const { wrap, md } = appendAssistant();
      md.innerHTML = renderMd(m.text);
      decorateQuotes(md);
      addActions(wrap, m.text);
    }
  }
  scrollBottom(true);
}

/* ================= 会话 ================= */
function applySessionHeader(title) {
  els.brandTitle.textContent = title ? title.slice(0, 34) : "pi";
  document.title = title ? "pi · " + title.slice(0, 30) : "pi 问答";
}

async function loadSession(id) {
  try {
    const d = await api("/sessions/" + id);
    sessionId = id;
    sessionUrl = d.session.url || null;
    sessionPath = d.session.path || null;
    localStorage.setItem(LS_SESSION, id);
    applySessionHeader(d.session.title);
    renderMessages(d.messages || []);
    switchView("chat");
    peekContext();
  } catch (e) {
    if (e.status === 404) {
      localStorage.removeItem(LS_SESSION);
      sessionId = null;
      newChat(false);
    } else {
      setHint("读取会话失败：" + e.message);
    }
  }
}

function newChat(focus = true) {
  sessionId = null;
  sessionUrl = null;
  sessionPath = null;
  localStorage.removeItem(LS_SESSION);
  applySessionHeader("");
  els.messages.innerHTML = "";
  showWelcome();
  switchView("chat");
  setHint("");
  if (focus) els.input.focus();
}

async function openHistory() {
  switchView("history");
  await loadHistory();
  els.hsearch.focus();
}

function switchView(v) {
  view = v;
  const isHist = v === "history";
  els.historyView.classList.toggle("hidden", !isHist);
  els.chatView.classList.toggle("hidden", isHist);
  els.btnBack.classList.toggle("hidden", !isHist);
  els.btnHistory.classList.toggle("hidden", isHist);
}

async function loadHistory() {
  try {
    const d = await api("/sessions");
    historyCache = d.sessions || [];
  } catch (e) {
    els.hlist.innerHTML = "";
    els.hempty.textContent = "连不上本地 daemon：请先运行 systemctl --user start pi-web-ask";
    els.hempty.classList.remove("hidden");
    return;
  }
  renderHistory();
}

function renderHistory() {
  const term = searchTerm.trim().toLowerCase();
  const list = historyCache.filter(
    (s) =>
      !term ||
      (s.title || "").toLowerCase().includes(term) ||
      (s.url || "").toLowerCase().includes(term)
  );
  els.hlist.innerHTML = "";
  els.hcount.textContent = searchTerm
    ? `${list.length} / ${historyCache.length} 个对话`
    : `共 ${historyCache.length} 个对话`;
  els.hempty.classList.toggle("hidden", list.length > 0);
  if (!list.length) elkEmptyText();
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "hitem" + (s.id === sessionId ? " active" : "");

    const main = document.createElement("div");
    main.className = "hi-main";
    const t = document.createElement("div");
    t.className = "hi-title";
    t.textContent = s.title || "新对话";
    const sub = document.createElement("div");
    sub.className = "hi-sub";
    sub.textContent = [hostOf(s.url), relTime(s.updatedAt), s.turns ? `${s.turns} 轮` : ""]
      .filter(Boolean)
      .join(" · ");
    if (s.pageTitle) row.title = s.pageTitle;
    main.appendChild(t);
    main.appendChild(sub);

    const del = document.createElement("button");
    del.className = "hi-del";
    del.textContent = "✕";
    del.title = "删除这个对话";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`删除对话「${s.title || "新对话"}」？此操作不可恢复。`)) return;
      try {
        await api("/sessions/" + s.id, { method: "DELETE" });
      } catch {}
      if (s.id === sessionId) newChat(false);
      await loadHistory();
    });

    row.appendChild(main);
    row.appendChild(del);
    row.addEventListener("click", () => loadSession(s.id));
    els.hlist.appendChild(row);
  }
}

function elkEmptyText() {
  els.hempty.textContent = searchTerm ? "没有匹配的对话" : "还没有历史对话";
}

/* ================= 提问 ================= */
const chips = [
  ["解释这段", "解释我划选的这段文字，讲清楚它在说什么、为什么重要。"],
  ["翻译这段", "把我划选的这段翻译成简体中文，专业术语保留原词并加括号说明。"],
  ["总结全页", "用几句话总结这个页面的核心内容。"],
  ["三个要点", "这一页最关键的三个要点是什么？每点一两句话。"],
];

function renderChips() {
  els.chips.innerHTML = "";
  for (const [label, q] of chips) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => send(q));
    els.chips.appendChild(b);
  }
}

async function send(questionOverride) {
  const q = (questionOverride ?? els.input.value).trim();
  if (!q) {
    els.input.focus();
    return;
  }
  if (streaming) return;

  // 抓当前页面
  let ctx = { title: tabInfo.title, url: tabInfo.url, selection: "", text: "" };
  try {
    const tab = await activeTab();
    if (tab && tab.id != null) {
      const r = await sendToTab(tab.id, { type: "pi-web-ask:extract" });
      if (r && r.ok) ctx = r;
    }
  } catch (e) {
    setHint("无法读取页面内容（" + (e.message || e) + "），只发问题");
  }

  hideWelcome();
  if (!questionOverride) els.input.value = "";
  autosize();
  localStorage.removeItem(LS_DRAFT);

  // 新会话、或同一会话但换了页面 → 后端会附带整页上下文
  const willAttach = !sessionId || (!!ctx.url && !!sessionUrl && ctx.url !== sessionUrl);
  const sel = suppressSel ? "" : ctx.selection || "";

  appendUser(q, {
    pageTitle: willAttach ? ctx.title : "",
    pageUrl: willAttach ? ctx.url : "",
    selLen: sel.length,
    selText: sel,
    withContext: willAttach,
  });

  const node = appendAssistant();
  setBusy(true);
  setHint("");

  let acc = "";
  let raf = null;
  const paint = () => {
    raf = null;
    node.md.innerHTML = renderMd(acc) + (streaming ? '<span style="color:#5b6bff">▍</span>' : "");
    scrollBottom(false);
  };
  const schedulePaint = () => {
    if (!raf) raf = setTimeout(paint, 70);
  };

  abortCtrl = new AbortController();
  try {
    const resp = await fetch(DAEMON + "/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortCtrl.signal,
      body: JSON.stringify({
        sessionId,
        question: q,
        selection: sel,
        page: { url: ctx.url || "", title: ctx.title || "", text: ctx.text || "" },
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`daemon ${resp.status} ${txt.slice(0, 200)}`);
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }

        if (ev.type === "session") {
          sessionId = ev.id;
          sessionPath = ev.path || sessionPath;
          localStorage.setItem(LS_SESSION, ev.id);
          applySessionHeader(ev.title);
          if (ev.withContext) {
            setHint(
              `已附加页面上下文${ctx.text ? `：正文 ${ctx.text.length.toLocaleString()} 字` : ""}${
                ctx.selection ? ` · 选中 ${ctx.selection.length} 字` : ""
              }`
            );
          } else if (ev.withSelection) {
            setHint(`已附加新划选的 ${(ctx.selection || "").length} 字片段`);
          }
        } else if (ev.type === "delta") {
          acc += ev.text;
          schedulePaint();
        } else if (ev.type === "done") {
          acc = ev.text || acc;
          if (raf) {
            clearTimeout(raf);
            raf = null;
          }
          setBusy(false);
          node.md.innerHTML = renderMd(acc) || '<span style="color:#6a7285">（空回答）</span>';
          decorateQuotes(node.md);
          addActions(node.wrap, acc);
          sessionUrl = ctx.url || sessionUrl;
          scrollBottom(false);
        } else if (ev.type === "error") {
          setBusy(false);
          node.md.innerHTML = `<div style="color:#ff8a8a">${esc(ev.message || "出错了")}</div>`;
          scrollBottom(false);
        } else if (ev.type === "end") {
          if (ev.title && ev.title !== "新对话") applySessionHeader(ev.title);
          if (view === "history") loadHistory();
        }
      }
    }
  } catch (e) {
    setBusy(false);
    if (e.name === "AbortError") {
      if (acc) {
        node.md.innerHTML = renderMd(acc);
        decorateQuotes(node.md);
        addActions(node.wrap, acc);
      } else {
        node.wrap.remove();
      }
      return;
    }
    node.md.innerHTML =
      `<div style="color:#ff8a8a">${esc(
        "连不上本地 daemon（" + DAEMON + "）。启动：systemctl --user start pi-web-ask。\n" + (e.message || e)
      )}</div>`;
  } finally {
    setBusy(false);
    abortCtrl = null;
  }
}

function abort() {
  if (abortCtrl) abortCtrl.abort();
}

/* ================= 输入框 ================= */
function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}

els.input.addEventListener("input", () => {
  autosize();
  localStorage.setItem(LS_DRAFT, els.input.value);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

els.send.addEventListener("click", () => {
  if (streaming) abort();
  else send();
});

/* ================= 事件 ================= */
els.btnNew.addEventListener("click", () => newChat());
els.btnHistory.addEventListener("click", () => openHistory());
els.btnBack.addEventListener("click", () => switchView("chat"));
els.btnTerm.addEventListener("click", async () => {
  if (!sessionPath) {
    setHint("这个对话还没有会话文件，先提问一次");
    return;
  }
  const cmd = `pi --session '${sessionPath}'`;
  try {
    await navigator.clipboard.writeText(cmd);
    setHint("已复制到剪贴板，粘到终端即可继续这个对话");
  } catch {
    setHint(cmd);
  }
  console.log(cmd);
});

els.hsearch.addEventListener("input", () => {
  searchTerm = els.hsearch.value;
  renderHistory();
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "pi-web-ask:focus") {
    switchView("chat");
    els.input.focus();
    peekContext();
  }
});

let peekTimer = null;
const schedulePeek = () => {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(peekContext, 350);
};
browser.tabs.onActivated.addListener(schedulePeek);
browser.tabs.onUpdated.addListener((_id, info, tab) => {
  if (!info.url && !info.title) return;
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (tabs[0] && tab && tabs[0].id === tab.id) schedulePeek();
  });
});

/* ================= 启动 ================= */
(async function boot() {
  renderChips();
  const draft = localStorage.getItem(LS_DRAFT);
  if (draft) els.input.value = draft;
  autosize();
  await peekContext();

  if (sessionId) {
    await loadSession(sessionId);
  } else {
    showWelcome();
  }

  // 直接打开侧边栏时也给输入框焦点
  setTimeout(() => els.input.focus(), 80);
})();
