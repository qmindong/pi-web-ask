#!/usr/bin/env node
/**
 * pi-web-ask daemon v2 —— 类 Cursor 的网页问答后端
 *
 * 每个「对话」= 一个 pi 原生 session 文件（sessions/<id>.jsonl），
 * 因此关掉浏览器、重启 daemon 后仍可找回历史并继续追问（上下文由 pi 恢复）。
 * 只监听 127.0.0.1。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const HOME = process.env.HOME || os.homedir();
const DATA_DIR = process.env.PI_WEB_ASK_DATA || path.join(HOME, '.local/share/pi-web-ask');
const SESS_DIR = path.join(DATA_DIR, 'sessions');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PI_WEB_ASK_PORT || 7649);
const MAX_PAGE_CHARS = Number(process.env.PI_WEB_ASK_MAX_PAGE || 60000);
const IDLE_MS = Number(process.env.PI_WEB_ASK_IDLE_MS || 30 * 60 * 1000);
const MAX_LIVE = Number(process.env.PI_WEB_ASK_MAX_LIVE || 4);

fs.mkdirSync(SESS_DIR, { recursive: true });

const SYSTEM_PROMPT = `你是一个网页阅读助手，运行在用户浏览器的侧边栏里（类似编辑器里的 AI 对话面板）。

用户正在浏览一个网页。第一条消息里会附带页面标题、网址、用户划选的文字和页面正文；后续对话是普通追问。
如果用户在对话中途换了页面，会重新附带新的页面上下文。
用户也可能**在你回答之后重新划选一段新文字**再提问，这时会有一条带「[选中文字] …（用户刚刚新划选的）」的消息：以这段新片段为当前焦点，不要把上一轮的选中片段当成现在要看的东西。

回答规则：
- 以用户提供的页面内容为主要依据；页面里没有的信息就直说「页面里没有提到」，不要编造。
- 简体中文，先给结论再展开；不要复述整段原文，只引用必要的短句。
- **引用页面原文时，必须用 Markdown 引用块逐字照抄页面里的原句**（可以截断，但不能改字、不能拼接、不能翻译），格式：
  > 原句照抄在这里
  界面会把这种引用块变成「↗ 定位原文」按钮，用户点一下就能跳回页面里那句话的位置。
- 可以用 Markdown：小标题、列表、**加粗**、行内代码、\`\`\`代码块\`\`\`。
- 不要调用工具，不要反问用户（除非信息确实不足）。
- 篇幅与问题匹配：简单问题两三句话，需要解释时才展开。`;

/* ---------------- pi 定位 ---------------- */
function findPi() {
  if (process.env.PI_WEB_ASK_PI) return process.env.PI_WEB_ASK_PI;
  for (const c of [
    path.join(HOME, '.local/bin/pi'),
    path.join(HOME, '.pi/agent/bin/pi'),
    '/usr/local/bin/pi',
    '/usr/bin/pi',
  ]) {
    if (fs.existsSync(c)) return c;
  }
  const w = spawnSync('which', ['pi'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.trim().split('\n')[0] : 'pi';
}
const PI_BIN = findPi();

function piArgs(sessionFile) {
  const args = [
    '--mode', 'rpc',
    '--session', sessionFile,
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--system-prompt', SYSTEM_PROMPT,
    '--name', 'web-ask',
  ];
  if (process.env.PI_WEB_ASK_MODEL) args.push('--model', process.env.PI_WEB_ASK_MODEL);
  if (process.env.PI_WEB_ASK_PROVIDER) args.push('--provider', process.env.PI_WEB_ASK_PROVIDER);
  if (process.env.PI_WEB_ASK_THINKING) args.push('--thinking', process.env.PI_WEB_ASK_THINKING);
  return args;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------- 会话索引 ---------------- */
let index = {};
try {
  index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) || {};
} catch {
  index = {};
}

function saveIndex() {
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index, null, 1));
  fs.renameSync(tmp, INDEX_FILE);
}

const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function sessionFile(id) {
  return path.join(SESS_DIR, `${id}.jsonl`);
}

function newSession({ url = '', title = '', pageTitle = '', titleSource = '' } = {}) {
  const id = uid();
  index[id] = {
    id,
    title: title || '新对话',
    titleSource: titleSource || (title ? 'manual' : 'pending'),
    pageTitle,
    url,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turns: 0,
  };
  saveIndex();
  return index[id];
}

/** 用第一个提问做会话标题（兼作 LLM 取名失败的傅底） */
function titleFromQuestion(q) {
  let t = String(q || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s\-*#>]+/, '')
    .replace(/[。？?！!，,、；;：:\s]+$/g, '');
  if (!t) return '';
  const MAX = 40;
  return t.length > MAX ? t.slice(0, MAX) + '…' : t;
}

function cleanTitle(raw) {
  let t = String(raw || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0] || '';
  t = t
    .replace(/^[*#>\s\-]+/, '')
    .replace(/^标题[:：]\s*/, '')
    .replace(/^[「『"'“《]+/, '')
    .replace(/[」』"'”》。，、；：!?！？…\s]+$/, '')
    .replace(/\*\*/g, '')
    .trim();
  if (t.length > 24) t = t.slice(0, 24) + '…';
  return t;
}

function titlePrompt({ question, selection, pageTitle }) {
  const L = [];
  L.push('根据下面这次网页问答的【用户提问】和【用户划选的原文片段】，为这段对话取一个简体中文标题。');
  L.push('要求：');
  L.push('- 8–16 个字，具体、能一眼看出在问什么；');
  L.push('- 优先把「片段讲的是什么」和「用户想知道什么」合并起来（不是把两者拼接）；');
  L.push('- 不要引号、不要结尾标点、不要「关于/讨论/请问/解释一下」这类空话；');
  L.push('- 只输出标题本身，不要任何解释或前缀。');
  L.push('');
  if (pageTitle) L.push('【页面标题】' + pageTitle);
  L.push('【用户提问】' + String(question || '').slice(0, 500));
  const sel = String(selection || '').replace(/\s+/g, ' ').trim();
  if (sel) L.push('【划选片段】' + sel.slice(0, 400));
  return L.join('\n');
}

/** 调一次轻量 pi（无工具、无会话、无扩展）生成标题，失败返回空串 */
/* ---------------- 直调模型（能拿到 api_key 时优先，比 pi 子进程省很多 token） ---------------- */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi/agent');

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

let targetCache = { at: 0, value: null };

/** 从 pi 自己的 auth.json / settings.json / models-store.json 推导一个可直接用的 OpenAI 兼容端点 */
function resolveDirectTarget() {
  if (targetCache.value && Date.now() - targetCache.at < 60000) return targetCache.value;
  let out = null;
  try {
    const auth = readJsonSafe(path.join(AGENT_DIR, 'auth.json')) || {};
    const settings = readJsonSafe(path.join(AGENT_DIR, 'settings.json')) || {};
    const store = readJsonSafe(path.join(AGENT_DIR, 'models-store.json')) || {};
    const provider =
      process.env.PI_WEB_ASK_TITLE_PROVIDER || settings.defaultProvider || Object.keys(auth)[0];
    const cred = provider && auth[provider];
    const models =
      (store[provider] && Array.isArray(store[provider].models) && store[provider].models) || [];
    const wantId = process.env.PI_WEB_ASK_TITLE_MODEL || settings.defaultModel || '';
    const model = models.find((m) => m.id === wantId) || models[0] || null;
    if (
      cred &&
      cred.type === 'api_key' &&
      cred.key &&
      model &&
      model.api === 'openai-completions' &&
      model.baseUrl
    ) {
      out = {
        provider,
        apiKey: cred.key,
        baseUrl: String(model.baseUrl).replace(/\/+$/, ''),
        model: model.id,
      };
    }
  } catch {}
  targetCache = { at: Date.now(), value: out };
  return out;
}

async function generateTitleDirect(ctx, target) {
  const body = {
    model: target.model,
    messages: [
      { role: 'system', content: '你是会话标题生成器。只输出一行标题，不要引号、不要解释。' },
      { role: 'user', content: titlePrompt(ctx) },
    ],
    max_tokens: 256,
    temperature: 0.3,
    stream: false,
  };
  const resp = await fetch(target.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + target.apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} ${txt.slice(0, 120)}`);
  }
  const j = await resp.json();
  const raw = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  const t = cleanTitle(raw);
  if (!t) throw new Error('空标题');
  const u = j.usage || {};
  log(
    'title(direct)',
    target.model,
    `prompt=${u.prompt_tokens ?? '?'} completion=${u.completion_tokens ?? '?'}`,
    '->',
    t,
  );
  return t;
}

/** 优先直调 API；拿不到 key / 非 chat-completions 接口时退回 pi 子进程 */
async function generateTitle(ctx) {
  const target = resolveDirectTarget();
  if (target) {
    try {
      const t = await generateTitleDirect(ctx, target);
      if (t) return t;
    } catch (e) {
      log('title(direct) 失败，改用 pi 子进程:', String((e && e.message) || e));
    }
  }
  return generateTitleViaPi(ctx);
}

function generateTitleViaPi(ctx) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let proc;
    try {
      proc = spawn(
        PI_BIN,
        [
          '-p', titlePrompt(ctx),
          '--no-session',
          '--no-tools',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-context-files',
          '--system-prompt', '你是会话标题生成器。只输出一行标题，不要引号、不要解释。',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      return finish('');
    }
    let out = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', () => {});
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      finish(cleanTitle(out));
    }, 20000);
    proc.on('error', () => {
      clearTimeout(timer);
      finish('');
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      finish(cleanTitle(out));
    });
  });
}

/* ---------------- 消息格式 ---------------- */
function buildContextMessage({ page, selection, question }) {
  const title = (page && page.title) || '(无标题)';
  const url = (page && page.url) || '';
  const body = ((page && page.text) || '').slice(0, MAX_PAGE_CHARS);
  const sel = (selection || '').slice(0, 20000);
  const L = [];
  L.push(`[页面标题] ${title}`);
  L.push(`[页面网址] ${url}`);
  L.push(`[选中文字] ${sel.length} 字`);
  if (sel) {
    L.push('----- 选中文字开始 -----');
    L.push(sel);
    L.push('----- 选中文字结束 -----');
  }
  L.push('----- 页面正文开始 -----');
  L.push(body || '(未能提取到正文)');
  L.push('----- 页面正文结束 -----');
  L.push('[我的问题]');
  L.push(question);
  return L.join('\n');
}

const SEL_START = '----- 选中文字开始 -----';
const SEL_END = '----- 选中文字结束 -----';

/** 追问轮只附「新划选的片段」，不重发整页正文 */
function buildSelectionMessage({ selection, question }) {
  const sel = String(selection || '').slice(0, 20000);
  const L = [];
  L.push(`[选中文字] ${sel.length} 字（用户刚刚新划选的，属于当前页面）`);
  L.push(SEL_START);
  L.push(sel);
  L.push(SEL_END);
  L.push('[我的问题]');
  L.push(question);
  return L.join('\n');
}

/** 从 pi 持久化的 user message 里还原「用户真正问的问题」+ 上下文元信息 */
function parseUserText(text) {
  const s = String(text || '');
  if (!s.startsWith('[页面标题] ') && !s.includes('[我的问题]')) {
    return { question: s, pageTitle: '', url: '', selLen: 0, selText: '' };
  }
  const title = (s.match(/^\[页面标题\] (.*)$/m) || [])[1] || '';
  const url = (s.match(/^\[页面网址\] (.*)$/m) || [])[1] || '';
  const selLen = Number((s.match(/^\[选中文字\] (\d+) 字/m) || [])[1] || 0);
  let selText = '';
  const a = s.indexOf(SEL_START);
  const b = s.indexOf(SEL_END);
  if (a >= 0 && b > a) selText = s.slice(a + SEL_START.length, b).trim().slice(0, 400);
  const marker = '\n[我的问题]\n';
  const at = s.lastIndexOf(marker);
  const question = at >= 0 ? s.slice(at + marker.length) : s;
  return { question, pageTitle: title, url, selLen, selText };
}

function readSessionMessages(id) {
  const f = sessionFile(id);
  let raw;
  try {
    raw = fs.readFileSync(f, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    if (m.role === 'user') {
      const raw0 =
        typeof m.content === 'string'
          ? m.content
          : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const p = parseUserText(raw0);
      out.push({
        role: 'user',
        text: p.question,
        pageTitle: p.pageTitle,
        pageUrl: p.url,
        selLen: p.selLen,
        selText: p.selText,
        withContext: /^\s*\[页面标题\]/.test(raw0),
        ts: m.timestamp || Date.parse(e.timestamp) || 0,
      });
    } else if (m.role === 'assistant') {
      const txt = (m.content || [])
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (txt) out.push({ role: 'assistant', text: txt, ts: m.timestamp || 0 });
    }
  }
  return out;
}

/** 标题兜底：index 丢了也能从文件里捞 */
function inferMetaFromFile(id) {
  const msgs = readSessionMessages(id);
  const first = msgs.find((m) => m.role === 'user');
  const t = first ? titleFromQuestion(first.text) : '';
  return {
    title: t || '新对话',
    titleSource: t ? 'question' : 'page',
    pageTitle: (first && first.pageTitle) || '',
    url: (first && first.pageUrl) || '',
    turns: msgs.filter((m) => m.role === 'user').length,
    updatedAt: fs.existsSync(sessionFile(id)) ? fs.statSync(sessionFile(id)).mtimeMs : Date.now(),
  };
}

function reconcile() {
  let files = [];
  try {
    files = fs.readdirSync(SESS_DIR).filter((f) => f.endsWith('.jsonl'));
  } catch {}
  let changed = false;
  const seen = new Set();
  for (const f of files) {
    const id = f.replace(/\.jsonl$/, '');
    seen.add(id);
    if (!index[id]) {
      index[id] = { id, createdAt: Date.now(), ...inferMetaFromFile(id) };
      changed = true;
    } else {
      const mtime = fs.statSync(path.join(SESS_DIR, f)).mtimeMs;
      if (mtime > (index[id].updatedAt || 0)) {
        index[id].updatedAt = mtime;
        changed = true;
      }
    }
    // 旧数据迁移：标题旧版是按网页名取的 → 改成「第一个提问」
    if (
      index[id].titleSource !== 'manual' &&
      index[id].titleSource !== 'question' &&
      index[id].titleSource !== 'ai'
    ) {
      const msgs = readSessionMessages(id);
      const firstUser = msgs.find((m) => m.role === 'user');
      const t = firstUser ? titleFromQuestion(firstUser.text) : '';
      if (t) {
        index[id].title = t;
        index[id].titleSource = 'question';
        changed = true;
      } else {
        index[id].titleSource = index[id].titleSource || 'page';
      }
      const fp = firstUser && firstUser.pageTitle;
      if (fp && !index[id].pageTitle) {
        index[id].pageTitle = fp.slice(0, 200);
        changed = true;
      }
    }
  }
  for (const id of Object.keys(index)) {
    if (seen.has(id)) continue;
    // 刚建好的会话：pi 可能要几百毫秒才真正落盘，这期间不能当成“文件已删”清掉索引
    const created = index[id].createdAt || 0;
    if (Date.now() - created < 180000) continue;
    delete index[id];
    changed = true;
  }
  if (changed) saveIndex();
}
reconcile();

function listSessions() {
  return Object.values(index)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((m) => ({
      id: m.id,
      title: m.title,
      titleSource: m.titleSource || '',
      pageTitle: m.pageTitle || '',
      url: m.url,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      turns: m.turns || 0,
      path: sessionFile(m.id),
    }));
}

/* ---------------- pi 进程 ---------------- */
class PiProc {
  constructor(id) {
    this.id = id;
    this.proc = null;
    this.dec = new StringDecoder('utf8');
    this.buf = '';
    this.pending = null;
    this.lastText = '';
    this.stderr = '';
    this.lastUsed = Date.now();
  }

  ensure() {
    if (this.proc) return;
    const file = sessionFile(this.id);
    log('spawn pi for', this.id);
    const proc = spawn(PI_BIN, piArgs(file), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_WEB_ASK: '1' },
    });
    this.proc = proc;
    this.buf = '';
    this.dec = new StringDecoder('utf8');
    proc.stdout.on('data', (c) => this.onData(c));
    proc.stderr.on('data', (c) => {
      this.stderr = (this.stderr + c.toString()).slice(-4000);
    });
    proc.on('error', (err) => this.fail(new Error(`无法启动 pi（${PI_BIN}）：${err.message}`)));
    proc.on('exit', (code, sig) => {
      this.proc = null;
      if (this.pending) {
        this.fail(
          new Error(
            `pi 进程退出（code=${code} sig=${sig}）` +
              (this.stderr ? '：' + this.stderr.slice(-400) : '')
          )
        );
      }
    });
  }

  fail(err) {
    const p = this.pending;
    this.pending = null;
    if (p) {
      p.emit({ type: 'error', message: err.message });
      p.resolve();
    }
  }

  onData(chunk) {
    this.buf += this.dec.write(chunk);
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i === -1) break;
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      this.onEvent(ev);
    }
  }

  onEvent(ev) {
    const p = this.pending;
    if (ev.type === 'message_update') {
      const a = ev.assistantMessageEvent;
      if (p && a && a.type === 'text_delta' && a.delta) p.emit({ type: 'delta', text: a.delta });
      return;
    }
    if (ev.type === 'message_end') {
      const m = ev.message;
      if (m && m.role === 'assistant') {
        this.lastText = (m.content || [])
          .filter((b) => b && b.type === 'text')
          .map((b) => b.text)
          .join('');
      }
      return;
    }
    if (ev.type === 'agent_settled') {
      if (p) {
        this.pending = null;
        p.emit({ type: 'done', text: this.lastText || p.acc });
        p.resolve();
      }
      return;
    }
    if (ev.type === 'auto_retry_end' && ev.success === false && p) {
      this.fail(new Error(ev.finalError || '重试用尽'));
    }
  }

  send(obj) {
    if (!this.proc) throw new Error('pi 未运行');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  ask(message, emit, signal) {
    this.ensure();
    this.lastUsed = Date.now();
    return new Promise((resolve) => {
      if (this.pending) {
        emit({ type: 'error', message: '上一轮还在生成，请先停止' });
        return resolve();
      }
      this.lastText = '';
      let acc = '';
      this.pending = {
        get acc() {
          return acc;
        },
        resolve,
        emit: (e) => {
          if (e.type === 'delta') acc += e.text;
          emit(e);
        },
      };
      if (signal) signal.addEventListener('abort', () => this.abort(), { once: true });
      try {
        this.send({ type: 'prompt', message });
      } catch (err) {
        this.fail(err);
      }
    });
  }

  abort() {
    if (!this.pending) return;
    try {
      this.send({ type: 'abort' });
    } catch {}
    const p = this.pending;
    this.pending = null;
    p.emit({ type: 'done', text: p.acc || this.lastText || '', aborted: true });
    p.resolve();
  }

  dispose() {
    if (!this.proc) return;
    try {
      this.send({ type: 'abort' });
    } catch {}
    try {
      this.proc.kill('SIGTERM');
    } catch {}
    this.proc = null;
    this.pending = null;
  }
}

const live = new Map();

function getProc(id) {
  let p = live.get(id);
  if (!p) {
    if (live.size >= MAX_LIVE) {
      let oldest = null;
      for (const [, v] of live) if (!oldest || v.lastUsed < oldest.lastUsed) oldest = v;
      if (oldest) {
        oldest.dispose();
        live.delete(oldest.id);
      }
    }
    p = new PiProc(id);
    live.set(id, p);
  }
  return p;
}

/* ---------------- HTTP ---------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 32 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    if (p === '/health') {
      return json(res, 200, { ok: true, pi: PI_BIN, sessions: listSessions().length, live: [...live.keys()] });
    }

    if (p === '/sessions' && req.method === 'GET') {
      reconcile();
      return json(res, 200, { sessions: listSessions() });
    }

    if (p === '/sessions' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const s = newSession({ url: body.url || '', title: body.title || '' });
      return json(res, 200, { session: s });
    }

    const rtm = p.match(/^\/sessions\/([\w-]+)\/retitle$/);
    if (rtm) {
      const id = rtm[1];
      if (!index[id]) return json(res, 404, { error: '会话不存在' });
      const msgs = readSessionMessages(id);
      const firstUser = msgs.find((m) => m.role === 'user');
      if (!firstUser) return json(res, 400, { error: '没有可用的首轮消息' });
      const t = await generateTitle({
        question: firstUser.text,
        selection: firstUser.selText || '',
        pageTitle: firstUser.pageTitle || '',
      });
      if (t) {
        index[id].title = t;
        index[id].titleSource = 'ai';
        saveIndex();
      }
      return json(res, 200, { session: index[id], generated: t });
    }

    const m = p.match(/^\/sessions\/([\w-]+)$/);
    if (m) {
      const id = m[1];
      if (!index[id]) return json(res, 404, { error: '会话不存在' });
      if (req.method === 'GET') {
        return json(res, 200, {
          session: { ...index[id], path: sessionFile(id) },
          messages: readSessionMessages(id),
        });
      }
      if (req.method === 'PATCH') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.title === 'string' && body.title.trim()) {
          index[id].title = body.title.trim().slice(0, 120);
          index[id].titleSource = 'manual';
          saveIndex();
        }
        return json(res, 200, { session: index[id] });
      }
      if (req.method === 'DELETE') {
        const lp = live.get(id);
        if (lp) {
          lp.dispose();
          live.delete(id);
        }
        try {
          fs.unlinkSync(sessionFile(id));
        } catch {}
        delete index[id];
        saveIndex();
        return json(res, 200, { ok: true });
      }
    }

    if (p === '/ask' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const question = String(body.question || '').trim();
      if (!question) return json(res, 400, { error: '问题不能为空' });

      let id = body.sessionId;
      if (!id || !index[id]) {
        // 先用「提问」当占位标题：就算后面 AI 取名失败或进程重启，历史里也不会是“新对话”
        const seed = titleFromQuestion(question);
        const s = newSession({
          url: (body.page && body.page.url) || '',
          pageTitle: (body.page && body.page.title) || '',
          title: seed,
          titleSource: seed ? 'question' : '',
        });
        id = s.id;
      }
      let meta = index[id];
      const pageUrl = (body.page && body.page.url) || '';
      const needContext = body.forceContext || meta.turns === 0 || !pageUrl || meta.url !== pageUrl;
      const sel = String(body.selection || '').trim();

      let message;
      if (needContext) {
        message = buildContextMessage({ page: body.page, selection: sel, question });
      } else if (sel) {
        // 追问 + 又划选了新片段：只补这段，不重发正文
        message = buildSelectionMessage({ selection: sel, question });
      } else {
        message = question;
      }

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        ...CORS,
      });
      let closed = false;
      const ac = new AbortController();
      res.on('close', () => {
        closed = true;
        ac.abort();
      });
      const emit = (o) => {
        if (closed) return;
        try {
          res.write(JSON.stringify(o) + '\n');
        } catch {
          closed = true;
        }
      };

      emit({
        type: 'session',
        id,
        title: meta.title,
        url: meta.url,
        turns: meta.turns,
        withContext: needContext,
        withSelection: Boolean(sel),
        path: sessionFile(id),
      });

      // 标题：首轮就把「提问 + 划选片段」交给小模型取名（与回答并行，不堵答）
      const wasFirstTurn = (meta.turns || 0) === 0;
      const wantsAutoTitle = wasFirstTurn && meta.titleSource !== 'manual';
      const titleTask = wantsAutoTitle
        ? generateTitle({
            question,
            selection: sel,
            pageTitle: (body.page && body.page.title) || '',
          })
        : null;

      const proc = getProc(id);
      await proc.ask(message, emit, ac.signal);

      // 回答期间索引可能被 reconcile 重建过（旧对象就成了孤儿），这里重新拿活的引用
      if (!index[id]) index[id] = meta;
      meta = index[id];

      if (pageUrl) meta.url = pageUrl;
      if (body.page && body.page.title) meta.pageTitle = body.page.title.slice(0, 200);

      if (wantsAutoTitle) {
        const fallback = titleFromQuestion(question) || titleFromQuestion(sel) || '';
        const gen = titleTask ? await titleTask : '';
        const t = gen || fallback;
        if (t) {
          meta.title = t;
          meta.titleSource = gen ? 'ai' : 'question';
        }
      }

      meta.turns = (meta.turns || 0) + 1;
      meta.updatedAt = Date.now();
      saveIndex();

      emit({ type: 'end', title: meta.title, turns: meta.turns });
      if (!closed) res.end();
      return;
    }

    if (p === '/abort' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const proc = live.get(body.sessionId);
      if (proc) proc.abort();
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    try {
      json(res, 500, { error: String((err && err.message) || err) });
    } catch {}
  }
});

server.listen(PORT, HOST, () => log(`pi-web-ask daemon v2 on http://${HOST}:${PORT} (pi=${PI_BIN})`));

setInterval(() => {
  const now = Date.now();
  for (const [id, proc] of live) {
    if (now - proc.lastUsed > IDLE_MS && !proc.pending) {
      log('idle dispose', id);
      proc.dispose();
      live.delete(id);
    }
  }
}, 60 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const [, proc] of live) proc.dispose();
    process.exit(0);
  });
}
