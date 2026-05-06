# 项目长期记忆

## 项目概述
Zotero 插件：学术成果填表系统
- 解析 DOCX 模板，用 LLM 智能填充学术数据（论文、项目、专利）
- 前端：src/modules/academicForm.ts + wordProcessor.ts
- 后端：server/word_fill_app/main.py（FastAPI）

## 关键技术决策

### ⚠️ Zotero 数据库安全约束（重要！）
- zotero.db 中的表结构由 Zotero 内置 schema 定义，**本模块只负责数据同步（添加/更新），绝不修改表结构**
- zotero.db 的数据只能通过 `import_zotero_items()` 方法添加/更新（Upsert），`execute_write()` 对 zotero.db 直接抛异常
- personal.db 的表结构在 `PERSONAL_TABLES` 字典中集中定义，`CREATE TABLE IF NOT EXISTS` 初始化，运行时不再修改
- `validate_sql_safety()` 只放行 SELECT，黑名单拦截 DROP/DELETE/INSERT/UPDATE/ALTER/CREATE/TRUNCATE/EXEC/ATTACH

### CV/PDF 导入架构（2026-04-05 修复）
- `/kb/import/document` 支持**两种模式**：
  1. **二进制文件模式**：传 `file_base64`（Base64），后端用 pypdf/python-docx 提取文本
  2. **纯文本模式**：传 `content`（直接文本）
- 前端根据文件扩展名自动选择：`.pdf/.docx/.doc` → base64，其他 → 纯文本
- **关键**：前端 `readFileAsText()` 对 PDF 文件只能读到乱码，必须用 `readFileAsBase64Simple()` + 后端提取

### XPCOM 文件写入（Zotero 7）
- `nsIBinaryOutputStream.writeByteArray` 只接受 `Array<number>`，**不接受** `Uint8Array`
- 正确写法：`const byteArray = Array.from(uint8Array); binaryStream.writeByteArray(byteArray, byteArray.length);`

### 表格匹配算法
- 采用比例评分制：匹配比例 ≥ 50% 即可建立映射，100% 匹配 + 同列数 = 100 分
- 分数 = 尺寸分(0~10) + 匹配分(0~90)

### ZIP 文件处理 / base64 传输
- DOCX 本质是 ZIP，base64 传输时可能损坏 → `_repair_zip()` 修复
- `docx_base64`（二进制）必须 base64；`papers_markdown`（纯文本）直接明文

## 接口说明
- `POST /fill_base64`：接收 JSON `{docx_base64, papers_markdown}`，返回 `{success, docx_base64}`
- `POST /agent/fill`：核心端点，Agent 自主完成全部填表流程
- codeflow.asia 分组路由：`claude-*` → `/ato/v1`，`gemini-*` → `/gemini/v1`

### 核心模块依赖关系
```
main.py (FastAPI app)
  ├─ include_router → api/agent_routes.py (POST /agent/fill)
  │                    ├─ agent/graph.py (create_agent_graph → StateGraph)
  │                    │   ├── agent/state.py (AgentState)
  │                    │   └── agent/tools/*.py (@tool 函数 × 6)
  │                    │       ├── parse_docx.py → 解析 DOCX 表格结构
  │                    │       ├── query_kb.py → SQL 查询知识库
  │                    │       ├── hybrid_rag.py → BM25+向量+RRF 混合检索
  │                    │       ├── fetch_academic.py → 远程学术 API (DBLP+CrossRef)
  │                    │       └── fill_docx.py → core/__init__.py (XML 填充)
  │                    └─ agent/memory.py (memory_store)
  ├─ include_router → api/kb_routes.py (14 个 KB 端点)
  └─ core/__init__.py (parse_markdown_tables, fill_xml_tables_all, repair_zip)
```

### Agent 执行流程（三段式架构，2026-04-06 重构）

```
🔷 阶段一：数据采集（步骤 1~4）
Step1: parse_docx           → 解析 DOCX，提取表格结构/表头/空字段/文档语言
Step2: query_knowledge_base → 一次性查询所有结构化数据（person/projects/patents/datasets）
Step3: hybrid_rag_retrieve  → 1~3 次针对性 RAG 检索（教学/经历/经费/团队等）
Step4: fetch_academic_data  → 获取论文数据（DBLP+CrossRef 远程 API）

🔷 阶段二：整理输出（步骤 5 — LLM 推理中完成）
Step5A: 为每个 Word 表格生成标准 Markdown（列名一一对应）
Step5B: 输出映射关系分析（哪个 MD → 哪个 Word）
Step5C: 输出待填表格清单（有表头表格的 headers / 空表格的 title）

🔷 阶段三：写入文档（步骤 6）
Step6: fill_docx → 传入整理好的 tables_markdown + mapping_info，填充 DOCX
       返回 mapping_summary + word_headers_summary 用于校验
```

**三种 Markdown 格式**：
- **格式 A**：有表头普通表格（Markdown 列名 = Word 列名）
- **格式 B**：无表头空表格（| 表格标题 | 填充内容 |）
- **格式 C**：最终校验清单（fill_docx 调用前自动核对）

## 部署架构
- Agent + 后端运行在用户本机（localhost:8000/8001）
- 知识库/向量库保存在用户本地
- 未来 PyInstaller 打包后端为 exe 实现一键部署

## 重要 Bug 修复记录
- **2026-03-30**: empty_table_fillings 字段缺失 → system prompt 补齐定义
- **2026-03-30**: 空表格格式统一为标准 Markdown `| 表格标题 | 填充内容 |`
- **2026-04-02**: Chroma collection.query(n_results=0) 崩溃 / @tool 函数名递归 / SELECT 1 误判
- **2026-04-05**: CV 导入存 PDF 二进制而非文本 → 后端 pypdf 提取 + 前端 base64 上传
- **2026-04-06**: 论文未填全修复（3个层面）:
  - `core/__init__.py`: 行复制从手动3层改用 `_deep_copy_element` 递归深复制（保留 XML 格式属性），添加 `_clear_cell_text` 清空表头残留文字
  - `agent/graph.py`: system prompt 加强论文全量写入强调，明确说明"Word空行数不影响论文数量，系统自动扩展行数"
  - `api/agent_routes.py`: `_create_llm` 默认 `max_tokens=16384`，防止45条论文的 Markdown 表格被 token 限制截断
- **2026-04-06 (下午)**: 论文截断问题二次修复（max_tokens=16384 仍不够）:
  - `api/agent_routes.py`: 默认 `max_tokens` 从 16384 → **32768**（两个分支都更新）
  - `agent/tools/fill_docx.py`: 新增**论文截断检测**机制 — `_detect_paper_truncation()` + `_is_paper_table()`
    - 从 `graph.py tools_wrapper` 注入学术 API 返回的论文总数 `_academic_paper_total`
    - 如果论文表格行数 < API 返回数的 80%，返回错误 + 重试提示，LLM 会自动重试
  - `agent/graph.py`: system prompt 新增"输出截断应急策略"，指导 LLM 分批填写或只传论文表格
- **2026-04-06 (晚)**: 学术 API `user_fields` 动态生成机制重构:
  - `fetch_academic.py`: `USER_FIELDS_WHITELIST` 替换为用户提供的严格白名单（精简为18个核心字段）
  - `tools/__init__.py`: 导出 `set_academic_user_fields`
  - `graph.py tools_wrapper`: 新增 `_build_dynamic_user_fields_from_parse_result()` 函数
    - 在调用 `fetch_academic_data` 前，从 `parse_docx` 返回结果中提取表头 headers
    - 根据 headers 与白名单匹配，动态生成只包含文档所需字段的 `user_fields`
    - 调用 `set_academic_user_fields()` 注入，确保 API 只返回必要数据

### XML 元素复制陷阱
- **`copy.deepcopy` 会把命名空间前缀 `w:` 改为 `ns0:`**，虽然 XML 规范上等价，但某些场景可能引起问题
- 手动用 `ET.Element(element.tag, element.attrib)` + 递归子元素复制可以保持 tag 名不变
- `_deep_copy_element` 比 copy.deepcopy 更适合 XML ElementTree 元素复制

## DBLP 论文导入功能增强（2026-04-07）
### 增强的 DblpPublication 接口（authorProfile.ts）
```typescript
interface DblpPublication {
    title: string;
    year?: string;
    type?: 'article' | 'inproceedings' | 'book' | 'incollection' | 'phdthesis' | 'mastersthesis' | 'proceedings';
    venue?: string;           // journal 或 booktitle
    journal?: string;          // 期刊名（article）
    booktitle?: string;        // 会议名（inproceedings）
    volume?: string;
    number?: string;
    pages?: string;
    doi?: string;
    ee?: string;               // 电子版链接
    url?: string;               // DBLP 页面链接
    publisher?: string;
    series?: string;
    isbn?: string;
    month?: string;
    crossref?: string;
    authors?: string[];
}
```

### 新增函数
- `fetchDblpAuthorPublications(pid, limit=500)` — 解析完整的 DBLP XML 字段（原来只取 title/year/doi/url）
- `importPapersToZotero(publications, authorName, onProgress)` — 将论文导入 Zotero（去重：DOI + 标题年份）
- `handleImportPapersToZotero(author, publications, dialog)` — 带确认对话框和状态提示的导入处理器

### 作者详情弹窗新增按钮
- 新增「📥 导入全部论文到 Zotero（N篇）」按钮
- 显示导入进度和结果统计（成功/已存在/跳过/失败）
