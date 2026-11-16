# 设计说明

## 为什么不用 pi 的 extension

pi 的 extension（`docs/extensions.md`）跑在 pi 进程内部：注册工具、加斜杠命令、改 TUI 界面。它**拿不到浏览器里的选中文字，也画不出浮窗**。

所以分工是：浏览器扩展只负责抓内容（DOM），AI 侧走 **RPC 模式**：

```bash
pi --mode rpc      # JSONL over stdin/stdout，流式 text_delta / message_end / agent_settled
```

实测结论：`--mode rpc` 可用、可流式；进程存活期间保持 stdin 打开即可常驻；`--session <file>` 在文件不存在时新建、存在时**载入历史继续** —— 这是会话持久化的基础。

## 一个对话 = 一个 pi session 文件

上下文由 pi 自己从文件恢复，所以关浏览器、重启 daemon 都不丢，而且能直接在终端续聊。daemon 只维护一份索引（标题 / URL / 轮次），索引丢了可以从文件重建。

pi 启动参数（纯问答形态，输入 token 从 ~14k 降到 400–1000）：

```bash
pi --mode rpc --session <file> --no-tools --no-extensions --no-skills \
   --no-prompt-templates --no-context-files --system-prompt "<网页阅读助手提示词>" --name web-ask
```

`--no-tools` 不只是省钱，也避免 AI 在用户机器上乱跑 bash。system prompt 里额外约定：**引用页面原文必须用 `>` 引用块逐字照抄**，界面据此生成「↗ 定位原文」按钮。

## 上下文注入策略（省 token 的关键）

- 新对话第一问 → 附整页正文 + 选中文字
- 同一对话内**换了页面** → 重新附新页面上下文
- **追问时又划选了新片段** → 只补这段，不重发正文
- 其余追问 → 只发问题（上下文已在 pi 的 session 里）

首轮 user message 用可解析的固定格式落库：

```
[页面标题] ...
[页面网址] ...
[选中文字] N 字
----- 选中文字开始 -----
...
----- 选中文字结束 -----
----- 页面正文开始 -----
...
----- 页面正文结束 -----
[我的问题]
...
```

`GET /sessions/<id>` 会用正则把这段反向解析成 `{question, pageTitle, pageUrl, selLen, selText}`，所以界面上只显示「问题 + 附属 chips」，不会把 6 万字正文糊到聊天记录里。

> v0.4 修复的坑：早期实现里追问轮会把 `selection` 整个丢掉，导致「同一 session 内新选一段再问，模型完全没感知」。现在追问轮只要检测到非空选中就补 `buildSelectionMessage()`，并在 session 事件里回传 `withSelection`。

## 会话标题生成（v0.6 → v0.7）

标题由首轮的「提问 + 划选片段 + 页面标题」交给一个小模型生成（8–16 字，只输出标题），不用网页标题，也不直接截取提问。

- 生成在**回答的同时并行**跑，回答结束时的 `end` 事件带回新标题 → 首轮几乎无额外延迟
- **优先直调模型 API**：从 pi 自己的 `~/.pi/agent/{auth.json,settings.json,models-store.json}` 推导出 `api_key + baseUrl + model`（全本机，不额外存密钥），直接 `POST {baseUrl}/chat/completions`，`max_tokens=256 / temperature=0.3 / 15s 超时`。实测一次调用 prompt ≈ 200 token、completion ≈ 180 token，约 2s；比走 `pi -p` 子进程省一半以上输入 token，也更快
- 拿不到 `api_key`（如浏览器 OAuth 登录）、provider 不是 `openai-completions`、或直调失败 → 自动回退 `pi -p --no-session --no-tools` 子进程（不污染对话 session，20s 超时）
- 两者都失败才回落到 `titleFromQuestion()`（去尾部标点、40 字截断）
- `titleSource` 记录来源：`pending` → `ai` / `question` / `manual`（`PATCH` 改名后永不被覆盖）
- 旧会话可用 `POST /sessions/<id>/retitle` 重新生成标题

## 正文提取

`article / main / [role=main] / #content / .post` 优先，否则 `body`；TreeWalker 跳过 `script/style/nav/footer/aside/form/button…`，块级元素补换行，折叠空白，默认截 60k 字。

## 定位原文（跳回页面）

模型引用的句子要能在页面上找到并高亮：

1. 把 body 所有可见文本节点拼成一条字符串，同时做**归一化**（去掉 `「」『』""''《》【】`、空白折叠成单空格）并记录每个字符来自哪个文本节点的哪个偏移
2. 归一化待查句 → `indexOf`；失败则按 60/40/28/18 字前缀递减重试（应对模型拼接或省略）
3. 命中后把两端偏移映射回 `Range`
4. 优先 `CSS.highlights`（Custom Highlight API，不改 DOM，不会惹毛 React/Vue）；不支持时降级为逐文本节点包 `<mark>`
5. `scrollIntoView({block:'center'})`

已验证：带引号、跨节点、空白不一致都能命中；页面没有的句子会返回「没找到」而不是乱跳。

## 流式协议与前端

```
POST /ask → NDJSON：
{"type":"session",...}   首帧回传会话 id
{"type":"delta","text":"…"}
{"type":"done","text":"完整答案"}     以 message_end 为准
{"type":"end"}
{"type":"error","message":"…"}
```

前端 70ms 节流重渲染 markdown，避免长回答卡顿；`AbortController` 断开连接即 abort 后端。

markdown 渲染是手写极简版（先转义再做行内/块级），支持标题/列表/引用/代码块/表格/链接，防 XSS。

## 进程池

pi 进程按会话 key 常驻，超过 `MAX_LIVE=4` 时淘汰最久未用；空闲 30min 回收（会话不丢，下次重建进程时从文件恢复）。

## 踩过的坑：标题被索引竞态吃掉

**现象**：有时历史列表里显示的是截取式标题（`titleSource=question`），而不是 AI 生成的。

**根因**：`reconcile()` 的两处逻辑与 `/ask` 抢跑。

1. `newSession()` 先写索引，但 pi 要几百毫秒才真正创建 `.jsonl`。这期间若有 `GET /sessions`（打开历史面板）触发 `reconcile()`，它会把「有索引、没文件」的条目当成「文件已删」直接删掉
2. 随后 `reconcile()` 又按盘上文件重建条目 → `inferMetaFromFile()` 只能拿到提问，于是盖上 `titleSource=question` 的截取标题
3. 而 `/ask` 手里还攥着**已被删除的旧对象引用**，结尾把 AI 标题写到孤儿对象上，`saveIndex()` 自然落不到盘

**修法**：reconcile 的清理加 3 分钟宽限期（`createdAt` 太新就不删）；`/ask` 在回答结束后重新 `meta = index[id]`（缺失就塞回去）；新建会话时先用「提问」当占位标题，这样即便 AI 取名丢失也不会显示「新对话」。用「ask 进行中连打 3 次 /sessions」复现并验证修复。

## 关于「历史里只有 4 个对话」

不是 bug：**一个标签页只有一个活跃对话**，不点 `＋` 就一直续在同一 session 里（换页面也只是重新附上下文，不新开）。为避免误解：

- 历史面板顶部显示「共 N 个对话 / 搜索时显示 N / M」
- 当侧边栏发现「当前对话绑定的页面 ≠ 当前标签页」时，上下文行出现 `⚠ 换页了 · 新开对话` 按钮，一键开新对话
