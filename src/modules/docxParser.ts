/**
 * DOCX 文档解析服务模块
 * 将DOCX文档转换为LLM可读的文本格式
 */

import { base64Encode } from "./preferenceScript";

// 本地FastAPI服务地址
const LOCAL_API_BASE = "http://zotero-fill.local:8001";

/**
 * 解析结果接口
 */
export interface ParseResult {
    text: string;
    success: boolean;
    error?: string;
}

/**
 * DOCX解析服务类
 */
export class DocxParser {
    private baseUrl: string;

    constructor(baseUrl?: string) {
        this.baseUrl = baseUrl || LOCAL_API_BASE;
    }

    /**
     * 将DOCX文件Base64编码转换为文本（Markdown格式）
     * @param docxBase64 DOCX文件的Base64编码
     * @returns 解析后的文本内容
     */
    async parseToText(docxBase64: string): Promise<ParseResult> {
        try {
            const url = `${this.baseUrl}/docx_to_text`;
            
            Zotero.debug(`[DocxParser] 开始解析DOCX文件`);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ docx_base64: docxBase64 })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`解析服务错误: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            
            Zotero.debug(`[DocxParser] 解析成功，文本长度: ${data.text?.length || 0}`);

            return {
                text: data.text || '',
                success: true
            };
        } catch (error) {
            const err = error as Error;
            Zotero.debug(`[DocxParser] 解析失败: ${err.message}`);
            
            return {
                text: '',
                success: false,
                error: err.message
            };
        }
    }

    /**
     * 解析DOCX文件（流式版本）
     * @param docxBase64 DOCX文件的Base64编码
     * @param onProgress 进度回调
     */
    async parseToTextWithProgress(
        docxBase64: string,
        onProgress?: (progress: number) => void
    ): Promise<ParseResult> {
        try {
            onProgress?.(10);

            const url = `${this.baseUrl}/docx_to_text`;
            
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ docx_base64: docxBase64 })
            });

            onProgress?.(50);

            if (!response.ok) {
                throw new Error(`解析服务错误: ${response.status}`);
            }

            const data = await response.json();
            onProgress?.(100);

            return {
                text: data.text || '',
                success: true
            };
        } catch (error) {
            const err = error as Error;
            return {
                text: '',
                success: false,
                error: err.message
            };
        }
    }
}

/**
 * 便捷函数：解析DOCX为文本
 */
export async function parseDocxToText(docxBase64: string): Promise<ParseResult> {
    const parser = new DocxParser();
    return parser.parseToText(docxBase64);
}

/**
 * 检查本地服务是否可用
 */
export async function checkLocalService(): Promise<boolean> {
    try {
        const response = await fetch(`${LOCAL_API_BASE}/`, {
            method: 'GET',
            signal: AbortSignal.timeout(3000)
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * 获取本地服务状态信息
 */
export async function getServiceStatus(): Promise<{
    available: boolean;
    message: string;
}> {
    const available = await checkLocalService();
    
    if (available) {
        return {
            available: true,
            message: '本地服务运行中'
        };
    } else {
        return {
            available: false,
            message: '本地服务未启动，请运行 server/word_fill_app/main.py'
        };
    }
}
