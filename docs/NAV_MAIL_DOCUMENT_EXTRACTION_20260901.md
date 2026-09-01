# NAV 邮件文档附件安全提取与 AI 翻译

状态：`LOCAL_DONE / READY_FOR_CI / NOT_DEPLOYED`
基线：`a7c00709545644587bda6113c8039d7e1acbba67`
分支：`codex/nav-mail-doc-extract-20260901`

## 能力边界

附件仍然只在登录用户点击“AI 翻译”后从其所属邮箱位置按需读取。服务端先在独立、受资源限制的
Worker 中提取安全文本，再沿用现有 AI 脱敏、限流、短期内存缓存和用量审计链路。

支持：

- PDF：只读取已有文本层，按 `[PDF 第 N 页]` 保留页码来源；
- DOCX：读取正文、页眉、页脚、脚注和尾注，不尝试推断并不存在于 OOXML 中的渲染页码；
- PPTX：按演示文稿顺序读取幻灯片，并保留 `[幻灯片 N]` 来源；
- XLSX：按工作簿顺序读取工作表、共享字符串和单元格缓存值，保留工作表名称与单元格坐标；
- 原有 UTF-8 文本、Markdown、CSV、JSON、XML 等格式保持不变。

明确不支持：

- OCR、扫描版 PDF 识别、密码解密；
- DOC/XLS/PPT 等旧版 OLE Office 二进制格式；
- 宏、VBA、XLM、JavaScript、ActiveX、嵌入对象；
- 外部 OOXML relationship、PDF 外链/动作；
- 公式、宏或任何附件内容的执行；
- 自动下载、自动预览、落盘临时文件或源文档明文持久化。

## 固定安全限制

| 项目 | 上限 |
| --- | ---: |
| 文档附件原始大小 | 8 MiB |
| 提取正文 | 12,000 字符 |
| Worker 时间 | 5 秒 |
| Worker old generation | 128 MiB |
| ZIP 条目 | 512 |
| ZIP 单条目解压 | 8 MiB |
| ZIP 总解压 | 32 MiB |
| ZIP 压缩比 | 100:1 |
| PDF 页数 | 200 |
| PPTX 幻灯片 | 200 |
| XLSX 工作表 | 64 |
| XML 节点 | 50,000 |
| 工作表单元格 | 20,000 |

Worker 内覆盖 `fetch` 为失败实现；解析器只接收内存中的附件字节，不接受 URL、路径、字体、CMap
或其他网络资源。超时会强制终止 Worker。OOXML 使用 lazy-entry ZIP 读取，先检查条目数量、尺寸、
压缩比、加密位和危险部件，再解压需要的 XML。所有 XML 在解析前拒绝 DTD、ENTITY 和
`xml-stylesheet`。

## 依赖与许可证

| 依赖 | 固定版本 | 用途 | 许可证 | 上游 |
| --- | --- | --- | --- | --- |
| `pdfjs-dist` | 6.3.289 | Mozilla PDF.js 文本层与页级元数据 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| `yauzl` | 3.4.0 | lazy-entry、尺寸校验的 ZIP 中央目录读取 | MIT | https://github.com/thejoshwolfe/yauzl |
| `saxes` | 6.0.0 | 事件式、无外部资源解析的 OOXML XML 读取 | ISC | https://github.com/lddubeau/saxes |

三项均为只读解析依赖。没有引入 LibreOffice、Office Automation、Headless Chromium、OCR、Shell
命令或原生文档执行器。

本地 `npm audit --omit=dev` 仍报告基线已经存在的 4 个 high 告警，名称均位于
`@huggingface/transformers`、`onnxruntime-node`、`sharp`、`adm-zip` 语义索引依赖链；本次新增的
`pdfjs-dist`、`yauzl`、`saxes` 不在告警列表中。此结论不等于以后无需重新审计。

## 明文生命周期

1. IMAP 下载的原附件仍由现有 `fetchIncomingAttachment` 所有权校验保护。
2. 主线程复制一份有界字节到 Worker；Worker 结束后清零仍可访问的缓冲区。
3. Worker 只返回有界纯文本和来源标签，不写文件、不写数据库。
4. 路由完成或失败后继续执行既有 `attachment.content.fill(0)`。
5. 只有脱敏后的安全文本进入已配置 AI；AI 结果沿用现有进程内 TTL/LRU 缓存，不新增持久化表。

## 后续门禁

- 本地 Node.js 24.14.0 API 全量：756 项，745 通过、0 失败、11 跳过；
- 本地 Vite 生产构建通过；
- GitHub Linux 全量 CI；
- 使用真实但无敏感内容的 PDF/DOCX/PPTX/XLSX 做浏览器验收；
- 若发布，继续遵守精确 merge SHA、备份、隔离恢复和只重建授权服务的发布边界；
- 本文不构成生产发布授权。
