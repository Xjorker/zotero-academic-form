/**
 * Knowledge Base Manager - 知识库初始化和管理
 *
 * 职责：
 * 1. 知识库初始化 UI（上传文件、填写个人主页URL）
 * 2. 调用后端 /kb/import 端点
 * 3. 管理本地Schema信息
 */

import { getPref } from "../utils/prefs";
import { base64Encode } from "./preferenceScript";

export interface KbImportRequest {
    files?: Array<{
        name: string;
        base64: string;
    }>;
    urls?: string[];
    user_id?: string;
}

export interface KbImportResponse {
    success: boolean;
    imported_fields?: number;
    doc_chunks?: number;
    schema?: any;
    error?: string;
}

export interface KbSchema {
    tables: Array<{
        name: string;
        columns: Array<{
            name: string;
            type: string;
            description: string;
        }>;
        description: string;
    }>;
}

const DEFAULT_SERVER_URL = "http://zotero-fill.local:8001";

function getServerUrl(): string {
    const pref = getPref("serverUrl") as string;
    return pref || DEFAULT_SERVER_URL;
}

export async function importToKnowledgeBase(
    file: nsIFile,
    websiteUrl?: string,
    userId?: string
): Promise<KbImportResponse> {
    const serverUrl = getServerUrl();
    const endpoint = `${serverUrl}/kb/import`;

    try {
        const fileContent = await readFileAsBase64(file);
        const fileName = file.leafName || "document";

        const request: KbImportRequest = {
            files: [
                {
                    name: fileName,
                    base64: fileContent
                }
            ],
            urls: websiteUrl ? [websiteUrl] : [],
            user_id: userId || "default"
        };

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            return {
                success: false,
                error: `HTTP ${response.status}: ${await response.text()}`
            };
        }

        return await response.json();
    } catch (e) {
        return {
            success: false,
            error: `导入失败: ${String(e)}`
        };
    }
}

async function readFileAsBase64(file: nsIFile): Promise<string> {
    return new Promise((resolve, reject) => {
        try {
            const fileStream = Components.classes["@mozilla.org/network/file-input-stream;1"]
                .createInstance(Components.interfaces.nsIFileInputStream);
            fileStream.init(file, 0x01, 0, null);

            const binaryStream = Components.classes["@mozilla.org/binaryinputstream;1"]
                .createInstance(Components.interfaces.nsIBinaryInputStream);
            binaryStream.setInputStream(fileStream);

            const available = binaryStream.available();
            const bytes = binaryStream.readBytes(available);

            const uint8Array = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) {
                uint8Array[i] = bytes.charCodeAt(i);
            }

            binaryStream.close();
            fileStream.close();

            let binary = '';
            const len = uint8Array.byteLength;
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(uint8Array[i]);
            }

            resolve(btoa(binary));
        } catch (e) {
            reject(e);
        }
    });
}

export async function fetchWebsiteContent(url: string): Promise<string> {
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'ZoteroPlugin/1.0' }
        });
        const html = await resp.text();

        let text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        return text.substring(0, 50000);
    } catch (e) {
        ztoolkit.log(`[KbManager] 网页抓取失败: ${e}`);
        return "";
    }
}

export function getLocalSchemaInfo(): KbSchema {
    return {
        tables: [
            {
                name: "academic_form_person",
                description: "作者个人信息",
                columns: [
                    { name: "name", type: "TEXT", description: "姓名" },
                    { name: "orcid", type: "TEXT", description: "ORCID" },
                    { name: "affiliation", type: "TEXT", description: "机构" },
                    { name: "country", type: "TEXT", description: "国家" },
                    { name: "keywords", type: "TEXT", description: "关键词" },
                    { name: "biography", type: "TEXT", description: "简介" },
                    { name: "website", type: "TEXT", description: "网站" }
                ]
            },
            {
                name: "academic_form_projects",
                description: "科研项目",
                columns: [
                    { name: "title", type: "TEXT", description: "项目名称" },
                    { name: "year", type: "TEXT", description: "年份" },
                    { name: "funder", type: "TEXT", description: "资助机构" },
                    { name: "grantId", type: "TEXT", description: "项目编号" },
                    { name: "url", type: "TEXT", description: "链接" }
                ]
            },
            {
                name: "academic_form_patents",
                description: "专利",
                columns: [
                    { name: "title", type: "TEXT", description: "专利名称" },
                    { name: "year", type: "TEXT", description: "年份" },
                    { name: "office", type: "TEXT", description: "专利局" },
                    { name: "number", type: "TEXT", description: "专利号" }
                ]
            },
            {
                name: "academic_form_datasets",
                description: "数据集",
                columns: [
                    { name: "title", type: "TEXT", description: "数据集名称" },
                    { name: "year", type: "TEXT", description: "年份" },
                    { name: "repo", type: "TEXT", description: "仓储" },
                    { name: "doi", type: "TEXT", description: "DOI" }
                ]
            }
        ]
    };
}

export function log(message: string, ...args: any[]) {
    ztoolkit.log(`[KbManager] ${message}`, ...args);
}
