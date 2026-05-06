/**
 * @deprecated Phase 3: 此模块已废弃。
 * 前端不再直接调用 LLM，所有 LLM 编排逻辑已迁移到后端 LangGraph Agent。
 * 保留此文件仅作为旧流程的参考降级方案。新流程请使用 agentClient.ts → POST /agent/fill。
 *
 * LLM 全流程处理器模块（旧版）
 * 负责：字段分析 + 学术成果API调用 + 数据筛选 + 表格匹配 + Markdown输出
 * @deprecated_use agentClient.callAgentFill() instead
 */

import { LLMService } from "./llmService";
import { AcademicApiService, FieldMapping, PaperResult } from "./academicApi";

/**
 * 处理结果接口
 */
export interface ProcessResult {
    papersMarkdown: string;      // 论文成果Markdown表格
    localMarkdown: string;       // 本地数据Markdown表格
    externalMarkdown: string;    // 外部数据源（网页）Markdown表格
    emptyTableTitles: string[];   // 只有标题没有字段的空表格标题列表
    userFields: FieldMapping;    // 使用的字段映射
    paperCount: number;          // 论文数量
}

/**
 * 筛选条件接口
 */
export interface FilterCondition {
    field: string;
    operator: string;
    value: any;
}

/**
 * LLM全流程处理器
 */
export class LLMProcessor {
    private llmService: LLMService;
    private academicApi: AcademicApiService;

    constructor() {
        this.llmService = new LLMService();
        this.academicApi = new AcademicApiService();
    }

    /**
     * 主处理流程
     * @param docText 文档文本（包含表格Markdown）
     * @param localData 本地数据（项目/专利/课题）
     * @param authorName 作者姓名
     * @param onProgress 进度回调
     * @param websiteUrl 个人主页URL（可选）
     * @param webpageContent 个人主页网页内容（可选）
     */
    async process(
        docText: string,
        localData: string,
        authorName: string,
        onProgress?: (stage: string, progress: number) => void,
        websiteUrl?: string,
        webpageContent?: string
    ): Promise<ProcessResult> {

        onProgress?.("分析文档字段需求", 10);

        // 步骤1: LLM分析文档，提取字段需求
        const { userFields, filterConditions, emptyTableTitles } = await this.analyzeDocumentFields(
            docText,
            authorName
        );

        if (!userFields || Object.keys(userFields).length === 0) {
            throw new Error("无法从文档中识别有效的论文成果字段");
        }

        Zotero.debug(`[LLMProcessor] 识别到 ${emptyTableTitles?.length || 0} 个空表格: ${emptyTableTitles?.join(', ')}`);

        // 步骤1.5: 分析数据源（本地数据、个人主页）
        let externalMarkdown = "";
        if (websiteUrl || webpageContent) {
            onProgress?.("分析外部数据源", 20);
            const externalData = await this.analyzeExternalDataSources(
                docText,
                localData,
                websiteUrl || "",
                webpageContent || "",
                userFields,
                emptyTableTitles || []
            );
            // 将外部数据源分析结果转换为 Markdown 表格
            if (externalData) {
                externalMarkdown = this.convertExternalDataToMarkdown(externalData, userFields);
            }
        }

        onProgress?.("查询学术成果数据", 30);

        // 步骤2: 调用学术成果API获取论文数据（DBLP/CrossRef查询）
        const papers = await this.academicApi.queryAuthorPapers(authorName, userFields, onProgress);

        if (!papers || papers.length === 0) {
            throw new Error(`未找到作者 "${authorName}" 的学术成果数据`);
        }

        onProgress?.("筛选和处理数据", 50);

        // 步骤3: LLM筛选和处理论文数据
        const papersMarkdown = await this.filterAndFormatPapers(
            papers,
            docText,
            userFields,
            filterConditions
        );

        onProgress?.("匹配本地数据", 70);

        // 步骤4: LLM匹配本地数据到文档表格
        const localMarkdown = await this.matchLocalData(
            docText,
            localData,
            userFields
        );

        onProgress?.("生成最终结果", 90);

        return {
            papersMarkdown,
            localMarkdown,
            externalMarkdown,
            emptyTableTitles: emptyTableTitles || [],
            userFields,
            paperCount: papers.length
        };
    }

    /**
     * 将外部数据源分析结果转换为 Markdown 表格
     * @param externalData JSON 格式的外部数据源分析结果
     * @param userFields 字段映射
     */
    private convertExternalDataToMarkdown(externalData: string, userFields: FieldMapping): string {
        try {
            // 记录完整的返回信息用于调试
            Zotero.debug(`[LLMProcessor] 外部数据源原始返回: ${externalData}`);

            // 去除 markdown code fences（如 ```json ... ```）
            let jsonStr = externalData.trim();

            // 尝试多种方式提取 JSON
            let jsonMatch = jsonStr.match(/```json\s*([\s\S]*?)```/);
            if (jsonMatch && jsonMatch[1]) {
                jsonStr = jsonMatch[1].trim();
            } else {
                // 尝试直接解析（可能是没有 code fence 的纯 JSON）
                const directMatch = jsonStr.match(/\{[\s\S]*\}/);
                if (directMatch) {
                    jsonStr = directMatch[0];
                }
            }

            Zotero.debug(`[LLMProcessor] 提取后的 JSON 字符串: ${jsonStr}`);

            const data = JSON.parse(jsonStr);
            const fieldExtractions = data.field_extractions || {};
            const emptyTableFillings = data.empty_table_fillings || {};

            // 如果两者都为空，直接返回
            if (Object.keys(fieldExtractions).length === 0 && Object.keys(emptyTableFillings).length === 0) {
                Zotero.debug(`[LLMProcessor] 外部数据中无有效字段（field_extractions 和 empty_table_fillings 都为空）`);
                return "";
            }

            // 过滤掉论文相关字段（论文信息应该从学术API获取，不从外部网页）
            const paperRelatedKeys = ['论文名称', '论文题目', '发表时间', '出版时间', '作者', '期刊', '会议', '年份'];
            const filteredFields = Object.keys(fieldExtractions).filter(
                key => !paperRelatedKeys.some(paperKey => key.includes(paperKey))
            );

            let markdown = "";

            // 1. 构建字段提取的 Markdown 表格（仅当有有效字段时）
            if (filteredFields.length > 0) {
                const headerStr = filteredFields.join(" | ");
                const valueStr = filteredFields.map(f => String(fieldExtractions[f] || "")).join(" | ");
                markdown += `\n| ${headerStr} |\n| ${filteredFields.map(() => "---").join(" | ")} |\n| ${valueStr} |`;
            }

            // 2. 处理空表格填充 - 转换为标准 Markdown 表格格式
            // 空表格没有预设表头，用 "表格标题" 和 "填充内容" 作为通用表头
            const emptyTableKeys = Object.keys(emptyTableFillings);
            if (emptyTableKeys.length > 0) {
                markdown += "\n\n| 表格标题 | 填充内容 |\n| --- | --- |\n";
                for (const [tableTitle, content] of Object.entries(emptyTableFillings)) {
                    // 转义表格内容中的 | 字符，防止破坏表格格式
                    const escapedContent = String(content).replace(/\|/g, '\\|');
                    markdown += `| ${tableTitle} | ${escapedContent} |\n`;
                }
            }

            Zotero.debug(`[LLMProcessor] 外部数据转换后的 Markdown: ${markdown}`);
            return markdown;
        } catch (e) {
            Zotero.debug(`[LLMProcessor] 解析外部数据失败: ${e}`);
            return "";
        }
    }

    /**
     * 分析文档字段需求
     * 对应原Dify Agent节点
     */
    private async analyzeDocumentFields(
        docText: string,
        authorName: string
    ): Promise<{ userFields: FieldMapping, filterConditions: FilterCondition[], emptyTableTitles: string[] }> {

        const systemPrompt = this.getFieldAnalysisSystemPrompt();
        const userPrompt = this.getFieldAnalysisUserPrompt(docText, authorName);

        const response = await this.llmService.chat(userPrompt, systemPrompt);

        try {
            // 尝试解析LLM返回的JSON
            const result = JSON.parse(response.content);

            return {
                userFields: result.user_fields || {},
                filterConditions: result.filter_conditions || [],
                emptyTableTitles: result.empty_table_titles || []
            };
        } catch (e) {
            // 如果解析失败，尝试提取JSON部分
            const jsonMatch = response.content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const result = JSON.parse(jsonMatch[0]);
                    return {
                        userFields: result.user_fields || {},
                        filterConditions: result.filter_conditions || [],
                        emptyTableTitles: result.empty_table_titles || []
                    };
                } catch {
                    // 继续使用默认字段
                }
            }

            // 返回默认字段映射
            return {
                userFields: {
                    "论文名称": "paper.title",
                    "DOI": "paper.doi",
                    "发表年份": "paper.year",
                    "本人在作者列表中的排序": "paper.author_order"
                },
                filterConditions: [],
                emptyTableTitles: []
            };
        }
    }

    /**
     * 分析外部数据源（个人主页网页内容）
     * 提取可用于填充的信息
     * 返回提取到的字段值 JSON 字符串
     */
    private async analyzeExternalDataSources(
        docText: string,
        localData: string,
        websiteUrl: string,
        webpageContent: string,
        userFields: FieldMapping,
        emptyTableTitles: string[]
    ): Promise<string> {
        if (!webpageContent) {
            return "";
        }

        Zotero.debug(`[LLMProcessor] 分析个人主页数据，URL: ${websiteUrl}`);
        Zotero.debug(`[LLMProcessor] 网页内容长度: ${webpageContent.length} 字符`);

        // 调用LLM分析网页内容，提取与用户字段相关的信息
        const systemPrompt = this.getExternalDataAnalysisSystemPrompt();
        const userPrompt = this.getExternalDataAnalysisUserPrompt(
            docText,
            localData,
            websiteUrl,
            webpageContent,
            userFields,
            emptyTableTitles
        );

        try {
            const response = await this.llmService.chat(userPrompt, systemPrompt);
            Zotero.debug(`[LLMProcessor] 外部数据源分析完成: ${response.content.substring(0, 200)}...`);
            return response.content;
        } catch (e) {
            Zotero.debug(`[LLMProcessor] 外部数据源分析失败: ${e}`);
            // 不抛出错误，继续流程
            return "";
        }
    }

    /**
     * 筛选和格式化论文数据
     * 对应原Dify LLM节点
     */
    private async filterAndFormatPapers(
        papers: PaperResult[],
        docText: string,
        userFields: FieldMapping,
        filterConditions: FilterCondition[]
    ): Promise<string> {

        const systemPrompt = this.getFilterSystemPrompt();
        const userPrompt = this.getFilterUserPrompt(papers, docText, userFields, filterConditions);

        const response = await this.llmService.chat(userPrompt, systemPrompt);

        // 提取Markdown表格
        return this.extractMarkdownTable(response.content);
    }

    /**
     * 匹配本地数据到文档表格
     * 对应原Dify LLM 2节点
     */
    private async matchLocalData(
        docText: string,
        localData: string,
        userFields: FieldMapping
    ): Promise<string> {

        const systemPrompt = this.getLocalMatchSystemPrompt();
        const userPrompt = this.getLocalMatchUserPrompt(docText, localData);

        const response = await this.llmService.chat(userPrompt, systemPrompt);

        // 返回所有可填充的表格
        return this.extractAllMarkdownTables(response.content);
    }

    // ========== 系统提示词 ==========

    private getFieldAnalysisSystemPrompt(): string {
        return `🎯 角色（Role）
你是：学术论文成果字段解析器（Academic Field Extractor）

🎯 唯一目标（Objective）
从文档内容中，提取论文成果表格的字段需求；
严格匹配白名单生成 JSON 对象 user_fields；
文档中可能存在不在白名单的字段，但只保留白名单字段用于 user_fields。

⚠️ 核心约束（最高优先级）
字段只能来自文档中白名单字段；
❌ 不允许使用默认字段、补充未出现的字段、推测或联想字段；
生成字段后：❌ 不得修改、增删、翻译或排序。

🔍 字段提取规则
情况一：用户直接描述字段 → 逐一提取并映射；
情况二：用户上传文档 → 扫描所有表格，仅关注表格第一行（列名）/第一列（字段名），识别"论文成果字段模板"（任一强匹配信号：列名含"论文/文章/成果/期刊/会议/DOI/作者/年份/ISSN/出版商"，或 ≥2 个列名可映射为论文成果字段）；
❌ 排除非论文成果表格（项目经费/财务/作者基本信息/时间计划/评审意见/已填数据的表格）。

🛡️ 允许的字段映射（严格白名单）
📄 基础论文信息
论文名称 → paper.title
DOI → paper.doi
发表年份 → paper.year
论文类型 → paper.type
论文语言 → paper.language

👤 作者相关
作者列表 → paper.authors
本人在作者列表中的排序 → paper.author_order
本人机构 → paper.author_affiliation
全部作者机构 → paper.all_affiliations

📘 期刊/会议
期刊/会议名称 → paper.journal.name
出版商 → paper.journal.publisher
ISSN（印刷） → paper.journal.issn.print
ISSN（电子） → paper.journal.issn.electronic
卷号 → paper.journal.volume
期号 → paper.journal.issue
页码 → paper.journal.pages

🌍 合作与指标
是否国际合著 → paper.is_international
引用次数 → paper.metrics.is_referenced_by_count
参考文献数 → paper.metrics.reference_count

⚡ 强制输出规则（最高优先级）
输出结构：仅返回包含 user_fields 的纯 JSON 对象。
失败判定（任一条件满足即失败）：
无法识别有效论文成果字段；
无论文成果模板表格；
→ 失败时仅返回空 JSON 结构：{"user_fields": {}, "filter_conditions": [], "empty_table_titles": []}。

📋 空表格识别规则
除了论文成果表格外，还需要识别文档中其他需要填充的空表格（如"研究生培养情况"、"组建创新团队"等）。
这些表格通常：
- 有明确的标题（如"研究生培养情况"）
- 表格内没有明确的列名字段
- 但仍需要根据标题判断需要填充的内容

如果在文档中发现这样的空表格，在返回的 JSON 中添加 "empty_table_titles" 字段，格式：
"empty_table_titles": ["表格标题1", "表格标题2", ...]

如果文档中没有空表格，返回空数组：[]

JSON 格式要求：
符合 RFC 8259 标准，键名双引号、无末尾逗号；`;
    }

    private getFieldAnalysisUserPrompt(docText: string, authorName: string): string {
        return `需要填表的作者：${authorName}

文档内容（包含表格）：
${docText}

请分析文档，提取需要的论文成果字段，并返回JSON格式：
{
  "user_fields": {
    "显示字段名": "数据库字段路径",
    ...
  },
  "filter_conditions": [
    {"field": "字段名", "op": "运算符", "value": "值"}
  ],
  "empty_table_titles": ["空表格标题1", "空表格标题2", ...]
}`;
    }

    private getFilterSystemPrompt(): string {
        return `🎯 角色（Role）
你是：学术论文成果筛选器（Academic Paper Data Filter）

🎯 唯一目标（Objective）
根据筛选条件过滤论文数据；
将复杂数据转换为可读的Markdown表格格式；
严格保持字段顺序。

⚠️ 约束条件
筛选条件仅基于文档内容，不允许推测或添加额外条件；
输出列顺序严格按照字段映射顺序；
任何复杂数据必须转换为可读文本：
作者列表 → 用"姓, 名; 姓, 名"形式表示
本人在作者列表中的排序 → 数字或"第一作者"等
机构列表 → 用逗号分隔

⚡ 筛选规则
等于/是：=、是
大于/小于：>、>=、<、<=
包含/不包含
范围：如 2020-2023

✅ 输出格式
纯Markdown表格，无任何解释文字、注释或多余空格`;
    }

    private getFilterUserPrompt(
        papers: PaperResult[],
        docText: string,
        userFields: FieldMapping,
        filterConditions: FilterCondition[]
    ): string {
        const papersJson = JSON.stringify(papers, null, 2);
        const fieldsOrder = Object.keys(userFields).join(", ");

        return `文档中识别的筛选条件：${JSON.stringify(filterConditions)}

用户需要的字段（按顺序）：${fieldsOrder}

学术成果API返回的原始数据（共 ${papers.length} 篇）：
${papersJson}

请：
1. 根据筛选条件过滤数据
2. 将数据转换为Markdown表格格式
3. 字段顺序严格按照上述顺序
4. 复杂数据转换为可读文本

只输出Markdown表格，不要输出任何其他内容。`;
    }

    private getLocalMatchSystemPrompt(): string {
        return `🎯 角色（Role）
你是：文档表格智能匹配助手

🎯 唯一目标
分析待填充文档中的表格，匹配本地数据（项目/专利/课题）到可填充的表格。

⚠️ 核心规则
1. 解析文档，提取所有需要填写的表格
2. 分析本地数据，找出可以填充到文档表格的字段
3. 只输出有匹配字段的表格，无匹配则不输出
4. 每个表格独立输出，表格之间用空行分隔

📋 表格匹配规则
表格字段与本地数据字段精准匹配或语义模糊匹配
（如"作者"与"第一作者"，"项目名称"与"课题名称"）

✅ 输出格式
多个独立的Markdown表格，表格之间用空行分隔
无任何解释文字、标题或注释`;
    }

    private getLocalMatchUserPrompt(docText: string, localData: string): string {
        return `待填充文档内容：
${docText}

本地数据（项目/专利/课题）：
${localData}

请分析文档中的表格，匹配本地数据，只输出可填充的Markdown表格。`;
    }

    private getExternalDataAnalysisSystemPrompt(): string {
        return `🎯 角色（Role）
你是：外部数据源分析助手

🎯 唯一目标
根据待填充文档中已识别的表格字段需求，从个人主页网页内容中提取可用的填充信息。

📋 任务背景
用户已经在文档中识别出了需要填充的表格字段（user_fields），这些字段代表了表格中每一列的含义。
你的任务是根据这些已知的字段需求，去个人主页网页中寻找和提取匹配的信息。

⚠️ 核心规则
1. 先理解用户需要的字段是什么（见用户提示中的 user_fields）
2. 根据每个字段的需求，在网页内容中寻找对应信息
3. 优先提取与字段名语义匹配的内容
4. 对于论文类字段，全部忽略！！！
5. 对于项目/专利类字段，尝试提取：名称、编号、时间、角色等
6. 个人信息（职位、机构、邮箱）作为补充信息提取

📋 输出格式
返回JSON格式的分析结果：
{
  "field_extractions": {
    "字段名1": "从网页提取的值1",
    "字段名2": "从网页提取的值2"
  },
  "empty_table_fillings": {
    "表格标题1": "填充内容1",
    "表格标题2": "填充内容2"
  },
  "additional_info": {
    "发现的其他有用信息": "值"
  },
  "confidence": "high/medium/low"  // 提取信息的置信度
}

如果没有提取到有用信息，返回：
{"field_extractions": {}, "empty_table_fillings": {}, "additional_info": {}, "confidence": "low"}

只返回JSON，不要有其他解释文字。`;
    }

    private getExternalDataAnalysisUserPrompt(
        docText: string,
        localData: string,
        websiteUrl: string,
        webpageContent: string,
        userFields: FieldMapping,
        emptyTableTitles: string[]
    ): string {
        // 过滤掉论文相关字段（论文信息从学术API获取，不从网页提取）
        const paperRelatedKeys = ['论文名称', '论文题目', '发表时间', '出版时间', '作者', '期刊', '会议', '年份', '页码', '期号', '出版或发表时间'];
        const filteredFields = Object.entries(userFields).filter(
            ([displayName]) => !paperRelatedKeys.some(key => displayName.includes(key))
        );

        const fieldsList = filteredFields
            .map(([displayName, fieldPath]) => `- ${displayName}: 对应数据路径 ${fieldPath}`)
            .join("\n");

        const emptyTablesSection = emptyTableTitles && emptyTableTitles.length > 0
            ? `\n## 需要填充的空表格（只有标题，没有字段）

${emptyTableTitles.map(t => `- ${t}`).join('\n')}

这些表格需要根据标题判断应该填写什么内容，并从网页中提取相关信息填充。`
            : "";

        return `## 待填充文档中已识别的表格字段（user_fields）

${fieldsList}
${emptyTablesSection}

## 文档内容摘要
${docText.substring(0, 3000)}

## 本地数据（项目/专利/课题）
${localData || "（无）"}

## 个人主页信息
URL：${websiteUrl}

## 个人主页网页内容
${webpageContent.substring(0, 20000)}

请根据上述"表格字段"需求和"空表格"标题，分析网页内容：
1. 提取每个字段对应的值
2. 尝试为每个空表格从网页中提取相关内容填充

返回JSON格式：
{
  "field_extractions": {
    "字段名1": "从网页提取的值1",
    "字段名2": "从网页提取的值2"
  },
  "empty_table_fillings": {
    "表格标题1": "填充内容1",
    "表格标题2": "填充内容2"
  }
}`;
    }

    // ========== 工具方法 ==========

    /**
     * 提取单个Markdown表格
     */
    private extractMarkdownTable(text: string): string {
        const tables = this.extractAllMarkdownTables(text);
        // 返回第一个表格
        const tableArray = tables.split('\n\n').filter(t => t.trim());
        return tableArray[0] || '';
    }

    /**
     * 提取所有Markdown表格
     */
    private extractAllMarkdownTables(text: string): string {
        // 清理文本
        let cleaned = text.trim();

        // 移除可能的代码块标记
        cleaned = cleaned.replace(/^```markdown\n?/g, '');
        cleaned = cleaned.replace(/\n?```$/g, '');

        // 移除JSON标记
        const jsonStart = cleaned.indexOf('{');
        const jsonEnd = cleaned.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
            cleaned = cleaned.substring(0, jsonStart) + cleaned.substring(jsonEnd + 1);
        }

        // 移除解释性文字，保留表格
        const lines = cleaned.split('\n');
        const tableLines: string[] = [];
        let inTable = false;

        for (const line of lines) {
            if (line.includes('|') && line.trim().startsWith('|')) {
                inTable = true;
                tableLines.push(line);
            } else if (inTable && line.trim() === '') {
                // 空行，继续收集
                continue;
            } else if (inTable && !line.includes('|')) {
                // 遇到非表格内容，可能需要分隔
                if (tableLines.length > 0) {
                    tableLines.push(''); // 添加分隔
                }
                inTable = false;
            }
        }

        return tableLines.join('\n').trim();
    }
}

/**
 * 便捷函数：创建LLM处理器
 */
export function createLLMProcessor(): LLMProcessor {
    return new LLMProcessor();
}
