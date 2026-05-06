// ==============================================
// Word 文档处理辅助函数 (Word ↔ XML 转换)
// 用于将papers_markdown数据填充到原Word文档
// ==============================================

/**
 * 将ArrayBuffer转换为Base64字符串
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * 将Base64字符串转换为ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * 解析markdown表格数据
 * 将markdown表格转换为数组格式
 */
export function parseMarkdownTable(markdown: string): { headers: string[], rows: string[][] } {
    const lines = markdown.trim().split('\n');
    if (lines.length < 2) {
        return { headers: [], rows: [] };
    }

    const headers: string[] = [];
    const rows: string[][] = [];

    let isHeader = true;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('|')) continue;

        // 跳过分隔符行
        if (trimmed.match(/^\|[\s\-:|]+\|$/)) {
            isHeader = false;
            continue;
        }

        // 解析单元格
        const cells = trimmed.split('|')
            .map(cell => cell.trim())
            .filter(cell => cell !== '');

        if (isHeader) {
            headers.push(...cells);
        } else if (cells.length > 0) {
            rows.push(cells);
        }
    }

    return { headers, rows };
}

/**
 * 处理papers_markdown并填充到Word文档
 * 调用本地FastAPI服务器完成Word↔XML转换
 * 
 * @param docxBase64 原docx文件的base64编码
 * @param papersMarkdown Dify返回的markdown表格数据
 * @returns 填充后的docx文件base64编码
 */
// 填表结果类型
export interface FillResult {
    success: boolean;
    download_url?: string;
    filename?: string;
    error?: string;
}

export async function fillWordDocument(docxBase64: string, papersMarkdown: string): Promise<FillResult> {
    Zotero.debug("[AcademicForm] 开始处理Word文档填充...");

    if (!docxBase64) {
        Zotero.debug("[AcademicForm] ⚠️ 无原文档，直接返回markdown数据");
        return { success: false, error: "无原文档" };
    }

    if (!papersMarkdown) {
        Zotero.debug("[AcademicForm] ⚠️ 无papers_markdown数据");
        return { success: false, error: "无papers_markdown数据" };
    }

    // 本地FastAPI服务器地址
    const FILL_API_URL = "http://zotero-fill.local:8001/fill_base64";

    try {
        Zotero.debug("[AcademicForm] 开始处理Word文档填充...");
        
        // 📝 调试信息 - 验证 base64 的有效性
        Zotero.debug(`[AcademicForm] docxBase64 长度: ${docxBase64.length}`);
        Zotero.debug(`[AcademicForm] papersMarkdown 长度: ${papersMarkdown.length}`);
        
        // 验证 base64 格式
        if (!docxBase64.match(/^[A-Za-z0-9+/=]+$/)) {
            Zotero.debug(`[AcademicForm] ⚠️ 警告：docxBase64 包含非法字符！`);
        }
        
        // 验证 base64 头部（应该是 PK for DOCX）
        try {
            const testDecode = atob(docxBase64.substring(0, 100));
            const firstBytes = testDecode.substring(0, 4);
            const hex = Array.from(firstBytes)
                .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
                .join('');
            Zotero.debug(`[AcademicForm] base64 解码头部（前4字节）: ${hex}`);
            if (hex !== '504b0304') {
                Zotero.debug(`[AcademicForm] ⚠️ 警告：不是有效的 ZIP 文件头！应该是 504b0304，但得到 ${hex}`);
            }
        } catch (e) {
            Zotero.debug(`[AcademicForm] ⚠️ base64 头部验证失败: ${e}`);
        }
        
        Zotero.debug(`[AcademicForm] papersMarkdown 前200字: ${papersMarkdown.substring(0, 200)}`);

        // 使用 JSON body 替代 FormData（Zotero 环境没有 FormData）
        const requestBody = {
            docx_base64: docxBase64,
            papers_markdown: papersMarkdown
        };
        
        const jsonBody = JSON.stringify(requestBody);
        Zotero.debug(`[AcademicForm] JSON 请求体长度: ${jsonBody.length}`);

        // 调用本地服务器
        const response = await fetch(FILL_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: jsonBody
        });

        if (!response.ok) {
            throw new Error(`服务器处理失败: ${response.status}`);
        }

        const result = await response.json();
        
        Zotero.debug(`[AcademicForm] 服务器响应 - success: ${result.success}, download_url: ${result.download_url || "无"}`);

        if (result.success && result.download_url) {
            Zotero.debug("[AcademicForm] ✅ Word文档填充成功！");
            return {
                success: true,
                download_url: result.download_url,
                filename: result.filename || "filled_document.docx"
            };
        } else {
            Zotero.debug("[AcademicForm] ❌ 服务器处理失败: " + result.error);
            Zotero.debug("[AcademicForm] 错误堆栈: " + (result.trace || "无"));
            return { success: false, error: result.error || "未知错误" };
        }

    } catch (error) {
        const err = error as Error;
        Zotero.debug("[AcademicForm] ❌ 调用本地填表服务失败: " + err.message);
        Zotero.debug("[AcademicForm] 请确保服务器已启动");
        return { success: false, error: err.message };
    }
}

/**
 * 保存处理后的文档到指定目录
 */
export async function saveFilledDocument(
    docxBase64: string,
    sourceFileName: string,
    targetDir: string
): Promise<string> {
    const arrayBuffer = base64ToArrayBuffer(docxBase64);
    const uint8Array = new Uint8Array(arrayBuffer);

    // 生成新文件名
    const baseName = sourceFileName.replace(/\.docx$/i, '');
    const newFileName = `${baseName}_填表完成.docx`;
    const targetPath = targetDir + '/' + newFileName;

    const targetFile = Components.classes["@mozilla.org/file/local;1"]
        .createInstance(Components.interfaces.nsILocalFile);
    targetFile.initWithPath(targetPath);

    // 写入文件
    const fileStream = Components.classes["@mozilla.org/network/file-output-stream;1"]
        .createInstance(Components.interfaces.nsIFileOutputStream);
    fileStream.init(targetFile, 0x04 | 0x08 | 0x10, 0, 0);

    try {
        const chunkSize = 4096;
        let offset = 0;
        while (offset < uint8Array.length) {
            const chunk = uint8Array.subarray(offset, offset + chunkSize);
            fileStream.write(chunk, chunk.length);
            offset += chunkSize;
        }
        fileStream.flush();
        Zotero.debug(`[AcademicForm] 文件保存成功: ${targetPath}`);
    } finally {
        fileStream.close();
    }

    return targetPath;
}
