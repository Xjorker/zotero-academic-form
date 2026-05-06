/**
 * 学术成果 API 服务模块
 * 调用外部学术成果查询API获取论文数据
 */

// 学术成果API地址（可配置）
const ACADEMIC_API_BASE = "http://81.70.12.153:8060";

/**
 * 字段映射接口
 * key: 显示名称 (如 "论文名称")
 * value: 数据库字段路径 (如 "paper.title")
 */
export interface FieldMapping {
    [key: string]: string;
}

/**
 * 论文结果接口
 */
export interface PaperResult {
    [key: string]: any;
}

/**
 * API响应接口
 */
export interface AcademicApiResponse {
    results: PaperResult[];
    filename?: string;
    mimetype?: string;
    filedata?: string;
}

/**
 * 学术成果API服务类
 */
export class AcademicApiService {
    private baseUrl: string;

    constructor(baseUrl?: string) {
        this.baseUrl = baseUrl || ACADEMIC_API_BASE;
    }

    /**
     * 根据作者姓名和字段映射查询学术成果
     * @param authorName 作者姓名
     * @param userFields 字段映射 { "论文名称": "paper.title", "DOI": "paper.doi", ... }
     * @param onProgress 进度回调，用于报告 DBLP/CrossRef 查询状态
     * @returns 论文数据数组
     */
    async queryAuthorPapers(
        authorName: string,
        userFields: FieldMapping,
        onProgress?: (stage: string, progress: number) => void
    ): Promise<PaperResult[]> {
        try {
            // 阶段1: 查询 DBLP
            onProgress?.("正在查询 DBLP...", 10);
            Zotero.debug(`[AcademicApi] 步骤1: 查询 DBLP for ${authorName}`);

            // 阶段2: 查询 CrossRef
            onProgress?.("正在查询 CrossRef...", 20);
            Zotero.debug(`[AcademicApi] 步骤2: 查询 CrossRef for ${authorName}`);

            const url = `${this.baseUrl}/agent/run-academic-form`;

            const requestBody = {
                author_name: authorName,
                user_fields: userFields
            };

            // 阶段3: 发送请求到学术成果API
            onProgress?.("正在从 DBLP/CrossRef 获取数据...", 30);
            Zotero.debug(`[AcademicApi] 步骤3: 请求学术成果API: ${authorName}`);
            Zotero.debug(`[AcademicApi] 字段映射: ${JSON.stringify(userFields)}`);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`学术成果API错误: ${response.status} - ${errorText}`);
            }

            // 阶段4: 解析响应数据
            onProgress?.("正在解析论文数据...", 40);
            const data = await response.json();

            // API 返回的是 papers 字段，不是 results
            const papers = data.papers || data.results || [];

            // 阶段5: 完成查询
            onProgress?.(`已获取 ${papers.length} 条论文数据`, 45);
            Zotero.debug(`[AcademicApi] 步骤5: 获取到 ${papers.length} 条论文数据`);
            Zotero.debug(`[AcademicApi] API 返回原始数据: ${JSON.stringify(data).substring(0, 500)}`);

            return papers;
        } catch (error) {
            Zotero.debug(`[AcademicApi] 查询失败: ${error}`);
            throw error;
        }
    }

    /**
     * 常用字段映射（白名单）
     */
    static readonly FIELD_WHITELIST: FieldMapping = {
        "论文名称": "paper.title",
        "DOI": "paper.doi",
        "发表年份": "paper.year",
        "论文类型": "paper.type",
        "论文语言": "paper.language",
        "作者列表": "paper.authors",
        "本人在作者列表中的排序": "paper.author_order",
        "本人机构": "paper.author_affiliation",
        "全部作者机构": "paper.all_affiliations",
        "期刊/会议名称": "paper.journal.name",
        "出版商": "paper.journal.publisher",
        "ISSN（印刷）": "paper.journal.issn.print",
        "ISSN（电子）": "paper.journal.issn.electronic",
        "卷号": "paper.journal.volume",
        "期号": "paper.journal.issue",
        "页码": "paper.journal.pages",
        "是否国际合著": "paper.is_international",
        "引用次数": "paper.metrics.is_referenced_by_count",
        "参考文献数": "paper.metrics.reference_count"
    };

    /**
     * 过滤字段映射，只保留白名单中的字段
     * @param fields 用户输入的字段映射
     * @returns 过滤后的字段映射
     */
    static filterWhitelistFields(fields: FieldMapping): FieldMapping {
        const filtered: FieldMapping = {};
        
        for (const [key, value] of Object.entries(fields)) {
            if (this.FIELD_WHITELIST[key]) {
                filtered[key] = value;
            }
        }
        
        return filtered;
    }

    /**
     * 将字段映射转换为LLM可读的格式
     * @param fields 字段映射
     * @returns 格式化的字符串
     */
    static formatFieldsForLLM(fields: FieldMapping): string {
        const lines = Object.entries(fields).map(([key, value]) => `${key} → ${value}`);
        return lines.join('\n');
    }
}

/**
 * 便捷函数：查询作者论文
 */
export async function queryAuthorPapers(
    authorName: string,
    userFields: FieldMapping,
    onProgress?: (stage: string, progress: number) => void
): Promise<PaperResult[]> {
    const api = new AcademicApiService();
    return api.queryAuthorPapers(authorName, userFields, onProgress);
}
