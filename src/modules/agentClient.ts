/**
 * Agent Client - 调用后端 Agent 智能填表服务
 *
 * 职责：前端插件调用后端 Agent API
 * Phase 3: 已接入 academicForm.ts
 */

import { getPref } from "../utils/prefs";
import { getLLMConfig } from "./llmService";

export interface AgentConfig {
    max_steps?: number;
    sources?: ("kb" | "rag" | "api")[];
    session_id?: string;
}

export interface AgentFillRequest {
    docx_base64: string;
    session_id?: string;
    config?: AgentConfig;
    user_context?: string;
}

export interface AgentFillResponse {
    success: boolean;
    docx_base64?: string;
    download_url?: string;  // 后端临时文件下载链接（5分钟有效期）
    agent_trace?: Array<{
        step: number;
        action: string;
        result: string;
    }>;
    empty_fields?: string[];
    generated_sql?: string;
    error?: string;
    coverage?: number;
    elapsed_seconds?: number;
    steps?: number;
    session_id?: string;
    mapping_summary?: string;  // 三段式流程：Word↔Markdown 映射关系摘要
    word_headers_summary?: Array<{  // 三段式流程：原文档所有待填表格清单
        index: number;
        type: "headered" | "empty";
        headers: string[];
        title: string;
    }>;
}

export interface SchemaResponse {
    success: boolean;
    schema?: string;
    error?: string;
}

export interface SqlValidationRequest {
    sql: string;
}

export interface SqlValidationResponse {
    success: boolean;
    valid: boolean;
    error?: string;
}

const DEFAULT_SERVER_URL = "http://zotero-fill.local:8001";

export function getServerUrl(): string {
    const pref = getPref("serverUrl" as any) as string;
    return pref || DEFAULT_SERVER_URL;
}

/**
 * 调用后端 Agent 智能填表 API
 * 
 * 自动从偏好设置读取 LLM 配置，传递给后端 Agent
 */
export async function callAgentFill(request: AgentFillRequest): Promise<AgentFillResponse> {
    const serverUrl = getServerUrl();
    const endpoint = `${serverUrl}/agent/fill`;

    // 自动读取 LLM 配置（从 Zotero 偏好设置）
    const llmConfig = getLLMConfig();

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            docx_base64: request.docx_base64,
            session_id: request.session_id || "default",
            user_context: request.user_context || "",
            config: request.config || {
                max_steps: 20,
                sources: ["kb", "rag", "api"],
            },
            llm_config: {
                model: llmConfig.model || "deepseek-chat",
                api_key: llmConfig.apiKey || "",
                base_url: llmConfig.baseUrl || "",
                temperature: 0.1,
            },
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        return {
            success: false,
            error: `HTTP ${response.status}: ${errorText}`,
        };
    }

    try {
        const result = await response.json();
        return result as unknown as AgentFillResponse;
    } catch (e) {
        return {
            success: false,
            error: `解析响应失败: ${String(e)}`,
        };
    }
}

export async function getKnowledgeSchema(): Promise<SchemaResponse> {
    const serverUrl = getServerUrl();
    const endpoint = `${serverUrl}/agent/schema`;

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            return {
                success: false,
                error: `HTTP ${response.status}`,
            };
        }

        return await response.json() as unknown as SchemaResponse;
    } catch (e) {
        return {
            success: false,
            error: `连接失败: ${String(e)}`,
        };
    }
}

export async function validateSql(sql: string): Promise<SqlValidationResponse> {
    const serverUrl = getServerUrl();
    const endpoint = `${serverUrl}/agent/sql/validate`;

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ sql }),
        });

        if (!response.ok) {
            return {
                success: false,
                valid: false,
                error: `HTTP ${response.status}`,
            };
        }

        return await response.json() as unknown as SqlValidationResponse;
    } catch (e) {
        return {
            success: false,
            valid: false,
            error: `连接失败: ${String(e)}`,
        };
    }
}

export async function getAgentMemory(sessionId: string): Promise<any> {
    const serverUrl = getServerUrl();
    const endpoint = `${serverUrl}/agent/memory/${encodeURIComponent(sessionId)}`;

    try {
        const response = await fetch(endpoint, {
            method: "GET",
        });

        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }

        return await response.json();
    } catch (e) {
        return { success: false, error: `连接失败: ${String(e)}` };
    }
}

export async function clearAgentMemory(sessionId: string): Promise<any> {
    const serverUrl = getServerUrl();
    const endpoint = `${serverUrl}/agent/memory/${encodeURIComponent(sessionId)}`;

    try {
        const response = await fetch(endpoint, {
            method: "DELETE",
        });

        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }

        return await response.json();
    } catch (e) {
        return { success: false, error: `连接失败: ${String(e)}` };
    }
}

export function createAgentSessionId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    return `session_${timestamp}_${random}`;
}
