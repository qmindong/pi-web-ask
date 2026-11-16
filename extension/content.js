/* pi-web-ask 内容脚本：只做「取正文 / 取选中」，把内容交给侧边栏 */
(() => {
  if (window.__piWebAskLoaded) return;
  window.__piWebAskLoaded = true;

  const MAX_PAGE_CHARS = 60000;
  const CLEAN_CANDIDATES = "article, main, [role=main], #content, .post, .article, .markdown-body";

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "CANVAS", "TEMPLATE",
    "NAV", "FOOTER", "HEADER", "ASIDE", "FORM", "BUTTON", "SELECT",
    "TEXTAREA", "INPUT", "LABEL", "VIDEO", "AUDIO", "OBJECT", "EMBED",
  ]);
  const BLOCK_TAGS = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "MAIN", "LI", "TR", "H1", "H2", "H3",
    "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "BR", "TABLE", "UL", "OL", "DL",
    "DD", "DT", "FIGURE", "FIGCAPTION", "HR",
  ]);

  function extractPageText() {
    const root = document.querySelector(CLEAN_CANDIDATES) || document.body;
    if (!root) return "";
    const parts = [];
    let budget = MAX_PAGE_CHARS * 3;

    const walk = (node) => {
      if (budget <= 0) return;
      if (node.nodeType === 3) {
        const t = node.nodeValue;
        if (t && t.trim()) {
          parts.push(t);
          budget -= t.length;
        }
        return;
      }
      if (node.nodeType !== 1) return;
      if (SKIP_TAGS.has(node.tagName)) return;
      if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return;
      if (node.hidden) return;

      const isBlock = BLOCK_TAGS.has(node.tagName);
      if (isBlock) parts.push("\n");
      if (node.tagName === "LI") parts.push("- ");
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
      if (isBlock) parts.push("\n");
    };

    walk(root);

    let text = parts
      .join("")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (text.length > MAX_PAGE_CHARS) {
      text = text.slice(0, MAX_PAGE_CHARS) + "\n…（正文过长，已截断）";
    }
    return text;
  }

  function getSelectionText() {
    try {
      const s = window.getSelection();
      return s ? s.toString().trim() : "";
    } catch {
      return "";
    }
  }

  /* ---------- 定位原文 ---------- */
  const HL_KEY = "pi-web-ask";
  let hlStyleDone = false;

  function ensureHlStyle() {
    if (hlStyleDone) return;
    hlStyleDone = true;
    const st = document.createElement("style");
    st.textContent = `
      mark.pi-web-ask-hl {
        background: #ffe066 !important;
        color: #111 !important;
        border-radius: 2px !important;
        box-shadow: 0 0 0 2px rgba(255,224,102,.55) !important;
      }
      ::highlight(pi-web-ask) {
        background-color: #ffe066;
        color: #111;
      }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  const QUOTE_CHARS = /[\u300c\u300d\u300e\u300f\u201c\u201d"'\u2018\u2019\u300a\u300b\u3010\u3011\u00a0]/;

  function normalizeNeedle(s) {
    return String(s)
      .replace(/[\u300c\u300d\u300e\u300f\u201c\u201d"'\u2018\u2019\u300a\u300b\u3010\u3011]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** 把整个 body 的可见文本归一化成「无引号 + 空白折叠」的字符串，并记录每个字符的来源 */
  function buildNormalized() {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    const chars = [];
    const map = [];
    let lastSpace = true;
    let total = 0;
    for (const node of nodes) {
      const t = node.nodeValue;
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (QUOTE_CHARS.test(c)) continue;
        if (/\s/.test(c)) {
          if (lastSpace) continue;
          chars.push(" ");
          map.push({ node, off: i });
          lastSpace = true;
        } else {
          chars.push(c);
          map.push({ node, off: i });
          lastSpace = false;
        }
        if (++total > 800000) break;
      }
      if (total > 800000) break;
    }
    return { text: chars.join(""), map };
  }

  function locateText(rawNeedle) {
    const needle = normalizeNeedle(rawNeedle);
    if (needle.length < 4) return { ok: false, reason: "引用太短" };

    const { text, map } = buildNormalized();
    if (!text) return { ok: false, reason: "页面没有可取文本" };

    let idx = text.indexOf(needle);
    let len = needle.length;
    if (idx < 0) {
      // 递减前缀重试（模型可能把两句拼在一起，或省略了中间几个字）
      for (const L of [Math.min(60, needle.length), 40, 28, 18]) {
        if (L >= needle.length) continue;
        const sub = needle.slice(0, L);
        idx = text.indexOf(sub);
        if (idx >= 0) {
          len = L;
          break;
        }
      }
    }
    if (idx < 0) return { ok: false, reason: "页面上找不到这段文字" };

    const a = map[idx];
    const b = map[Math.min(idx + len - 1, map.length - 1)];
    if (!a || !b) return { ok: false, reason: "定位失败" };

    let range;
    try {
      range = document.createRange();
      range.setStart(a.node, a.off);
      range.setEnd(b.node, b.off + 1);
    } catch {
      return { ok: false, reason: "定位失败" };
    }

    ensureHlStyle();

    // 优先用 CSS Custom Highlight（不改 DOM，不会惹毛前端框架）
    if (window.CSS && CSS.highlights && typeof Highlight === "function") {
      try {
        CSS.highlights.set(HL_KEY, new Highlight(range));
      } catch {
        CSS.highlights.delete(HL_KEY);
      }
    } else {
      // 降级：逐文本节点包 mark
      try {
        document.querySelectorAll("mark.pi-web-ask-hl").forEach((m) => {
          const p = m.parentNode;
          if (!p) return;
          p.replaceChild(document.createTextNode(m.textContent), m);
          p.normalize();
        });
      } catch {}
      try {
        const groups = [];
        for (let i = idx; i < idx + len; i++) {
          const m = map[i];
          if (!m) continue;
          const last = groups[groups.length - 1];
          if (last && last.node === m.node) last.end = m.off + 1;
          else groups.push({ node: m.node, start: m.off, end: m.off + 1 });
        }
        for (const g of groups) {
          const r = document.createRange();
          r.setStart(g.node, g.start);
          r.setEnd(g.node, g.end);
          const mk = document.createElement("mark");
          mk.className = "pi-web-ask-hl";
          try {
            r.surroundContents(mk);
          } catch {}
        }
      } catch {}
    }

    // 滚动到位置
    try {
      const el =
        range.startContainer.nodeType === 1
          ? range.startContainer
          : range.startContainer.parentElement;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {}

    return { ok: true, matched: len };
  }

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "pi-web-ask:peek") {
      const sel =
        typeof getSelectionText === "function" ? getSelectionText() : "";
      sendResponse({
        ok: true,
        title: document.title,
        url: location.href,
        selLen: sel.length,
        selHead: sel.slice(0, 40),
      });
      return;
    }

    if (msg.type === "pi-web-ask:extract") {
      sendResponse({
        ok: true,
        title: document.title,
        url: location.href,
        selection: getSelectionText(),
        text: extractPageText(),
      });
      return;
    }

    if (msg.type === "pi-web-ask:locate") {
      let out;
      try {
        out = locateText(msg.text || "");
      } catch (e) {
        out = { ok: false, reason: String((e && e.message) || e) };
      }
      sendResponse(out);
      return;
    }
  });

  console.log("[pi-web-ask] content ready");
})();
