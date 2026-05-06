/**
 * LLM 服务模块
 * 支持 DeepSeek、OpenAI、Google Gemini、Claude 四种大模型
 */

import { getPref, setPref } from "../utils/prefs";
import { config } from "../../package.json";
import { createSandboxEval } from "../utils/ztoolkit";

const PREFS_PREFIX = config.prefsPrefix;

// 日志输出到 Zotero 控制台
function llmLog(...args: any[]) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    ztoolkit.log(`[LLM] ${msg}`);
}

/**
 * 标准化 baseUrl：
 * - 若已包含 /v1，返回原值
 * - 若末尾是 /chat/completions 或其他完整端点，返回原值
 * - 否则尝试拼接 /v1（默认 OpenAI 兼容格式）
 * 
 * 对于 codeflow.asia 等代理服务，根据模型名添加分组路径：
 * - claude-* 模型 → /ccpro/v1
 * - gemini-* 模型 → /gemini/v1
 */
function normalizeBaseUrl(baseUrl: string, model?: string): string {
    const url = baseUrl.trim().replace(/\/$/, ''); // 移除末尾 /
    if (url.includes('/v1') || url.endsWith('/chat/completions') || url.endsWith('/models')) {
        return url;
    }
    
    // 检测是否是 codeflow.asia 或类似的代理服务（非官方 API）
    const isProxyService = !url.includes('api.openai.com') && 
                          !url.includes('api.anthropic.com') && 
                          !url.includes('generativelanguage.googleapis.com') &&
                          !url.includes('api.deepseek.com');
    
    if (isProxyService && model) {
        // 根据模型名确定分组
        if (model.startsWith('claude-')) {
            // Claude 模型默认使用 ato 分组（可用分组：ato, awsb, awsq, ccmax, ccpro, daudeau）
            return `${url}/ato/v1`;
        } else if (model.startsWith('gemini-')) {
            // Gemini 模型使用 gemini 分组
            return `${url}/gemini/v1`;
        }
    }
    
    return `${url}/v1`;
}

/**
 * LLM 类型
 * openai-compatible: 支持任意 OpenAI 兼容的第三方服务（硅基流动、codeflow.asia 等）
 */
export type LLMProvider = 'deepseek' | 'openai' | 'google' | 'claude' | 'openai-compatible';

/**
 * LLM 配置接口
 */
export interface LLMConfig {
    provider: LLMProvider;
    apiKey: string;
    baseUrl?: string;
    model: string;
}

/**
 * LLM 响应接口
 */
export interface LLMResponse {
    content: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

/**
 * 获取当前LLM配置
 */
export function getLLMConfig(): LLMConfig {
    const provider = getPref("llmProvider" as any) as LLMProvider || 'deepseek';
    const apiKey = getPref("llmApiKey" as any) as string || '';
    const baseUrl = getPref("llmBaseUrl" as any) as string || '';
    const model = getPref("llmModel" as any) as string || '';

    return { provider, apiKey, baseUrl, model };
}

/**
 * 保存LLM配置
 */
export function saveLLMConfig(config: LLMConfig): void {
    setPref("llmProvider" as any, config.provider);
    setPref("llmApiKey" as any, config.apiKey);
    setPref("llmBaseUrl" as any, config.baseUrl || '');
    setPref("llmModel" as any, config.model);
}

/**
 * 获取默认模型
 */
export function getDefaultModel(provider: LLMProvider): string {
    const models: Record<LLMProvider, string> = {
        deepseek: 'deepseek-chat',
        openai: 'gpt-4o',
        google: 'gemini-2.0-flash',
        claude: 'claude-sonnet-4-20250514',
        'openai-compatible': ''  // 无默认，需用户填写
    };
    return models[provider] || models.deepseek;
}

/**
 * 获取API地址
 * openai-compatible 需要用户自行填写 baseUrl，否则提示错误
 */
export function getApiBaseUrl(provider: LLMProvider, customBaseUrl?: string): string {
    if (customBaseUrl) return customBaseUrl;

    const baseUrls: Record<LLMProvider, string> = {
        deepseek: 'https://api.deepseek.com',
        openai: 'https://api.openai.com/v1',
        google: 'https://generativelanguage.googleapis.com/v1beta',
        claude: 'https://api.anthropic.com/v1',
        'openai-compatible': ''  // 必须填 customBaseUrl
    };
    return baseUrls[provider] || baseUrls.deepseek;
}

/**
 * 获取指定提供商的可用模型列表
 * - DeepSeek / OpenAI / 兼容 OpenAI 格式的自定义地址：GET /models
 * - Google Gemini：GET /models?key=xxx
 * - Claude：返回常用模型的静态列表（Anthropic 暂无公开 list API）
 */
export async function fetchAvailableModels(
    provider: LLMProvider,
    apiKey: string,
    customBaseUrl?: string
): Promise<string[]> {
    // 安全校验：移除 baseUrl 中的非 ASCII 字符，防止 fetch 崩溃
    const safeBaseUrl = customBaseUrl
        ? customBaseUrl.replace(/[^\x20-\x7E]/g, '').trim()
        : '';

    const baseUrl = safeBaseUrl || getApiBaseUrl(provider);

    try {
        if (provider === 'google') {
            // 检测是否是自定义 baseUrl（非官方 Google API）
            const isCustomUrl = safeBaseUrl && !safeBaseUrl.includes('generativelanguage.googleapis.com');

            if (isCustomUrl) {
                // 自定义 baseUrl（如 codeflow.asia）使用 /gemini/v1/models
                const normalizedUrl = normalizeBaseUrl(safeBaseUrl, 'gemini-xxx');
                const url = `${normalizedUrl}/models`;
                llmLog(`Fetching Google models from: ${url}`);
                const resp = await fetch(url, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json() as { data?: Array<{ id: string }> };
                return (data.data || []).map(m => m.id).sort();
            }

            // 官方 Google API: GET /models?key=xxx
            const url = `${baseUrl}/models?key=${apiKey}&pageSize=100`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
            return (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => m.name.replace(/^models\//, ''));
        }

        if (provider === 'claude') {
            // Anthropic 没有公开模型列表 API，返回已知常用模型
            return [
                'claude-opus-4-6',
                'claude-opus-4-5-20251101',
                'claude-sonnet-4-6',
                'claude-sonnet-4-5-20250929',
                'claude-haiku-4-5-20251001',
            ];
        }

        // openai-compatible: 必须使用 customBaseUrl，且用户必须填写
        if (provider === 'openai-compatible') {
            if (!safeBaseUrl) {
                throw new Error('Custom API URL is required for OpenAI Compatible mode. Please fill in the API URL field.');
            }
            const normalizedUrl = normalizeBaseUrl(safeBaseUrl);
            const modelsUrl = `${normalizedUrl}/models`;
            llmLog(`Fetching models from OpenAI-compatible endpoint: ${modelsUrl}`);
            const resp = await fetch(modelsUrl, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json() as { data?: Array<{ id: string }> };
            return (data.data || []).map(m => m.id).sort();
        }

        // DeepSeek / OpenAI：GET /v1/models
        const normalizedUrl = normalizeBaseUrl(baseUrl);
        const modelsUrl = `${normalizedUrl}/models`;
        llmLog(`Fetching models from: ${modelsUrl}`);

        const headers: Record<string, string> = {};
        if (provider === 'claude') {
            headers['x-anthropic-auth-token'] = apiKey;
        } else {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const resp = await fetch(modelsUrl, { headers });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json() as { data?: Array<{ id: string }> };
        const ids = (data.data || []).map(m => m.id).sort();
        return ids;
    } catch (e: any) {
        llmLog(`fetchAvailableModels failed [${provider}]: ${e.message}`);
        throw e;
    }
}

/**
 * LLM 服务类
 */
export class LLMService {
    private config: LLMConfig;

    constructor(config?: Partial<LLMConfig>) {
        this.config = config ? { ...getLLMConfig(), ...config } : getLLMConfig();
    }

    /**
     * 调用LLM
     */
    async chat(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
        const { provider, apiKey } = this.config;
        const baseUrl = getApiBaseUrl(provider, this.config.baseUrl);
        
        // deepseek-reasoner 不支持 system prompt 且易返回空内容，自动降级为 deepseek-chat
        let model = this.config.model || getDefaultModel(provider);
        if (provider === 'deepseek' && model === 'deepseek-reasoner') {
            model = 'deepseek-chat';
            llmLog(`⚠️ 自动将 deepseek-reasoner 降级为 deepseek-chat（推理模型不适合结构化输出）`);
        }

        llmLog(`📤 开始调用 LLM API | Provider: ${provider} | Model: ${model} | BaseURL: ${baseUrl}`);

        if (!apiKey) {
            llmLog(`❌ 未配置 API Key`);
            throw new Error('请在设置中配置 LLM API Key');
        }

        llmLog(`📝 Prompt 长度: ${prompt.length} 字符`);

        let result: LLMResponse;
        try {
            switch (provider) {
                case 'deepseek':
                    result = await this.callDeepSeek(baseUrl, apiKey, model, prompt, systemPrompt);
                    break;
                case 'openai':
                case 'openai-compatible':
                    // openai-compatible: 必须有 baseUrl
                    if (provider === 'openai-compatible' && !this.config.baseUrl) {
                        throw new Error('Custom API URL is required for OpenAI Compatible mode.');
                    }
                    result = await this.callOpenAI(
                        provider === 'openai-compatible' ? this.config.baseUrl : baseUrl,
                        apiKey, model, prompt, systemPrompt
                    );
                    break;
                case 'google':
                    result = await this.callGoogle(baseUrl, apiKey, model, prompt, systemPrompt);
                    break;
                case 'claude':
                    result = await this.callClaude(baseUrl, apiKey, model, prompt, systemPrompt);
                    break;
                default:
                    throw new Error(`不支持的 LLM 提供商: ${provider}`);
            }
            
            llmLog(`✅ LLM API 调用成功 | 响应长度: ${result.content.length} 字符`);
            if (result.usage) {
                llmLog(`📊 Token 使用: prompt=${result.usage.prompt_tokens}, completion=${result.usage.completion_tokens}, total=${result.usage.total_tokens}`);
            }
            
            return result;
        } catch (error) {
            llmLog(`❌ LLM API 调用失败: ${error}`);
            throw error;
        }
    }

    /**
     * 流式调用LLM
     */
    async chatWithStream(
        prompt: string,
        systemPrompt: string,
        onChunk: (chunk: string) => void
    ): Promise<LLMResponse> {
        const { provider, apiKey, model } = this.config;
        const baseUrl = getApiBaseUrl(provider, this.config.baseUrl);

        llmLog(`📤 开始流式调用 LLM API | Provider: ${provider} | Model: ${model} | BaseURL: ${baseUrl}`);
        llmLog(`📝 Prompt 长度: ${prompt.length} 字符`);

        if (!apiKey) {
            llmLog(`❌ 未配置 API Key`);
            throw new Error('请在设置中配置 LLM API Key');
        }

        let result: LLMResponse;
        try {
            switch (provider) {
                case 'deepseek':
                    result = await this.callDeepSeekStream(baseUrl, apiKey, model, prompt, systemPrompt, onChunk);
                    break;
                case 'openai':
                case 'openai-compatible':
                    // openai-compatible: 必须有 baseUrl
                    if (provider === 'openai-compatible' && !this.config.baseUrl) {
                        throw new Error('Custom API URL is required for OpenAI Compatible mode.');
                    }
                    result = await this.callOpenAIStream(
                        provider === 'openai-compatible' ? this.config.baseUrl : baseUrl,
                        apiKey, model, prompt, systemPrompt, onChunk
                    );
                    break;
                case 'google':
                    result = await this.callGoogleStream(baseUrl, apiKey, model, prompt, systemPrompt, onChunk);
                    break;
                case 'claude':
                    result = await this.callClaudeStream(baseUrl, apiKey, model, prompt, systemPrompt, onChunk);
                    break;
                default:
                    throw new Error(`Unsupported provider: ${provider}`);
            }

            llmLog(`✅ 流式 LLM API 调用完成 | 响应长度: ${result.content.length} 字符`);
            if (result.usage) {
                llmLog(`📊 Token 使用: prompt=${result.usage.prompt_tokens}, completion=${result.usage.completion_tokens}, total=${result.usage.total_tokens}`);
            }

            return result;
        } catch (error) {
            llmLog(`❌ 流式 LLM API 调用失败: ${error}`);
            throw error;
        }
    }

    // ========== DeepSeek ==========
    private async callDeepSeek(
        baseUrl: string,
        apiKey: string,
        model: string,
        prompt: string,
        systemPrompt?: string
    ): Promise<LLMResponse> {
        // DeepSeek 官方 API 不需要 /v1，但代理可能需要，先尝试原路径
        const urls = [
            `${baseUrl}/chat/completions`,
            `${normalizeBaseUrl(baseUrl, model)}/chat/completions`
        ];
        
        const messages: any[] = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: prompt });

        let lastError: any;
        for (const url of urls) {
            try {
                llmLog(`📡 DeepSeek 请求 URL: ${url}`);
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model,
                        messages,
                        temperature: 0.1
                    })
                });

                if (!response.ok) {
                    lastError = new Error(`HTTP ${response.status}: ${await response.text()}`);
                    continue;
                }

                const data = await response.json();
                return {
                    content: data.choices[0]?.message?.content || '',
                    usage: data.usage
                };
            } catch (e: any) {
                lastError = e;
                llmLog(`⚠️ DeepSeek 尝试 ${url} 失败: ${e.message}`);
            }
        }

        throw lastError || new Error('DeepSeek API 所有路径均失败');
    }

    private async callDeepSeekStream(
        baseUrl: string,
        apiKey: string,
        model: string,
        prompt: string,
        systemPrompt: string,
        onChunk: (chunk: string) => void
    ): Promise<LLMResponse> {
        // 同步 callDeepSeek，先尝试原路径再尝试 /v1
        const urls = [
            `${baseUrl}/chat/completions`,
            `${normalizeBaseUrl(baseUrl, model)}/chat/completions`
        ];
        
        const messages: any[] = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: prompt });

        let lastError: any;
        for (const url of urls) {
            try {
                llmLog(`📡 DeepSeek Stream 请求 URL: ${url}`);
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model,
                        messages,
                        temperature: 0.1,
                        stream: true
                    })
                });

                if (!response.ok) {
                    lastError = new Error(`HTTP ${response.status}: ${await response.text()}`);
                    llmLog(`⚠️ DeepSeek Stream 尝试 ${url} 失败: HTTP ${response.status}`);
                    continue;
                }

                const reader = response.body?.getReader();
                const decoder = new TextDecoder();
                let content = '';
                let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

                while (reader) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n').filter(line => line.trim() !== '');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6);
                            if (data === '[DONE]') continue;
                            
                            try {
                                const json = JSON.parse(data);
                                const delta = json.choices[0]?.delta?.content || '';
                                content += delta;
                                onChunk(delta);
                            } catch (e) {
                                // 忽略解析错误
                            }
                        }
                    }
                }

                return { content, usage };
            } catch (e: any) {
                lastError = e;
                llmLog(`⚠️ DeepSeek Stream 尝试 ${url} 失败: ${e.message}`);
            }
        }

        throw lastError || new Error('DeepSeek Stream API 所有路径均失败');
    }

    // ========== OpenAI ==========
    private async callOpenAI(
        baseUrl: string,
        apiKey: string,
        model: string,
        prompt: string,
        systemPrompt?: string
    ): Promise<LLMResponse> {
        const normalizedUrl = normalizeBaseUrl(baseUrl, model);
        const url = `${normalizedUrl}/chat/completions`;
        
        llmLog(`📡 OpenAI 请求 URL: ${url}`);
        
        const messages: any[] = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: prompt });

        // OpenAI 兼容 API 使用 Bearer token（无论是否通过 codeflow 代理）
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.1
            })
        });

        if (!response.ok) {
            const error = await response.text();
            llmLog(`❌ OpenAI API 错误: ${response.status} - ${error.substring(0, 200)}`);
            throw new Error(`OpenAI API 错误: ${response.status} - ${error}`);
        }

        const data = await response.json();
        return {
            content: data.choices[0]?.message?.content || '',
            usage: data.usage
        };
    }

    private async callOpenAIStream(
        baseUrl: string,
        apiKey: string,
        model: string,
        prompt: string,
        systemPrompt: string,
        onChunk: (chunk: string) => void
    ): Promise<LLMResponse> {
        const normalizedUrl = normalizeBaseUrl(baseUrl, model);
        const url = `${normalizedUrl}/chat/completions`;
        
        llmLog(`📡 OpenAI Stream 请求 URL: ${url}`);
        
        const messages: any[] = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: prompt });

        // OpenAI 兼容 API 使用 Bearer token（无论是否通过 codeflow 代理）
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.1,
                stream: true
            })
        });

        if (!response.ok) {
            const error = await response.text();
            llmLog(`❌ OpenAI Stream API 错误: ${response.status} - ${error.substring(0, 200)}`);
            throw new Error(`OpenAI API 错误: ${response.status} - ${error}`);
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let content = '';

        while (reader) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter(line => line.trim() !== '');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    
                    try {
                        const json = JSON.parse(data);
                        const delta = json.choices[0]?.delta?.content || '';
                        content += delta;
                        onChunk(delta);
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        }

        return { content };
    }

    // ========== Google Gemini ==========
    private async callGoogle(
        baseUrl: string,
        apiKey: string,
        model: string,
        prompt: string,
        systemPrompt?: string
    ): Promise<LLMResponse> {
        // 检测是否是自定义 baseUrl（非官方 Google API）
        const isCustomUrl = !baseUrl.includes('generativelanguage.googleapis.com');
        
        if (isCustomUrl) {
            // 自定义 baseUrl（如 codeflow.asia）使用 OpenAI 兼容格式
            return this.callOpenAI(baseUrl, apiKey, model, prompt, systemPrompt);
        }
        
        // 官方 Google API 使用原生格式
        const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`;
        
        let content = prompt;
        if (systemPrompt) {
            content = `System: ${systemPrompt}\n\nUser: ${prompt}`;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text: content }] }],
                generationConfig: {
                    temperature: 0.1
                }
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Google API 错误: ${response.status} - ${error}`);
        }

        const data = await response.json();
        return {
            content: data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        };
    }

    private async callGoogleStream(
        baseUrl: string,
        apiKey: string,
        model: string,
        prompt: string,
        systemPrompt: string,
        onChunk: (chunk: string) => void
    ): Promise<LLMResponse> {
        // 检测是否是自定义 baseUrl（非官方 Google API）
        const isCustomUrl = !baseUrl.includes('generativelanguage.googleapis.com');
        
        if (isCustomUrl) {
            // 自定义 baseUrl（如 codeflow.asia）使用 OpenAI 兼容格式
            return this.callOpenAIStream(baseUrl, apiKey, model, prompt, systemPrompt, onChunk);
        }
        
        // 官方 Google API 使用原生格式
        // Google streaming 需要使用不同的端点
        const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
        
        let content = prompt;
        if (systemPrompt) {
            content = `System: ${systemPrompt}\n\nUser: ${prompt}`;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text: content }] }],
                generationConfig: {
                    temperature: 0.1,
                    stream: true
                }
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Google API 错误: ${response.status} - ${error}`);
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';

        while (reader) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter(line => line.trim() !== '');

            for (const line of lines) {
                try {
                    const json = JSON.parse(line);
                    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    fullContent += text;
                    onChunk(text);
                } catch (e) {
                    // 忽略解析错误
                }
            }
        }

        return { content: fullContent };
    }

    // ========== Claude ==========
    private async callClaude(
        baseUrl: string,
        apiKey: string,
        model: string,
        prompt: string,
        systemPrompt?: string
    ): Promise<LLMResponse> {
        // 检测是否是自定义 baseUrl（非官方 Anthropic API）
        const isCustomUrl = !baseUrl.includes('api.anthropic.com');
        
        if (isCustomUrl) {
            // 自定义 baseUrl（如 codeflow.asia）使用 OpenAI 兼容格式
            return this.callOpenAI(baseUrl, apiKey, model, prompt, systemPrompt);
        }
        
        // 官方 Anthropic API 使用原生格式
        const url = `${baseUrl}/messages`;
        
        const messages: any[] = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: prompt });

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.1,
                max_tokens: 4096
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Claude API 错误: ${response.status} - ${error}`);
        }

        const data = await response.json();
        return {
            content: data.content?.[0]?.text || '',
            usage: {
                prompt_tokens: data.usage?.input_tokens || 0,
                completion_tokens: data.usage?.output_tokens || 0,
                total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
            }
        };
    }

    private async callClaudeStream(
        baseUrl: string,
        apiKey: string,
        model: string,
        prompt: string,
        systemPrompt: string,
        onChunk: (chunk: string) => void
    ): Promise<LLMResponse> {
        // 检测是否是自定义 baseUrl（非官方 Anthropic API）
        const isCustomUrl = !baseUrl.includes('api.anthropic.com');
        
        if (isCustomUrl) {
            // 自定义 baseUrl（如 codeflow.asia）使用 OpenAI 兼容格式
            return this.callOpenAIStream(baseUrl, apiKey, model, prompt, systemPrompt, onChunk);
        }
        
        const url = `${baseUrl}/messages`;
        
        const messages: any[] = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: prompt });

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.1,
                max_tokens: 4096,
                stream: true
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Claude API 错误: ${response.status} - ${error}`);
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let content = '';
        let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        while (reader) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter(line => line.trim() !== '');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    
                    try {
                        const json = JSON.parse(data);
                        const delta = json.delta?.text || '';
                        content += delta;
                        onChunk(delta);
                        
                        // 累加 usage
                        if (json.usage) {
                            usage.completion_tokens += json.usage.output_tokens || 0;
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        }

        return { content, usage };
    }
}

/**
 * 获取LLM提供商的显示名称
 */
export function getProviderDisplayName(provider: LLMProvider): string {
    const names: Record<LLMProvider, string> = {
        deepseek: 'DeepSeek',
        openai: 'OpenAI',
        google: 'Google Gemini',
        claude: 'Claude',
        'openai-compatible': 'OpenAI Compatible (Custom)'
    };
    return names[provider] || provider;
}

/**
 * 获取所有支持的提供商
 */
export function getAllProviders(): LLMProvider[] {
    return ['deepseek', 'openai', 'google', 'claude', 'openai-compatible'];
}
