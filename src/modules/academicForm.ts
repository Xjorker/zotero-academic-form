// src/modules/academicForm.ts
// Phase 3 简化版：前端不再直接调用 LLM，改为调用后端 Agent API
type ZoteroItem = Zotero.Item;
import { getPref } from "../utils/prefs";
import { getLLMConfig } from "./llmService";
import { getServerUrl } from "./agentClient";
import {
    callAgentFill,
    createAgentSessionId,
    type AgentFillResponse,
} from "./agentClient";

export interface DblpAuthor {
    name: string;
    pid?: string;
    currentAffiliations?: string[];
    formerAffiliations?: string[];
}

/**
 * 注册"学术成果填表"右键菜单
 */
export function registerAcademicFormMenu() {
    if (ztoolkit.Menu.unregister) {
        ztoolkit.Menu.unregister("context-academic-form");
    }

    ztoolkit.Menu.register("item", {
        tag: "menuitem",
        id: "context-academic-form",
        label: "学术成果填表",
        commandListener: () => {
            const pane = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
            const items = pane ? pane.getSelectedItems() : [];
            onAcademicFormClicked(items as ZoteroItem[]);
        },
    });
}

/**
 * 注销菜单（适配模板的销毁逻辑）
 */
export function unregisterAcademicFormMenu() {
    if (ztoolkit.Menu.unregister) {
        ztoolkit.Menu.unregister("context-academic-form");
    }
}

/**
 * 右键点击后的统一入口
 */
async function onAcademicFormClicked(items: ZoteroItem[]) {
    if (!items || items.length !== 1) {
        ztoolkit.getGlobal("alert")("请只选择一篇论文条目");
        return;
    }

    const item = items[0];

    if (!item.isRegularItem()) {
        ztoolkit.getGlobal("alert")("该条目不是普通文献条目");
        return;
    }

    const itemType = item.itemType;
    if (itemType !== "journalArticle" && itemType !== "conferencePaper") {
        ztoolkit.getGlobal("alert")("目前仅支持期刊或会议论文");
        return;
    }

    await openAcademicForm(item);
}

/**
 * 学术成果填表主流程
 */
async function openAcademicForm(item: ZoteroItem) {
    const title = item.getField("title");
    const doi = item.getField("DOI");

    ztoolkit.log("学术成果填表:", { title, doi });

    let authors = await searchDblpAuthorsByTitle(title, doi);

    if (!authors.length) {
        ztoolkit.getGlobal("alert")("未在 DBLP 中找到作者信息");
        return;
    }

    // 拉取每个作者机构
    await Promise.all(
        authors.map(async (author) => {
            if (author.pid) {
                const { currentAffiliations, formerAffiliations } =
                    await fetchAffiliationsFromDblp(author.pid);
                author.currentAffiliations = currentAffiliations;
                author.formerAffiliations = formerAffiliations;
            }
        })
    );

    openAuthorListWindow(authors);
}

/**
 * DBLP 作者机构抓取
 */
async function fetchAffiliationsFromDblp(
    pid: string
): Promise<{ currentAffiliations: string[]; formerAffiliations: string[] }> {
    try {
        const url = `https://dblp.org/pid/${pid}.xml`;
        const resp = await fetch(url);
        const text = await resp.text();
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, "text/xml");

        const persons = Array.from(xml.getElementsByTagName("person"));
        const targetPerson = persons.find((p) => {
            const author = (p as Element).getElementsByTagName("author")[0];
            return author?.getAttribute("pid") === pid;
        });
        if (!targetPerson)
            return { currentAffiliations: [], formerAffiliations: [] };

        const notes = Array.from((targetPerson as Element).getElementsByTagName("note"));
        const currentAffiliations: string[] = [];
        const formerAffiliations: string[] = [];

        notes.forEach((note) => {
            const noteElement = note as Element;
            const type = noteElement.getAttribute("type");
            const label = noteElement.getAttribute("label") || "";
            const txt = noteElement.textContent?.trim();
            if (!txt) return;

            if (type === "affiliation") {
                if (label === "former") {
                    formerAffiliations.push(txt);
                } else {
                    currentAffiliations.push(txt);
                }
            }
        });

        return { currentAffiliations, formerAffiliations };
    } catch (err) {
        ztoolkit.log("获取机构失败:", pid, err);
        return { currentAffiliations: [], formerAffiliations: [] };
    }
}

/**
 * 根据论文标题搜索 DBLP 作者
 */
async function searchDblpAuthorsByTitle(
    title: string,
    doi?: string
): Promise<DblpAuthor[]> {
    const query = encodeURIComponent(title);
    const url = `https://dblp.org/search/publ/api?q=${query}&format=json`;

    const resp = await fetch(url);
    const data = (await resp.json()) as any;

    const hits = data?.result?.hits?.hit;
    if (!hits || hits.length === 0) return [];

    const info = hits[0].info;
    const authorsRaw = info?.authors?.author;
    if (!authorsRaw) return [];

    const authorsArray = Array.isArray(authorsRaw) ? authorsRaw : [authorsRaw];

    return authorsArray.map((a: any) => ({
        name: a.text || a,
        pid: a["@pid"],
    }));
}

/**
 * 弹窗渲染作者列表
 */
function openAuthorListWindow(authors: DblpAuthor[]) {
    const rowCount = authors.length + 3;
    const dialog = new ztoolkit.Dialog(rowCount, 3);

    // 标题
    dialog.addCell(0, 0, {
        tag: "div",
        properties: { innerText: "📄 学术成果填表 · 作者选择" },
        styles: {
            gridColumn: "span 3",
            padding: "14px 20px 6px",
            fontSize: "16px",
            fontWeight: "600",
            color: "#1a237e",
        },
    });

    // 描述
    dialog.addCell(1, 0, {
        tag: "div",
        properties: {
            innerText: "已从 DBLP 自动识别该论文的作者及机构信息（如可获取）",
        },
        styles: {
            gridColumn: "span 3",
            padding: "0 20px 12px",
            fontSize: "12px",
            color: "#555",
            borderBottom: "1px solid #e0e0e0",
        },
    });

    // 表头
    dialog
        .addCell(2, 0, tableHeader("作者"))
        .addCell(2, 1, tableHeader("作者机构"))
        .addCell(2, 2, tableHeader("操作"));

    // 作者行
    authors.forEach((author, i) => {
        const row = i + 3;
        const bg = i % 2 === 0 ? "#ffffff" : "#fafafa";

        // 作者列
        dialog.addCell(row, 0, {
            tag: "div",
            styles: cellStyle(bg),
            children: [
                {
                    tag: "div",
                    properties: { innerText: author.name },
                    styles: { fontSize: "14px", fontWeight: "500", marginBottom: "4px" },
                },
                {
                    tag: "div",
                    properties: {
                        innerText: author.pid ? `DBLP: ${author.pid}` : "DBLP: -",
                    },
                    styles: { fontSize: "12px", color: "#777", fontFamily: "monospace" },
                },
            ],
        });

        // 机构列
        dialog.addCell(row, 1, {
            tag: "div",
            styles: {
                ...cellStyle(bg),
                fontSize: "12px",
                color: "#444",
                lineHeight: "1.4",
                maxWidth: "320px",
                whiteSpace: "pre-wrap",
            },
            properties: {
                innerHTML: [
                    ...(author.currentAffiliations || []).map((a) => `当前: ${a}`),
                    ...(author.formerAffiliations || []).map((a, idx) =>
                        idx === 0 ? `历史: ${a}` : a
                    ),
                ].join("<br>") || "-",
            },
        });

        // 操作列
        dialog.addCell(row, 2, {
            tag: "button",
            namespace: "html",
            properties: { innerText: "开始填表 ▶" },
            styles: {
                margin: "12px",
                padding: "6px 16px",
                borderRadius: "16px",
                background: "#3f51b5",
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: "500",
            },
            listeners: [
                {
                    type: "click",
                    listener: () => openUploadWindow(author),
                },
            ],
        });
    });

    dialog.addButton("关闭", "close");
    dialog.open("学术成果填表");
}

// ==================== 样式工具 ====================

function tableHeader(text: string) {
    return {
        tag: "div",
        properties: { innerText: text },
        styles: {
            padding: "10px 16px",
            fontSize: "13px",
            fontWeight: "600",
            background: "#f0f2ff",
            color: "#303f9f",
            borderBottom: "1px solid #dfe1f5",
        },
    };
}

function cellStyle(bg: string) {
    return {
        padding: "10px 16px",
        background: bg,
        borderBottom: "1px solid #eee",
    };
}

// ==================== 核心弹窗：文件上传 + Agent 填表 ====================

/**
 * 上传窗口 — 简化版
 * 用户选择 DOCX 文件 → 调用后端 /agent/fill → 下载结果
 */
async function openUploadWindow(author: DblpAuthor) {
    const dialog = new ztoolkit.Dialog(6, 1);

    let selectedFile: nsIFile | null = null;
    let isProcessing = false;

    // 1. 标题行
    dialog.addCell(0, 0, {
        tag: "div",
        namespace: "html",
        properties: { innerText: `📄 学术成果填表 · ${author.name}` },
        styles: {
            fontSize: "16px",
            fontWeight: "600",
            padding: "10px 16px",
            textAlign: "center",
        },
    });

    // 2. 文件选择按钮
    dialog.addCell(1, 0, {
        tag: "button",
        namespace: "html",
        properties: { innerText: "📂 选择 DOCX 文件" },
        styles: {
            margin: "8px 16px",
            padding: "8px 20px",
            borderRadius: "4px",
            background: "#f5f5f5",
            border: "1px solid #ddd",
            cursor: "pointer",
            width: "calc(100% - 32px)",
        },
        listeners: [
            {
                type: "click",
                listener: () => {
                    try {
                        const fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(
                            Components.interfaces.nsIFilePicker
                        );
                        fp.init(dialog.window, "选择 Word 文档", Components.interfaces.nsIFilePicker.modeOpen);
                        fp.appendFilter("Word 文档", "*.docx");

                        fp.open((rv) => {
                            if (rv === Components.interfaces.nsIFilePicker.returnOK && fp.file) {
                                selectedFile = fp.file;
                                // 更新按钮文本显示已选文件
                                const btn = dialog.window?.document.getElementById("academic-form-file-btn");
                                if (btn) {
                                    btn.textContent = `✅ ${fp.file.leafName}`;
                                }
                            }
                        });
                    } catch (e) {
                        const err = e as Error;
                        ztoolkit.getGlobal("alert")(`文件选择失败：${err.message}`);
                    }
                },
            },
        ],
    });

    // 3. 开始处理按钮
    dialog.addCell(2, 0, {
        tag: "button",
        namespace: "html",
        id: "academic-form-start-btn",
        properties: { innerText: "🚀 开始填表（Agent 智能处理）" },
        styles: {
            margin: "8px 16px",
            padding: "8px 20px",
            borderRadius: "4px",
            background: "#3f51b5",
            color: "#fff",
            border: "none",
            cursor: "pointer",
            width: "calc(100% - 32px)",
        },
        listeners: [
            {
                type: "click",
                listener: async () => {
                    if (isProcessing) return;
                    if (!selectedFile) {
                        ztoolkit.getGlobal("alert")("请先选择要填写的 Word 文档");
                        return;
                    }
                    isProcessing = true;

                    const statusDiv = await getDialogElementById(dialog, "academic-form-status-div");
                    const logPanel = await getDialogElementById(dialog, "academic-form-log-panel");

                    // 显示处理状态
                    if (statusDiv) {
                        statusDiv.style.display = "block";
                        statusDiv.innerHTML = `<div style="color: #2196F3; text-align: center; padding: 8px;">🔄 正在读取文件...</div>`;
                    }
                    if (logPanel) logPanel.innerHTML = "";

                    try {
                        addLog(logPanel, "📤 正在读取文件...");
                        const docxBase64 = await readFileAsBase64(selectedFile);
                        addLog(logPanel, `✅ 文件读取完成（${(docxBase64.length / 1024).toFixed(1)} KB）`);

                        if (statusDiv) {
                            statusDiv.innerHTML = `<div style="color: #2196F3; text-align: center; padding: 8px;">🤖 Agent 正在处理，请稍候...</div>`;
                        }
                        addLog(logPanel, "🤖 调用后端 Agent API...");

                        // 构建 user_context：从偏好设置读取姓名
                        const userContext = author.name;
                        addLog(logPanel, `👤 作者姓名(userContext): "${userContext}"`);

                        // 读取 LLM 配置传递给后端
                        const llmConfig = getLLMConfig();
                        const sessionId = createAgentSessionId();

                        addLog(logPanel, `📋 会话ID: ${sessionId}`);
                        addLog(logPanel, `🧠 模型: ${llmConfig.model || llmConfig.provider}`);

                        // 调用后端 Agent API（一次调用完成全部流程）
                        const result: AgentFillResponse = await callAgentFill({
                            docx_base64: docxBase64,
                            session_id: sessionId,
                            user_context: userContext,
                            config: {
                                max_steps: 20,
                                sources: ["kb", "rag", "api"],
                            },
                        });

                        if (result.success && result.download_url) {
                            // 成功 — 使用后端临时文件下载链接
                            const serverUrl = getServerUrl();
                            const fullDownloadUrl = `${serverUrl}${result.download_url}`;
                            const filename = `${author.name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_")}_学术成果表.docx`;

                            addLog(logPanel, `✅ Fill complete! ${result.elapsed_seconds || "?"}s, ${result.steps || "?"} steps`);

                            // Show agent trace
                            if (result.agent_trace && result.agent_trace.length > 0) {
                                addLog(logPanel, "--- Agent Trace ---");
                                for (const step of result.agent_trace) {
                                    addLog(logPanel, `  Step ${step.step}: ${step.action}`);
                                }
                            }

                            // Show mapping summary (三段式流程的映射关系输出)
                            if (result.mapping_summary) {
                                addLog(logPanel, "--- 填写映射摘要 ---");
                                for (const line of result.mapping_summary.split("\n")) {
                                    if (line.trim()) addLog(logPanel, `  ${line}`);
                                }
                            }

                            // Show word headers summary (原文档表格清单)
                            if (result.word_headers_summary && result.word_headers_summary.length > 0) {
                                addLog(logPanel, "--- 原文档表格清单 ---");
                                for (const t of result.word_headers_summary) {
                                    if (t.type === "headered") {
                                        addLog(logPanel, `  [${t.index}] 有表头: ${t.headers.join(", ")}`);
                                    } else {
                                        addLog(logPanel, `  [${t.index}] 空表格: "${t.title || "(无标题)"}"`);
                                    }
                                }
                            }

                            if (statusDiv) {
                                statusDiv.innerHTML = `
                                    <div style="padding: 12px 16px; text-align: center;">
                                        <div style="margin-bottom: 8px; font-size: 13px; color: #4CAF50; font-weight: 500;">
                                            Document filled! (${result.elapsed_seconds || "?"}s)
                                        </div>
                                        <a id="academic-form-download-link" href="javascript:void(0);"
                                           style="
                                               display: inline-block;
                                               padding: 10px 24px;
                                               font-size: 14px;
                                               background: #4CAF50;
                                               color: white;
                                               border-radius: 4px;
                                               text-decoration: none;
                                               margin-bottom: 6px;
                                               cursor: pointer;
                                           ">
                                            📥 Download filled document (.docx)
                                        </a>
                                        <div style="font-size: 11px; color: #888; margin-top: 6px;">
                                            Link expires in 5 minutes
                                        </div>
                                    </div>
                                `;

                                // 绑定点击事件，用 Zotero.launchURL 在浏览器中打开下载链接
                                const downloadLink = dialog.window?.document.getElementById("academic-form-download-link");
                                if (downloadLink) {
                                    downloadLink.addEventListener("click", () => {
                                        try {
                                            Zotero.launchURL(fullDownloadUrl);
                                        } catch (e) {
                                            ztoolkit.getGlobal("alert")("无法打开浏览器，请手动复制链接:\n" + fullDownloadUrl);
                                        }
                                    });
                                }
                            }

                            // Hide log panel
                            if (logPanel) logPanel.style.display = "none";

                        } else {
                            // Agent 返回失败
                            const errorMsg = result.error || "Agent 处理失败";
                            addLog(logPanel, `❌ 填表失败: ${errorMsg}`, "error");

                            if (statusDiv) {
                                statusDiv.innerHTML = `<div style="color: #f44336; text-align: center; padding: 8px;">❌ ${errorMsg}</div>`;
                            }
                            ztoolkit.getGlobal("alert")(`填表失败：${errorMsg}`);
                        }
                    } catch (e) {
                        const err = e as Error;
                        addLog(logPanel, `❌ 处理异常: ${err.message}`, "error");

                        const statusDivError = await getDialogElementById(dialog, "academic-form-status-div");
                        if (statusDivError) {
                            statusDivError.style.display = "block";
                            statusDivError.innerHTML = `<div style="color: #f44336; text-align: center; padding: 8px;">❌ ${err.message}</div>`;
                        }
                        ztoolkit.getGlobal("alert")(`处理失败：${err.message}`);
                    } finally {
                        isProcessing = false;
                    }
                },
            },
        ],
    });

    // 4. 状态显示区（初始隐藏）
    dialog.addCell(3, 0, {
        tag: "div",
        namespace: "html",
        properties: { id: "academic-form-status-div" },
        styles: {
            display: "none",
            margin: "0 16px",
            borderRadius: "4px",
            border: "1px solid #eee",
            background: "#fafafa",
        },
    });

    // 5. 日志面板
    dialog.addCell(4, 0, {
        tag: "div",
        namespace: "html",
        properties: { id: "academic-form-log-panel" },
        styles: {
            margin: "8px 16px",
            padding: "10px",
            borderRadius: "4px",
            border: "1px solid #ddd",
            background: "#fafafa",
            maxHeight: "200px",
            overflowY: "auto",
            fontSize: "11px",
            fontFamily: "Consolas, Monaco, monospace",
        },
    });

    // 6. 关闭按钮
    dialog.addCell(5, 0, {
        tag: "button",
        namespace: "html",
        properties: { innerText: "关闭" },
        styles: {
            margin: "8px 16px",
            padding: "8px 20px",
            borderRadius: "4px",
            background: "#f5f5f5",
            border: "1px solid #ddd",
            cursor: "pointer",
            width: "calc(100% - 32px)",
        },
        listeners: [
            {
                type: "click",
                listener: () => dialog.window?.close(),
            },
        ],
    });

    dialog.open("学术成果填表", { width: 280, height: 300, resizable: true, centerscreen: true });
}

// ==================== 工具函数 ====================

/**
 * 获取弹窗中的 DOM 元素（兼容 Zotero 异步渲染）
 */
async function getDialogElementById(
    dialog: any,
    id: string,
    maxRetries = 8,
    delay = 300
): Promise<HTMLElement | null> {
    if (!dialog.window || !dialog.window.document) {
        return null;
    }
    const doc = dialog.window.document;

    for (let i = 0; i < maxRetries; i++) {
        const element = doc.getElementById(id);
        if (element) {
            return element;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return null;
}

/**
 * 向日志面板追加一条日志
 */
function addLog(panel: HTMLElement | null, message: string, type: "info" | "success" | "error" = "info") {
    if (!panel) return;

    const colors = { info: "#666", success: "#4caf50", error: "#f44336" };
    const icons = { info: "ℹ️", success: "✅", error: "❌" };
    const timestamp = new Date().toLocaleTimeString().slice(0, 5);

    const doc = panel.ownerDocument!;
    const entry = doc.createElement("div");
    entry.innerHTML = `<span style="color: #999;">${timestamp}</span> <span style="color: ${colors[type]};">${icons[type]} ${message}</span>`;
    entry.style.fontSize = "11px";
    entry.style.marginBottom = "2px";
    panel.appendChild(entry);
    panel.scrollTop = panel.scrollHeight;
}

/**
 * 读取文件为 Base64（Zotero XPCOM 兼容）
 */
async function readFileAsBase64(file: nsIFile): Promise<string> {
    // 方式1: Zotero.File
    if (typeof Zotero !== "undefined" && Zotero.File) {
        try {
            const raw = await Zotero.File.getBinaryContentsAsync(file);
            let uint8: Uint8Array;
            if (raw instanceof Uint8Array) uint8 = raw;
            else if (raw instanceof ArrayBuffer) uint8 = new Uint8Array(raw);
            else if (ArrayBuffer.isView(raw)) uint8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
            else if (typeof raw === "string") {
                uint8 = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) uint8[i] = raw.charCodeAt(i) & 0xff;
            } else {
                uint8 = new Uint8Array(raw as any);
            }
            return uint8ToBase64(uint8);
        } catch (e) {
            ztoolkit.log("[academicForm] Zotero.File 读取失败，尝试 XPCOM:", e);
        }
    }

    // 方式2: XPCOM nsIFileInputStream
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

            resolve(uint8ToBase64(uint8Array));
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Uint8Array → Base64
 */
function uint8ToBase64(u8: Uint8Array): string {
    let binary = "";
    const len = u8.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(u8[i]);
    }
    return btoa(binary);
}
