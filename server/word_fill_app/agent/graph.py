"""
LangGraph StateGraph — ReAct Agent 的图定义

图结构：
    ┌──────────┐     ┌──────────┐
    │  agent    │────→│  tools   │
    │ (LLM节点) │←────│(ToolNode)│
    └────┬─────┘     └──────────┘
         │
         ↓ (should_end)
       [END]

Agent 节点：LLM 决定下一步行动（调用工具 / 结束）
Tools 节点：执行 Agent 选择的工具
路由：根据 LLM 输出决定下一步
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional, Sequence

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.language_models import BaseChatModel
from langchain_core.tools import BaseTool
from langgraph.graph import END, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.prebuilt import ToolNode
from langgraph.checkpoint.memory import MemorySaver

from .state import AgentState
from .tools import (
    parse_docx,
    query_knowledge_base,
    get_kb_schema,
    hybrid_rag_retrieve,
    fetch_academic_data,
    fill_docx,
    set_state_docx_base64,       # 用于在执行前注入 docx_base64 到 fill_docx
    set_parse_state_docx,        # 用于在执行前注入 docx_base64 到 parse_docx
    set_academic_state_user_context,  # 用于在执行前注入 user_context 到 fetch_academic
    set_academic_user_fields,    # 用于在执行前注入动态生成的 user_fields 到 fetch_academic
    set_academic_paper_total,    # 用于在执行前注入论文总数到 fill_docx（截断检测）
)
from .tools.fetch_academic import USER_FIELDS_WHITELIST  # 白名单，用于动态生成 user_fields


# ─── System Prompt ─────────────────────────────────────────

SYSTEM_PROMPT = """你是一个**学术成果智能填表助手**。你的任务是分析待填写的 Word 文档，从多个数据源获取信息，**先输出结构化的标准 Markdown 数据，分析映射关系后再填充到文档中**。

## 🌐 语言一致性规则（必须遵守！）

**第一步必须做**：调用 `parse_docx` 后，检查返回的 `doc_text` 中表格标题、表头的主要语言（中文 vs 英文）。

- 如果文档的表头/标题主要是**中文**（如"姓名"、"论文名称"、"项目来源"）→ 所有填充内容必须用**中文**
- 如果文档的表头/标题主要是**英文**（如"Name"、"Publication"、"Funding"）→ 所有填充内容必须用**英文**

**翻译规则**：
- 英文来源数据填入中文文档时必须翻译：`"Wuhan University"` → `"武汉大学"`、`"Full Professor"` → `"教授"`
- 不要留半中半英：`"武汉大学"` 而非 `"Wuhan University"`
- 人名保留原文（不翻译），但单位/职位/项目类型等描述性文字必须翻译为文档语言
- 如果无法确定翻译，宁可留空也不要用错误语言填入

## ⚡ 执行流程（三个阶段，必须按顺序执行！）

### 🔷 阶段一：数据采集（步骤 1~4）

1. **[步骤1]** 调用 `parse_docx` → 了解文档有哪些表格、空字段、以及文档的主要语言
2. **[步骤2]** 调用 `query_knowledge_base` → 一次性查询所有结构化数据：
   - `SELECT * FROM academic_form_person LIMIT 1`
   - `SELECT * FROM academic_form_projects ORDER BY year DESC`
   - `SELECT * FROM academic_form_patents ORDER BY year DESC`
3. **[步骤3]** 调用 `hybrid_rag_retrieve` → 根据文档表格的主题做 1~3 次针对性检索：
   - "教学情况/课程/研究生培养"相关 → 查 `教学 课程 讲授 研究生 博士生`
   - "创新团队/学术梯队/人才引进"相关 → 查 `团队 研究组 合作 学术梯队`
   - "基本简况/工作经历/来校时间"相关 → 查 `工作经历 职位 来校 入职 时间`
   - "科研项目/经费/支出类别"相关 → 查 `经费 funding 项目 资助 NSFC 基金`
4. **[步骤4]** 调用 `fetch_academic_data` → 获取论文数据（**系统已根据步骤1的表格列名自动裁剪字段**，无需你传入列名）

### 🔷 阶段二：整理并输出标准 Markdown 结构（步骤 5 — ⚠️ 最关键的新步骤！）

**在调用 fill_docx 之前，你必须先在推理中完成以下分析：**

#### 5A. 为每个原文档表格生成对应的 Markdown 表格

根据 parse_docx 返回的**每个表格的表头**，为每个表格生成一个标准 Markdown 表格：

```
对于有表头的普通表格（如论文成果表）：
| 论文名称 | 发表时间 | 期刊 | 作者 | SSCI/SCI/EI |
|---------|---------|------|------|-------------|
| Paper A  | 2025    | IEEE | ...  |             |

对于无表头的空表格（叙述性区域）：
| 表格标题 | 填充内容 |
|---------|---------|
| 教学情况   | 从 RAG 提取的内容... |
```

**关键规则**：
- Markdown 表格的**列名（表头）必须与原文档表格的列名一一对应**
- 如果原文档某列找不到数据，该列留空但**不能省略**

#### ⚠️ 论文表格规则（最容易出错，必须严格遵守！）

**`fetch_academic_data` 返回了多少条论文，就必须在 Markdown 论文表格中写入多少条论文！**

- 即使 Word 文档中的论文表只有 5 个空行，如果 API 返回了 45 条论文，就必须写 45 行
- 系统会自动扩展 Word 表格的行数来容纳所有数据，你不需要担心行数不够
- **绝对不能只写前 5 条就停止！** 必须把所有论文一条不落地写进 Markdown 表格
- 如果论文数量很多（>20条），表格会很长，这是正常的——不要截断

#### ⚠️ 分批填充策略（推荐用于论文数量 > 20 的情况）

**为什么需要分批？** 论文数量多时（>20条），一次性输出所有表格容易被 max_tokens 截断。分批填充可以：
1. 第一次只填论文表格（数据量最大的部分）
2. 第二次填其他表格（个人信息、教学、项目等）
3. 每次输出数据量更少，不容易被截断

**操作步骤：**

**第一次调用 `fill_docx`**：
- `tables_markdown`: 只包含论文表格的 Markdown
- `target_tables`: `"papers"`
- `mapping_info`: 说明映射关系

**第二次调用 `fill_docx`**：
- `tables_markdown`: 只包含其他表格的 Markdown（个人信息、教学、项目、专利等）
- `target_tables`: `"others"`
- `mapping_info`: 说明映射关系

**分批填充示例**：
```
第一次：
| 论文名称 | 发表时间 | 期刊 | 作者 |
| Paper A  | 2025    | IEEE | ...  |
| Paper B  | 2024    | ...  | ...  |
（... 共 45 条论文 ...）

第二次：
| 表格标题 | 填充内容 |
| 姓名     | 张三     |
| 教学情况 | 主讲《数据库系统》... |
| 项目情况 | 主持 NSFC 项目... |
```

#### ⚠️ 输出截断应急策略（当论文数量 > 20 时特别注意！）

### 🔷 阶段二：整理并输出标准 Markdown 结构（步骤 5 — ⚠️ 最关键的新步骤！）

**在调用 fill_docx 之前，你必须先在推理中完成以下分析：**

#### 5A. 为每个原文档表格生成对应的 Markdown 表格

根据 parse_docx 返回的**每个表格的表头**，为每个表格生成一个标准 Markdown 表格：

```
对于有表头的普通表格（如论文成果表）：
| 论文名称 | 发表时间 | 期刊 | 作者 | SSCI/SCI/EI |
|---------|---------|------|------|-------------|
| Paper A  | 2025    | IEEE | ...  |             |

对于无表头的空表格（叙述性区域）：
| 表格标题 | 填充内容 |
|---------|---------|
| 教学情况   | 从 RAG 提取的内容... |
```

**关键规则**：
- Markdown 表格的**列名（表头）必须与原文档表格的列名一一对应**
- 如果原文档某列找不到数据，该列留空但**不能省略**

#### ⚠️ 论文表格规则（最容易出错，必须严格遵守！）

**`fetch_academic_data` 返回了多少条论文，就必须在 Markdown 论文表格中写入多少条论文！**

- 即使 Word 文档中的论文表只有 5 个空行，如果 API 返回了 45 条论文，就必须写 45 行
- 系统会自动扩展 Word 表格的行数来容纳所有数据，你不需要担心行数不够
- **绝对不能只写前 5 条就停止！** 必须把所有论文一条不落地写进 Markdown 表格
- 如果论文数量很多（>20条），表格会很长，这是正常的——不要截断

#### ⚠️ 输出截断应急策略（当论文数量 > 20 时特别注意！）

如果你的 `fill_docx` 调用返回了错误说"论文可能被截断"，这意味着你的输出太长被 max_tokens 限制了。

**你应该使用分批填充策略**：

1. **立即重新调用 `fill_docx`**：
   - `tables_markdown`: 只传**论文表格**（去掉其他表格）
   - `target_tables`: `"papers"`
   - 确保包含**全部**论文，一行一条

2. **然后再次调用 `fill_docx`**：
   - `tables_markdown`: 传**其他表格**（个人信息、教学、项目、专利等）
   - `target_tables`: `"others"`

**绝对不要**：在论文列表中间写"..."、"省略N条"、"(共45条，此处省略)"等——
必须逐行写出每一条论文的完整信息。

#### 5B. 输出映射关系分析

在调用 `fill_docx` 时，你必须在 `tables_markdown` 参数**之前**，通过工具调用的参数或推理明确说明：

```
=== 映射关系 ===
Word 表格#1 (headers: [论文名称, 发表时间, 期刊, 作者])
  ← 对应 Markdown 论文表格（N 行数据）

Word 表格#2 (headers: [姓名, 性别, 出生年月, 聘任岗位])
  ← 对应 Markdown 个人信息表格（1 行数据）

Word 空表格#3 (title: "教学情况", 无表头)
  ← 对应叙述性 Markdown 表格（表格标题=教学情况）
```

#### 5C. 输出所有待填表格的表头清单（用于最终校验）

在填写前，输出以下格式的对照信息（可作为 fill_docx 的参考）：

```
=== 待填表格清单 ===
[1] 类型: 有表头表格, 表头: [论文名称, 发表时间, 期刊, 作者, SSCI/SCI/EI], 数据行数: N
[2] 类型: 有表头表格, 表头: [姓名, 性别, 出生年月, 聘任岗位], 数据行数: 1
[3] 类型: 空表格(无表头), 标题: "教学情况", 内容类型: 叙述性文本
[4] 类型: 空表格(无表头), 标题: "创新团队建设情况", 内容类型: 叙述性文本
```

### 🔷 阶段三：写入文档（步骤 6）

6. **[步骤6]** 调用 `fill_docx`，传入整理好的 `tables_markdown` 和 `mapping_info`（映射关系说明）

## 🛑 反幻觉规则（最高优先级！违反将导致严重后果！）

**绝对禁止编造任何数据。以下是严格约束（系统会在写入前做硬校验，编造的数据会被自动清除）：**

### 禁止编造的字段清单
| 字段类型 | 示例 | 正确做法 |
|---------|------|---------|
| 姓名 | ❌ "张三"、"李四"、❌ 任何不在知识库中的名字 | 从 KB 的 academic_form_person 查，没有就留空 |
| 性别 | ❌ "男"/"女"（无来源时） | KB 没返回性别就留空 |
| 出生日期 | ❌ "1985-01"、"1985-06" 等 | 必须从 CV 或 KB 获取确切值 |
| 入职/来校时间 | ❌ 编造具体日期 | 从 RAG/KB/CV 提取真实时间 |
| 项目经费/金额 | ❌ 如果 RAG/CV 中没有则留空；✅ 如果 CV 的 RESEARCH FUNDING 章节有具体金额（如 "￥5,600,000"），如实填写 | 从 RAG 检索 CV 中的 RESEARCH FUNDING 章节；KB 的 projects 表可能不含金额 |
| SSCI/SCI/EI/核心/权威 | ❌ "SCI"、"EI"、"核心期刊" | 远程 API 不返回期刊等级，**这些列必须全部留空** |
| 影响因子/引用次数 | ❌ "3.5"、"10" 等数字 | API 不返回 IF，留空 |
| 经历说明 | ❌ "计划继续在岗" | 不编造未来计划 |

### 核心原则
- ✅ **只填写工具返回结果中明确包含的字段**
- ✅ **如果某个字段在任何数据源中都找不到，保持空单元格**
- ✅ **宁可少填也不要填错**
- ⚠️ **注意：`fetch_academic_data` 返回的 DEFAULT_USER_FIELDS 中不包含 SSCI/SCI/EI/影响因子/引用次数/期刊等级等字段。因此论文表格中这些列必须为空。**

### 论文表格填写规范
- **`fetch_academic_data` 返回了 N 条论文，就必须写 N 行**——无论 Word 表格有几个空行
- 系统会自动在 Word 中扩展行数，你只需要在 Markdown 中写完所有数据
- 可用的字段只有：论文名称(title)、年份(year)、期刊(journal)、作者(authors)、DOI(doi)、页码(pages) 等 API 实际返回的字段
- SSCI/SCI/EI/影响因子列：**空**

### 错误示例 vs 正确示例

**错误（会被硬校验层自动清除）：**
```
| 姓名 | 性别 | 出生年月 | 聘任岗位 |
| 张三 | 男   | 1985-01  | 教授     |
```
**正确：**
```
| 姓名 | 性别 | 出生年月 | 聘任岗位 |
|      |      |          | 教授     |
```

**错误（项目经费编造——会被清除）：**
```
| 支出类别 | 金额（万元） |
| 实验室建设费 | 50.0 |
```
**正确（从 CV 的 RESEARCH FUNDING 章节提取真实金额）：**
```
| 支出类别 | 金额（万元） |
| 实验室建设费 | 560 (来自国家重点研发计划) |
| NSFC 海外优青 | 300 |
```

**注意**：如果 RAG 检索到了 CV 中的经费/项目信息，必须填入！即使 SQL 查询为空也不要留白。

**错误（SSCI/SCI 编造——会被清除）：**
```
| 论文名称 | SSCI、权威、核心、/SCI、EI及影响因子 |
| Paper A  | SCI, IF=3.5                        |
```
**正确：**
```
| 论文名称 | SSCI、权威、核心、/SCI、EI及影响因子 |
| Paper A  |                                      |
```

## 数据源

### 1. 学术 API（论文数据 — 全量使用！）
- `fetch_academic_data`：直接获取用户的完整论文列表
- **⚠️ 极其重要：远程 API 返回的所有论文都必须填入文档，不能只选几条！**
- Word 表格的空行数不影响你写入的论文数量——系统会自动扩展行数
- **如果返回了 45 条论文但 Word 只有 5 个空行，你仍然必须在 Markdown 中写出全部 45 条**

### 2. 知识库（个人/项目/专利数据）
- `query_knowledge_base`：执行 SQL 查询
  - **personal.db**：`academic_form_person`（个人信息）、`academic_form_projects`（项目）、`academic_form_patents`（专利）
  - **zotero.db**：`zotero_items`（论文，字段同 fetch_academic_data）

### 3. 语义检索 RAG（补充 — 非常重要！）

`hybrid_rag_retrieve` 从导入的 CV 等文档中检索内容，**用于填充非结构化的表格**：

**RAG 可以找到的信息类型**（CV 文档中通常包含）：
- 📚 教学经历：讲授的课程名称、学期、学生类型（本科/研究生）
- 👨‍🏫 研究生培养：指导的博士生/硕士生信息（如有）
- 💼 工作经历：职位、入职时间、来校时间（可用于基本简况表）
- 🔬 科研项目：项目名称、资助方、金额（可作为项目表的补充）
- 📜 专利信息：专利名称、专利号
- 🎓 荣誉奖励：获奖名称、年份
- 🏛️ 创新团队：合作者、研究组成员

**⚠️ 关键规则**：
- 每个不同的文档章节需要用**不同的查询词**去检索
- 查询词应该包含该章节表格的**表头关键词**
- RAG 返回的内容是原文片段，你需要从中提取 relevant 的信息填入表格
- 如果 RAG 没有返回相关内容，保持该表格/字段为空

## 常用 SQL（直接用，无需查 schema）

```sql
-- 查所有个人信息
SELECT * FROM academic_form_person LIMIT 1;

-- 查项目（含完整信息）
SELECT * FROM academic_form_projects ORDER BY year DESC;

-- 查专利（含完整信息）
SELECT * FROM academic_form_patents ORDER BY year DESC;

-- 查数据集
SELECT * FROM academic_form_datasets ORDER BY year DESC;

-- 查 Zotero 论文（全量查询）
SELECT title, year, journal, doi FROM zotero_items ORDER BY year DESC;
```

**注意**：`academic_form_projects` 和 `academic_form_patents` 可能为空（CV 导入时未提取到）。
如果 SQL 查询结果为 0 条，说明结构化数据不存在，这时应改用 `hybrid_rag_retrieve` 从 CV 文本中检索。

## 📝 标准输出格式（阶段二的核心产物）

### 格式 A：有表头的普通表格

每个 Word 中的有表头表格 → 一个对应的标准 Markdown 表格：

```
--- Word 表格#1: 论文成果表 ---
| 论文名称 | 发表时间 | 期刊/会议 | 作者 | SSCI/SCI/EI/影响因子 |
|---------|---------|-----------|------|---------------------|
| Paper A  | 2025    | IEEE BigData | Author1, Author2 |                     |
| Paper B  | 2024    | SIGMOD       | Author1           |                     |
```

**规则**：
- Markdown 表头 = Word 表格的实际列名（逐字对应）
- 数据行数 = 实际获取到的数据量
- 找不到数据的单元格 = 空字符串（不是"暂无"/"-"等占位词）
- 论文必须全量写入

### 格式 B：无表头的空表格（叙述性区域）

每个 Word 中的空表格（无列标题）→ 特殊格式：

```
--- Word 空表格#3: 叙述性区域 ---
| 表格标题         | 填充内容                                                                                           |
|-----------------|----------------------------------------------------------------------------------------------------|
| 教学情况        | 近三年主讲《数据库系统》（本科，64学时）、《知识图谱》（研究生，48学时）...        |
| 研究生培养情况   | 目前指导博士生2名、硕士生3名...                                                              |
| 创新团队建设情况 | 2023年组建"数据智能"创新团队，成员包括...                                                |
```

**规则**：
- "表格标题"列 = parse_docx 返回的该空表格前面段落的标题文字
- "填充内容"列 = 从 RAG/KB 提取并整理后的文本段落
- 如果某个主题确实找不到任何相关信息，可以省略该行

### 格式 C：最终校验清单（在 fill_docx 调用前自动核对）

```
=== 最终校验 ===
Word 文档共识别 X 个表格:
  ✓ [1] 有表头: [论文名称, 发表时间, 期刊] → 已准备 N 行数据
  ✓ [2] 有表头: [姓名, 性别, 出生年月] → 已准备 1 行数据
  ✗ [3] 空表格(标题:"教学情况") → 无可用数据，跳过
  ✓ [4] 空表格(标题:"科研情况") → 已准备叙述性文本
未匹配的 Word 表格: 无 (所有表格都已处理)
```

## 填表规则

1. **反幻觉第一（硬校验）**：只能填写从工具（API / KB / RAG）实际返回的数据
2. **无数据留空**：找不到的字段保持空白单元格，如 `| Paper A | 2024 |  |`
3. **论文全量填入**：`fetch_academic_data` 返回了多少条论文就写多少条，不能遗漏
4. **SSCI/SCI/EI/影响因子等特殊字段**：这些列**必须全部为空**
5. **项目金额/经费**：RAG 检索 CV 中如有真实金额就如实填写，没有才留空
6. **列名必须与文档中的表头精确匹配**
7. **阶段二完成后立刻进入阶段三调用 `fill_docx`**
8. `fill_docx` 的 `tables_markdown`：把所有表格按顺序拼接成一个 Markdown 字符串传入
"""


# ─── 构建图 ────────────────────────────────────────────────

def build_graph(
    llm: BaseChatModel,
    tools: Optional[Sequence[BaseTool]] = None,
    checkpointer=None,
) -> CompiledStateGraph:
    """
    构建 LangGraph ReAct Agent 图。

    Args:
        llm: LangChain 兼容的 LLM 实例（如 ChatOpenAI, ChatAnthropic）
        tools: 工具列表（默认使用内置的 6 个工具）
        checkpointer: 检查点保存器（默认 MemorySaver）

    Returns:
        编译后的 LangGraph 图
    """
    if tools is None:
        tools = [
            parse_docx,
            query_knowledge_base,
            get_kb_schema,
            hybrid_rag_retrieve,
            fetch_academic_data,
            fill_docx,
        ]

    if checkpointer is None:
        checkpointer = MemorySaver()

    tool_node = ToolNode(tools)
    tool_names = {t.name for t in tools}

    # LLM 绑定工具
    llm_with_tools = llm.bind_tools(tools)

    # ── Tools 包装节点（关键：在执行工具前注入 state 中的 docx_base64 和 user_context）──
    def tools_wrapper(state: AgentState) -> dict:
        """
        自定义工具执行节点。
        在调用 ToolNode 之前，将 state 中的 docx_base64 注入到需要它的工具。
        这解决了 LLM 无法正确传递超长 base64 字符串的问题。
        同时注入 user_context，防止 LLM 用假名查询学术 API。

        关键新功能：动态 user_fields 生成
        - 如果即将执行的是 fetch_academic_data，则从 parse_docx 的返回结果中提取 headers
        - 根据 headers 和 USER_FIELDS_WHITELIST 白名单动态生成 user_fields
        - 调用 set_academic_user_fields 注入，确保 API 只返回文档需要的字段
        """
        # 从 state 获取原始 docx_base64 并注入到所有需要的工具模块
        docx_base64_from_state = state.get("docx_base64", "")
        print(f"[tools_wrapper] state.docx_base64 长度: {len(docx_base64_from_state)}")
        if docx_base64_from_state:
            set_state_docx_base64(docx_base64_from_state)   # 注入 fill_docx
            set_parse_state_docx(docx_base64_from_state)      # 注入 parse_docx

        # 注入 user_context 到 fetch_academic_data（防止 LLM 用假名查 DBLP）
        user_ctx = state.get("user_context", "")
        if user_ctx:
            set_academic_state_user_context(user_ctx)

        # ── 检测即将执行的工具 ────────────────────────────────
        messages = state.get("messages", [])
        next_tool_name = None
        if messages:
            last_msg = messages[-1]
            if isinstance(last_msg, AIMessage) and last_msg.tool_calls:
                next_tool_name = last_msg.tool_calls[0].get("name")

        # ── 如果即将执行 fetch_academic_data，动态生成 user_fields ──
        if next_tool_name == "fetch_academic_data":
            dynamic_user_fields = _build_dynamic_user_fields_from_parse_result(messages)
            if dynamic_user_fields:
                set_academic_user_fields(dynamic_user_fields)
                print(f"[tools_wrapper] 动态生成 user_fields: {list(dynamic_user_fields.keys())}")
            else:
                # 没有 parse_docx 结果，使用空字典（fetch_academic 会 fallback 到默认白名单）
                set_academic_user_fields({})
                print(f"[tools_wrapper] 未找到 parse_docx 结果，user_fields 置空")

        # 注入学术 API 返回的论文总数到 fill_docx（用于截断检测）
        # 从消息历史中提取 fetch_academic_data 的返回结果
        academic_total = state.get("academic_data_len", 0) or 0
        if not academic_total:
            for msg in reversed(messages):
                if isinstance(msg, ToolMessage):
                    try:
                        content = json.loads(msg.content) if isinstance(msg.content, str) else msg.content
                        if isinstance(content, dict) and content.get("total") and content.get("papers"):
                            academic_total = content["total"]
                            break
                    except (json.JSONDecodeError, TypeError):
                        pass
        if academic_total > 0:
            set_academic_paper_total(academic_total)
            print(f"[tools_wrapper] 注入学术论文总数: {academic_total}")

        # 使用 ToolNode 执行实际的工具调用
        result = tool_node.invoke(state)

        # ── fill_docx 执行后，将返回的 docx_base64 更新到 state（支持分批填表）──
        # 关键修复：如果不更新 state，则第二次 fill_docx 调用仍使用原始 docx_base64，
        # 分批填表时会把第一次填的论文数据覆盖掉。
        tool_messages = result.get("messages", [])
        for msg in reversed(tool_messages):
            if isinstance(msg, ToolMessage) and msg.name == "fill_docx":
                try:
                    content = json.loads(msg.content) if isinstance(msg.content, str) else msg.content
                    if isinstance(content, dict) and content.get("success") and content.get("docx_base64"):
                        new_docx_base64 = content["docx_base64"]
                        result["docx_base64"] = new_docx_base64
                        # 同时更新模块级变量，让后续 fill_docx 调用也使用新文档
                        set_state_docx_base64(new_docx_base64)
                        print(f"[tools_wrapper] fill_docx 返回的新 docx_base64 已更新到 state，长度: {len(new_docx_base64)}")
                except (json.JSONDecodeError, TypeError, KeyError):
                    pass
                break  # 只处理最近的 fill_docx

        return result

    def _build_dynamic_user_fields_from_parse_result(messages: List[BaseMessage]) -> Dict[str, str]:
        """
        从 parse_docx 的返回结果中提取 headers，根据白名单动态生成 user_fields。

        逻辑：
        1. 从 messages 中找到最近的 parse_docx ToolMessage
        2. 解析其 content 中的 tables 字段（包含 headers 和 empty_columns）
        3. 收集所有 headers（包括空列的表头，因为这些是需要填的字段）
        4. 根据 USER_FIELDS_WHITELIST 白名单，筛选出能映射的字段
        5. 返回动态生成的 user_fields 字典

        Returns:
            动态生成的 user_fields 字典，如果找不到 parse_docx 结果则返回空字典
        """
        # 1. 找到最近的 parse_docx ToolMessage
        parse_result = None
        for msg in reversed(messages):
            if isinstance(msg, ToolMessage):
                # 检查是否是 parse_docx 的返回
                if hasattr(msg, "name") and msg.name == "parse_docx":
                    try:
                        content = json.loads(msg.content) if isinstance(msg.content, str) else msg.content
                        if isinstance(content, dict) and content.get("success"):
                            parse_result = content
                            break
                    except (json.JSONDecodeError, TypeError):
                        pass
                # 也可以通过 tool_call_id 或内容中的 success/tables 字段来判断
                try:
                    content = json.loads(msg.content) if isinstance(msg.content, str) else msg.content
                    if isinstance(content, dict) and content.get("success") and content.get("tables"):
                        # 检查是否包含 parse_docx 的特征字段
                        if "table_count" in content or "empty_fields" in content:
                            parse_result = content
                            break
                except (json.JSONDecodeError, TypeError):
                    pass

        if not parse_result:
            print(f"[tools_wrapper] 未找到 parse_docx 返回结果，使用空 user_fields")
            return {}

        # 2. 提取所有 headers（包括空列的表头）
        all_headers: List[str] = []
        tables = parse_result.get("tables", [])
        for table in tables:
            headers = table.get("headers", [])
            all_headers.extend(headers)

        # 同时收集 empty_fields（需要填的空字段名）
        empty_fields = parse_result.get("empty_fields", [])
        all_headers.extend(empty_fields)

        # 去重
        unique_headers = list(dict.fromkeys(h for h in all_headers if h and h.strip()))

        print(f"[tools_wrapper] 从 parse_docx 提取到 {len(unique_headers)} 个唯一表头: {unique_headers[:10]}...")

        # 3. 根据白名单筛选能映射的字段
        # 注意：USER_FIELDS_WHITELIST 的 key 是原始表头的各种变体，
        # 我们需要用 headers 去匹配这些 key
        dynamic_fields: Dict[str, str] = {}
        matched_api_fields = set()

        for header in unique_headers:
            header_lower = header.lower().strip()
            # 直接匹配
            if header in USER_FIELDS_WHITELIST:
                api_field = USER_FIELDS_WHITELIST[header]
                if api_field not in matched_api_fields:
                    dynamic_fields[header] = api_field
                    matched_api_fields.add(api_field)
                    print(f"[tools_wrapper]   精确匹配: '{header}' → {api_field}")
            else:
                # 尝试模糊匹配（遍历白名单找近似key）
                for whitelist_key, api_field in USER_FIELDS_WHITELIST.items():
                    if api_field in matched_api_fields:
                        continue
                    # 检查 header 是否包含 whitelist_key 的关键部分
                    whitelist_lower = whitelist_key.lower().strip()
                    # 简单匹配：header 包含 whitelist_key 或反之
                    if (len(header_lower) >= 3 and len(whitelist_lower) >= 3 and
                        (whitelist_lower in header_lower or header_lower in whitelist_lower)):
                        dynamic_fields[header] = api_field
                        matched_api_fields.add(api_field)
                        print(f"[tools_wrapper]   模糊匹配: '{header}' → {api_field} (via '{whitelist_key}')")
                        break

        if not dynamic_fields:
            print(f"[tools_wrapper] 没有找到可映射的字段，使用空 user_fields")
            return {}

        print(f"[tools_wrapper] 动态生成 user_fields 完成: {dynamic_fields}")
        return dynamic_fields

    # ── Agent 节点 ──
    def agent_node(state: AgentState) -> dict:
        """LLM 决策节点：分析状态，决定下一步行动"""
        messages = list(state.get("messages", []))

        # 如果消息为空，添加 system prompt + 初始任务
        if not messages:
            messages = [
                SystemMessage(content=SYSTEM_PROMPT),
                HumanMessage(content=(
                    f"请分析这份待填写的 Word 文档，自动获取相关数据并填充。\n"
                    f"用户上下文: {state.get('user_context', '无')}\n"
                    f"启用的数据源: {state.get('sources', ['kb', 'rag', 'api'])}"
                )),
            ]

        # 调用 LLM
        start_time = time.time()
        response = llm_with_tools.invoke(messages)
        duration_ms = (time.time() - start_time) * 1000

        # 记录推理轨迹
        trace = state.get("agent_trace", [])
        trace.append({
            "step": state.get("current_step", 0) + 1,
            "action": "llm_think",
            "tool": getattr(response, 'tool_calls', [{}])[0].get("name", "none") if getattr(response, 'tool_calls', None) else "none",
            "input": "",
            "output": response.content[:200] if response.content else "",
            "duration_ms": round(duration_ms, 1),
        })

        return {
            "messages": [response],
            "current_step": state.get("current_step", 0) + 1,
            "agent_trace": trace,
        }

    # ── 路由函数 ──
    def should_continue(state: AgentState) -> str:
        """判断是否继续执行工具或结束"""
        messages = state.get("messages", [])
        if not messages:
            return END

        last_message = messages[-1]

        # 检查是否超过最大步数
        current_step = state.get("current_step", 0)
        max_steps = state.get("max_steps", 10)
        if current_step >= max_steps:
            return END

        # 检查 LLM 是否要调用工具
        if isinstance(last_message, AIMessage) and last_message.tool_calls:
            return "tools"

        # 检查 fill_docx 是否已执行成功
        for msg in reversed(messages):
            if isinstance(msg, ToolMessage):
                try:
                    content = json.loads(msg.content) if isinstance(msg.content, str) else msg.content
                    if isinstance(content, dict) and content.get("success") and "docx_base64" in content:
                        return END
                except (json.JSONDecodeError, TypeError):
                    pass

        return END

    # ── 组装图 ──
    workflow = StateGraph(AgentState)

    # 添加节点
    workflow.add_node("agent", agent_node)
    workflow.add_node("tools", tools_wrapper)  # 使用包装节点而非原始 ToolNode

    # 设置入口
    workflow.set_entry_point("agent")

    # 添加边
    workflow.add_conditional_edges(
        "agent",
        should_continue,
        {
            "tools": "tools",
            END: END,
        },
    )
    workflow.add_edge("tools", "agent")  # 工具执行后返回 agent

    # 编译
    graph = workflow.compile(checkpointer=checkpointer)
    return graph


# ─── 便捷函数 ──────────────────────────────────────────────

def create_agent_graph(
    llm: BaseChatModel,
    checkpointer=None,
) -> CompiledStateGraph:
    """
    便捷函数：创建默认的 Agent 图。

    Args:
        llm: LangChain 兼容的 LLM
        checkpointer: 可选的检查点保存器

    Returns:
        编译后的 LangGraph 图
    """
    return build_graph(llm=llm, checkpointer=checkpointer)
