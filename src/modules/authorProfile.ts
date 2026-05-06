import { getString } from "../utils/locale";
import { getLLMConfig } from "./llmService";

// 作者详细信息接口
interface AuthorInfo {
    name: string;
    displayName: string;       // 显示名（不含编号）
    dblpName?: string;         // DBLP 中的完整名字（含编号如 0007）
    institution: string;
    orcid?: string;
    dblpPid?: string;          // DBLP 作者 PID
    dblpUrl?: string;          // DBLP 主页链接
    worksCount?: number;
    affiliations?: string[];   // 机构列表
}

// DBLP 论文信息（完整字段）
interface DblpPublication {
    // 核心字段
    title: string;
    year?: string;
    type?: 'article' | 'inproceedings' | 'book' | 'incollection' | 'phdthesis' | 'mastersthesis' | 'proceedings';
    // 期刊/会议信息
    venue?: string;           // journal 或 booktitle
    journal?: string;          // 期刊名（article）
    booktitle?: string;        // 会议名（inproceedings）
    volume?: string;
    number?: string;
    pages?: string;
    // 标识符
    doi?: string;
    ee?: string;               // 电子版链接
    url?: string;               // DBLP 页面链接
    // 其他元数据
    publisher?: string;
    series?: string;
    isbn?: string;
    month?: string;
    crossref?: string;
    // 作者列表
    authors?: string[];
    // 原始 XML（用于调试）
    rawXml?: string;
}

// DBLP 作者信息（从论文中提取）
interface DblpAuthorFromPub {
    name: string;              // 完整名字（如 "Sheng Wang 0007"）
    displayName: string;       // 显示名（如 "Sheng Wang"）
    pid: string;               // PID
    url: string;               // DBLP 主页
}

// 简单的聊天消息类型（用于 LLM 对话）
type ChatRole = "system" | "user" | "assistant";
interface ChatMessage {
    role: ChatRole;
    content: string;
}

export function registerAuthorProfileMenu() {
    if (ztoolkit.Menu.unregister) {
        ztoolkit.Menu.unregister("context-generate-author-profile");
    }
    ztoolkit.Menu.register("item", {
        tag: "menuitem",
        id: "context-generate-author-profile",
        label: "生成作者Profile",
        commandListener: () => {
            const pane = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
            const items = pane ? pane.getSelectedItems() : [];
            showAuthorProfiles(items);
        }
    });
}

/**
 * 复制文本到剪贴板
 */
function copyToClipboard(text: string) {
    try {
        new ztoolkit.Clipboard().addText(text, "text/unicode").copy();
        ztoolkit.log("Copied to clipboard:", text);
    } catch (e) {
        ztoolkit.log("Clipboard failed:", e);
    }
}

/**
 * 从 Crossref 获取论文详情（根据 DOI）
 */
async function fetchCrossrefByDoi(doi: string): Promise<any> {
    if (!doi) return null;
    try {
        const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'ZoteroPlugin/1.0' } });
        if (resp.ok) {
            const data: any = await resp.json();
            return parseCrossrefData(data.message || {});
        }
    } catch (e) {
        ztoolkit.log("Crossref DOI 查询失败:", e);
    }
    return null;
}

/**
 * 从 Crossref 搜索论文（根据标题）
 */
async function fetchCrossrefByTitle(title: string): Promise<any> {
    if (!title) return null;
    try {
        const url = `https://api.crossref.org/works?query.title=${encodeURIComponent(title)}&rows=1`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'ZoteroPlugin/1.0' } });
        if (resp.ok) {
            const data: any = await resp.json();
            const items = data.message?.items || [];
            if (items.length > 0) {
                return parseCrossrefData(items[0]);
            }
        }
    } catch (e) {
        ztoolkit.log("Crossref 标题查询失败:", e);
    }
    return null;
}

/**
 * 解析 Crossref 返回数据
 */
function parseCrossrefData(data: any): any {
    const affiliations: string[] = [];
    const countries: string[] = [];
    const authors: any[] = [];

    for (const a of data.author || []) {
        const authorInfo: any = {
            given: a.given || '',
            family: a.family || '',
            name: `${a.given || ''} ${a.family || ''}`.trim(),
            affiliations: []
        };
        for (const aff of a.affiliation || []) {
            if (aff.name) {
                affiliations.push(aff.name);
                authorInfo.affiliations.push(aff.name);
            }
            if (aff.country) {
                countries.push(aff.country);
            }
        }
        if (a.ORCID) {
            authorInfo.orcid = a.ORCID;
        }
        authors.push(authorInfo);
    }

    return {
        doi: data.DOI || '',
        title: (data.title || [''])[0],
        journal: (data['container-title'] || [''])[0],
        issn: (data.ISSN || []).join(', '),
        publisher: data.publisher || '',
        isbn: (data.ISBN || []).join(', '),
        affiliations: [...new Set(affiliations)],
        countries: [...new Set(countries)],
        authors: authors,
        year: data.created?.['date-parts']?.[0]?.[0] || ''
    };
}

/**
 * 在 DBLP 搜索论文，获取准确的作者 PID
 */
async function searchDblpPublication(title: string): Promise<{ authors: DblpAuthorFromPub[], found: boolean }> {
    if (!title) return { authors: [], found: false };

    try {
        const cleanTitle = title.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const url = `https://dblp.org/search/publ/api?q=${encodeURIComponent(cleanTitle)}&format=json&h=5`;

        ztoolkit.log("搜索 DBLP 论文:", url);
        const resp = await fetch(url);

        if (resp.ok) {
            const data: any = await resp.json();
            const hits = data.result?.hits?.hit || [];

            ztoolkit.log("DBLP 论文搜索结果数量:", hits.length);

            for (const hit of hits) {
                const info = hit.info || {};
                const pubTitle = info.title || '';

                const normalizedPubTitle = pubTitle.toLowerCase().replace(/[^\w\s]/g, '');
                const normalizedSearchTitle = title.toLowerCase().replace(/[^\w\s]/g, '');

                if (normalizedPubTitle.includes(normalizedSearchTitle.substring(0, 30)) ||
                    normalizedSearchTitle.includes(normalizedPubTitle.substring(0, 30))) {

                    ztoolkit.log("找到匹配论文:", pubTitle);

                    const authorsData = info.authors?.author || [];
                    const authorsList = Array.isArray(authorsData) ? authorsData : [authorsData];

                    const authors: DblpAuthorFromPub[] = [];
                    for (const author of authorsList) {
                        let authorName = '';
                        let authorPid = '';

                        if (typeof author === 'string') {
                            authorName = author;
                        } else if (typeof author === 'object') {
                            authorName = author.text || author['#text'] || '';
                            authorPid = author['@pid'] || '';
                        }

                        if (authorName) {
                            const displayName = authorName.replace(/\s+\d{4}$/, '').trim();

                            authors.push({
                                name: authorName,
                                displayName: displayName,
                                pid: authorPid,
                                url: authorPid ? `https://dblp.org/pid/${authorPid}` : ''
                            });

                            ztoolkit.log(`作者: ${authorName} (显示名: ${displayName}, PID: ${authorPid})`);
                        }
                    }

                    return { authors, found: true };
                }
            }
        }
    } catch (e) {
        ztoolkit.log("DBLP 论文搜索失败:", e);
    }

    return { authors: [], found: false };
}

/**
 * 获取 DBLP 作者的论文列表（完整字段）
 */
async function fetchDblpAuthorPublications(pid: string, limit = 500): Promise<DblpPublication[]> {
    if (!pid) return [];
    try {
        const url = `https://dblp.org/pid/${pid}.xml`;
        const resp = await fetch(url);
        if (resp.ok) {
            const text = await resp.text();

            // 匹配所有类型的文献条目
            const articleMatches = text.match(/<article[^>]*>[\s\S]*?<\/article>/g) || [];
            const inprocMatches = text.match(/<inproceedings[^>]*>[\s\S]*?<\/inproceedings>/g) || [];
            const bookMatches = text.match(/<book[^>]*>[\s\S]*?<\/book>/g) || [];
            const incollMatches = text.match(/<incollection[^>]*>[\s\S]*?<\/incollection>/g) || [];

            const allMatches = [
                ...articleMatches.map(m => ({ xml: m, type: 'article' as const })),
                ...inprocMatches.map(m => ({ xml: m, type: 'inproceedings' as const })),
                ...bookMatches.map(m => ({ xml: m, type: 'book' as const })),
                ...incollMatches.map(m => ({ xml: m, type: 'incollection' as const })),
            ].slice(0, limit);

            const publications: DblpPublication[] = [];

            for (const { xml, type } of allMatches) {
                // 解析标题
                const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/);
                const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

                // 解析年份
                const yearMatch = xml.match(/<year>(\d+)<\/year>/);
                const year = yearMatch ? yearMatch[1] : '';

                // 解析 DOI（从 ee 链接提取）
                const eeMatch = xml.match(/<ee>([\s\S]*?)<\/ee>/);
                const ee = eeMatch ? eeMatch[1].trim() : '';
                let doi = '';
                if (ee.includes('doi.org/')) {
                    doi = ee.split('doi.org/')[1].split('?')[0];
                }

                // 解析 DBLP URL
                const urlMatch = xml.match(/<url>([\s\S]*?)<\/url>/);
                const url = urlMatch ? urlMatch[1].trim() : '';

                // 解析 venue（journal 或 booktitle）
                const journalMatch = xml.match(/<journal>([\s\S]*?)<\/journal>/);
                const booktitleMatch = xml.match(/<booktitle>([\s\S]*?)<\/booktitle>/);
                const journal = journalMatch ? journalMatch[1].replace(/<[^>]+>/g, '').trim() : '';
                const booktitle = booktitleMatch ? booktitleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
                const venue = journal || booktitle;

                // 解析卷、期、页码
                const volumeMatch = xml.match(/<volume>([\s\S]*?)<\/volume>/);
                const numberMatch = xml.match(/<number>([\s\S]*?)<\/number>/);
                const pagesMatch = xml.match(/<pages>([\s\S]*?)<\/pages>/);
                const volume = volumeMatch ? volumeMatch[1].trim() : '';
                const number = numberMatch ? numberMatch[1].trim() : '';
                const pages = pagesMatch ? pagesMatch[1].trim() : '';

                // 解析作者列表
                const authorMatches = xml.match(/<author[^>]*>([\s\S]*?)<\/author>/g) || [];
                const authors: string[] = [];
                for (const authorMatch of authorMatches) {
                    const authorName = authorMatch.replace(/<[^>]+>/g, '').trim();
                    if (authorName) authors.push(authorName);
                }

                // 解析出版商、系列、ISBN、月份
                const publisherMatch = xml.match(/<publisher>([\s\S]*?)<\/publisher>/);
                const seriesMatch = xml.match(/<series>([\s\S]*?)<\/series>/);
                const isbnMatch = xml.match(/<isbn>([\s\S]*?)<\/isbn>/);
                const monthMatch = xml.match(/<month>([\s\S]*?)<\/month>/);
                const crossrefMatch = xml.match(/<crossref[^>]*>([\s\S]*?)<\/crossref>/);

                publications.push({
                    title,
                    year,
                    type,
                    venue,
                    journal: journal || undefined,
                    booktitle: booktitle || undefined,
                    volume: volume || undefined,
                    number: number || undefined,
                    pages: pages || undefined,
                    doi,
                    ee,
                    url,
                    authors: authors.length > 0 ? authors : undefined,
                    publisher: publisherMatch ? publisherMatch[1].trim() : undefined,
                    series: seriesMatch ? seriesMatch[1].trim() : undefined,
                    isbn: isbnMatch ? isbnMatch[1].trim() : undefined,
                    month: monthMatch ? monthMatch[1].trim() : undefined,
                    crossref: crossrefMatch ? crossrefMatch[1].trim() : undefined,
                    rawXml: xml,
                });
            }

            ztoolkit.log(`DBLP 获取到 ${publications.length} 篇论文`);
            return publications;
        }
    } catch (e) {
        ztoolkit.log("DBLP 论文列表获取失败:", e);
    }
    return [];
}

/**
 * 规范化 DOI
 */
function normalizeDoi(doi: string): string {
    if (!doi) return '';
    return doi.replace(/^https?:\/\/doi\.org\//i, '').trim();
}

/**
 * 导入 DBLP 论文列表到 Zotero
 */
async function importPapersToZotero(
    publications: DblpPublication[],
    authorName: string,
    onProgress?: (current: number, total: number, title: string) => void
): Promise<{ successCount: number; failCount: number; skipCount: number; existedCount: number }> {
    const ZoteroGlobal = ztoolkit.getGlobal("Zotero") as any;
    const libraryID = ZoteroGlobal.Libraries.userLibraryID;

    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;
    let existedCount = 0;

    // 用于去重
    const seenDois = new Set<string>();
    const seenTitleYear = new Set<string>();

    // 构建规范化标题+年份 key
    const buildTitleYearKey = (pub: DblpPublication) => {
        const t = (pub.title || '').toLowerCase().replace(/[^\w]/g, '');
        const y = pub.year || '';
        return `${t}|${y}`;
    };

    // 在 Zotero 库中按 DOI 查找已有条目
    const findExistingByDoi = async (doi: string): Promise<any> => {
        if (!doi) return null;
        try {
            const items = await ZoteroGlobal.Items.findByDOI(doi, { libraryID });
            return items.length > 0 ? items[0] : null;
        } catch {
            return null;
        }
    };

    // 在 Zotero 库中按标题+年份查找已有条目
    const findExistingByTitleYear = async (title: string, year: string): Promise<any> => {
        if (!title) return null;
        try {
            const query = `title:${JSON.stringify(title)}`;
            const items = await ZoteroGlobal.Items.search(query, { libraryID });
            return items.find((item: any) => {
                const itemYear = item.getField?.('date') || '';
                return String(itemYear).startsWith(year || '9999');
            }) || null;
        } catch {
            return null;
        }
    };

    for (let i = 0; i < publications.length; i++) {
        const pub = publications[i];
        const title = pub.title;

        if (onProgress) {
            onProgress(i + 1, publications.length, title);
        }

        if (!title) {
            skipCount++;
            continue;
        }

        const normalizedDoi = normalizeDoi(pub.doi || '');
        const titleYearKey = buildTitleYearKey(pub);

        // 批次内去重
        if (normalizedDoi) {
            if (seenDois.has(normalizedDoi)) {
                skipCount++;
                continue;
            }
            seenDois.add(normalizedDoi);
        }
        if (seenTitleYear.has(titleYearKey)) {
            skipCount++;
            continue;
        }
        seenTitleYear.add(titleYearKey);

        try {
            let existingItem: any = null;

            // 1) 先按 DOI 查找
            if (normalizedDoi) {
                existingItem = await findExistingByDoi(normalizedDoi);
            }

            // 2) 若未找到，按标题+年份查找
            if (!existingItem && pub.year) {
                existingItem = await findExistingByTitleYear(title, pub.year);
            }

            if (existingItem) {
                existedCount++;
                continue;
            }

            // 确定 itemType
            let itemType = 'journalArticle';
            if (pub.type === 'inproceedings') {
                itemType = 'conferencePaper';
            } else if (pub.type === 'book') {
                itemType = 'book';
            } else if (pub.type === 'incollection') {
                itemType = 'bookSection';
            }

            // 创建新条目
            const item: any = new ZoteroGlobal.Item(itemType);
            item.libraryID = libraryID;

            // 设置各字段
            item.setField('title', title);
            if (pub.year) item.setField('date', pub.year);
            if (pub.venue) item.setField('publicationTitle', pub.venue);
            if (normalizedDoi) item.setField('DOI', normalizedDoi);
            if (pub.ee) item.setField('url', pub.ee);
            else if (pub.url) item.setField('url', pub.url);
            if (pub.volume) item.setField('volume', pub.volume);
            if (pub.number) item.setField('issue', pub.number);
            if (pub.pages) item.setField('pages', pub.pages);
            if (pub.publisher) item.setField('publisher', pub.publisher);

            // 设置作者
            if (pub.authors && pub.authors.length > 0) {
                const creators: any[] = [];
                for (const authorName of pub.authors) {
                    const parts = authorName.trim().split(/\s+/);
                    if (parts.length >= 2) {
                        const lastName = parts[parts.length - 1];
                        const firstName = parts.slice(0, -1).join(' ');
                        creators.push({
                            creatorType: 'author',
                            firstName,
                            lastName,
                        });
                    } else if (parts.length === 1) {
                        creators.push({
                            creatorType: 'author',
                            name: authorName,
                        });
                    }
                }
                item.setCreators(creators);
            }

            await item.saveTx();
            successCount++;
            ztoolkit.log(`导入论文成功: ${title}`);

            // 触发 Sci-PDF 等 PDF 解析器自动下载 PDF（如果条目有 DOI）
            if (normalizedDoi) {
                try {
                    const ZoteroAttachments = ZoteroGlobal.Attachments as any;
                    if (ZoteroAttachments?.findAvailablePDF) {
                        await ZoteroAttachments.findAvailablePDF(item);
                        ztoolkit.log(`触发 PDF 下载: ${title}`);
                    }
                } catch (e) {
                    // PDF 下载失败不影响导入成功计数
                    ztoolkit.log(`PDF 下载触发失败: ${title}`, e);
                }
            }

        } catch (e) {
            ztoolkit.log(`导入论文失败: ${title}`, e);
            failCount++;
        }
    }

    return { successCount, failCount, skipCount, existedCount };
}

/**
 * 处理导入论文到 Zotero（带确认和状态显示）
 */
async function handleImportPapersToZotero(
    author: AuthorInfo,
    publications: DblpPublication[],
    dialog: any
): Promise<void> {
    const statusEl = dialog.window?.document.getElementById("dblp-import-status");
    const total = publications.length;

    if (total === 0) {
        if (statusEl) {
            statusEl.innerText = "⚠️ 没有可导入的论文";
            statusEl.style.color = "#f44336";
        }
        return;
    }

    // 确认提示
    const confirmed = ztoolkit.getGlobal("confirm")(
        `即将导入 ${total} 篇论文到 Zotero 库。\n\n` +
        `注意：\n` +
        `1. 已存在的论文（通过 DOI 或标题+年份判断）将被跳过\n` +
        `2. 将导入所有可用字段：标题、年份、期刊/会议、DOI、URL、作者等\n` +
        `3. 导入可能需要几分钟时间\n\n` +
        `是否继续？`
    );

    if (!confirmed) {
        return;
    }

    if (statusEl) {
        statusEl.innerText = "⏳ 正在导入论文，请稍候...";
        statusEl.style.color = "#2196F3";
    }

    try {
        const result = await importPapersToZotero(
            publications,
            author.displayName,
            (current, totalNum, title) => {
                if (statusEl) {
                    statusEl.innerText = `📥 正在导入 (${current}/${totalNum}): ${title.substring(0, 30)}...`;
                }
            }
        );

        let message = `✅ 导入完成！\n`;
        message += `成功: ${result.successCount} 篇\n`;
        if (result.existedCount > 0) {
            message += `已存在: ${result.existedCount} 篇\n`;
        }
        if (result.skipCount > 0) {
            message += `跳过: ${result.skipCount} 篇\n`;
        }
        if (result.failCount > 0) {
            message += `失败: ${result.failCount} 篇`;
        }

        if (statusEl) {
            statusEl.innerText = message.replace(/\n/g, " | ");
            statusEl.style.color = result.failCount > 0 ? "#ff9800" : "#4CAF50";
        }

        ztoolkit.getGlobal("alert")(message);

    } catch (e: any) {
        const errorMsg = e?.message || String(e);
        if (statusEl) {
            statusEl.innerText = `❌ 导入失败: ${errorMsg}`;
            statusEl.style.color = "#f44336";
        }
        ztoolkit.getGlobal("alert")(`导入失败: ${errorMsg}`);
    }
}

/**
 * 获取 DBLP 作者信息（论文数量等）
 */
async function fetchDblpAuthorInfo(pid: string): Promise<any> {
    if (!pid) return null;
    try {
        const url = `https://dblp.org/pid/${pid}.xml`;
        const resp = await fetch(url);
        if (resp.ok) {
            const text = await resp.text();
            const articleCount = (text.match(/<article/g) || []).length;
            const inprocCount = (text.match(/<inproceedings/g) || []).length;
            const totalCount = articleCount + inprocCount;

            const coauthorMatches = text.match(/<author[^>]*>([\s\S]*?)<\/author>/g) || [];
            const coauthors = [...new Set(coauthorMatches.map((m: string) =>
                m.replace(/<[^>]+>/g, '').replace(/\s+\d{4}$/, '').trim()
            ))].slice(0, 10);

            return {
                worksCount: totalCount,
                journalCount: articleCount,
                conferenceCount: inprocCount,
                coauthors: coauthors
            };
        }
    } catch (e) {
        ztoolkit.log("DBLP 作者信息获取失败:", e);
    }
    return null;
}

/**
 * 根据名字匹配 Crossref 作者和 DBLP 作者
 */
function matchCrossrefToDblp(crossrefName: string, dblpAuthors: DblpAuthorFromPub[]): DblpAuthorFromPub | null {
    const normalizedCrossref = crossrefName.toLowerCase().replace(/[^\w\s]/g, '').trim();

    for (const dblpAuthor of dblpAuthors) {
        const normalizedDblp = dblpAuthor.displayName.toLowerCase().replace(/[^\w\s]/g, '').trim();

        if (normalizedCrossref === normalizedDblp) {
            return dblpAuthor;
        }

        const crossrefParts = normalizedCrossref.split(/\s+/);
        const dblpParts = normalizedDblp.split(/\s+/);

        if (crossrefParts.length > 0 && dblpParts.length > 0) {
            const crossrefLast = crossrefParts[crossrefParts.length - 1];
            const dblpLast = dblpParts[dblpParts.length - 1];

            if (crossrefLast === dblpLast) {
                const crossrefFirst = crossrefParts[0];
                const dblpFirst = dblpParts[0];

                if (crossrefFirst[0] === dblpFirst[0]) {
                    return dblpAuthor;
                }
            }
        }
    }

    return null;
}

/**
 * 主弹窗：展示作者列表（简洁三列布局）
 */
async function showAuthorProfiles(items: any[]) {
    if (!items || items.length === 0) {
        ztoolkit.getGlobal("alert")("未找到条目！");
        return;
    }
    const item = items[0];

    const doi = item.getField && item.getField("DOI");
    const title = item.getField && item.getField("title");
    let authors: AuthorInfo[] = [];

    ztoolkit.log("论文标题:", title);
    ztoolkit.log("论文DOI:", doi);

    const dblpResult = await searchDblpPublication(title);
    const dblpAuthors = dblpResult.authors;

    ztoolkit.log("DBLP 找到作者数量:", dblpAuthors.length);

    let crossrefData: any = null;
    if (doi) {
        crossrefData = await fetchCrossrefByDoi(doi);
    }
    if (!crossrefData && title) {
        crossrefData = await fetchCrossrefByTitle(title);
    }

    if (dblpResult.found && dblpAuthors.length > 0) {
        for (const dblpAuthor of dblpAuthors) {
            let institution = "未知";
            let orcid = "";

            if (crossrefData?.authors) {
                for (const cAuthor of crossrefData.authors) {
                    const match = matchCrossrefToDblp(cAuthor.name, [dblpAuthor]);
                    if (match) {
                        institution = (cAuthor.affiliations || []).join("; ") || "未知";
                        orcid = cAuthor.orcid || "";
                        break;
                    }
                }
            }

            authors.push({
                name: dblpAuthor.name,
                displayName: dblpAuthor.displayName,
                dblpName: dblpAuthor.name,
                institution: institution,
                orcid: orcid,
                dblpPid: dblpAuthor.pid,
                dblpUrl: dblpAuthor.url
            });
        }
    } else if (crossrefData?.authors?.length > 0) {
        for (const a of crossrefData.authors) {
            authors.push({
                name: a.name,
                displayName: a.name,
                institution: (a.affiliations || []).join("; ") || "未知",
                orcid: a.orcid || '',
                dblpPid: '',
                dblpUrl: ''
            });
        }
    } else {
        const creators = item.getCreators && item.getCreators();
        if (!creators || creators.length === 0) {
            ztoolkit.getGlobal("alert")("未找到作者信息");
            return;
        }

        for (const c of creators) {
            const name = `${c.firstName || ''} ${c.lastName || ''}`.trim();
            authors.push({
                name: name,
                displayName: name,
                institution: "未知（无DOI）",
                dblpPid: '',
                dblpUrl: ''
            });
        }
    }

    // 弹窗展示 - 简洁三列布局
    const rowCount = authors.length + 2;
    const dialog = new ztoolkit.Dialog(rowCount, 3)
        .addCell(0, 0, {
            tag: "div",
            properties: { innerText: "📋 作者列表" },
            styles: {
                gridColumn: "span 3",
                textAlign: "center",
                fontSize: "16px",
                fontWeight: "600",
                padding: "14px 20px",
                color: "#1a237e",
                background: "linear-gradient(135deg, #e8eaf6 0%, #c5cae9 100%)",
                borderBottom: "2px solid #3f51b5",
                letterSpacing: "1px"
            }
        })
        // 表头
        .addCell(1, 0, {
            tag: "div", properties: { innerText: "姓名" },
            styles: {
                fontWeight: "600",
                padding: "12px 16px",
                background: "#3f51b5",
                color: "#fff",
                fontSize: "13px"
            }
        })
        .addCell(1, 1, {
            tag: "div", properties: { innerText: "所属机构" },
            styles: {
                fontWeight: "600",
                padding: "12px 16px",
                background: "#3f51b5",
                color: "#fff",
                fontSize: "13px"
            }
        })
        .addCell(1, 2, {
            tag: "div", properties: { innerText: "操作" },
            styles: {
                fontWeight: "600",
                padding: "12px 16px",
                background: "#3f51b5",
                color: "#fff",
                fontSize: "13px",
                textAlign: "center"
            }
        });

    authors.forEach((author, i) => {
        const bgColor = i % 2 === 0 ? "#ffffff" : "#f5f5f5";

        // 作者名
        dialog.addCell(i + 2, 0, {
            tag: "div",
            properties: { innerText: author.displayName },
            styles: {
                padding: "12px 16px",
                background: bgColor,
                borderBottom: "1px solid #e0e0e0",
                fontSize: "13px",
                fontWeight: "500",
                color: "#333"
            }
        });

        // 机构
        dialog.addCell(i + 2, 1, {
            tag: "div",
            properties: { innerText: author.institution },
            styles: {
                padding: "12px 16px",
                color: "#666",
                background: bgColor,
                borderBottom: "1px solid #e0e0e0",
                fontSize: "12px"
            }
        });

        // 操作按钮
        dialog.addCell(i + 2, 2, {
            tag: "button",
            namespace: "html",
            attributes: { type: "button" },
            properties: { innerText: "查看详情" },
            styles: {
                margin: "8px 12px",
                padding: "6px 16px",
                borderRadius: "4px",
                background: "#3f51b5",
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontWeight: "500",
                fontSize: "12px",
                transition: "background 0.2s"
            },
            listeners: [
                {
                    type: "click",
                    listener: () => {
                        ztoolkit.log("查看详情:", author.name, "PID:", author.dblpPid);
                        showDetailProfile(author);
                    }
                }
            ]
        });
    });
    dialog.addButton("关闭", "close");
    dialog.open("作者Profile");
}

/**
 * 详细作者Profile弹窗（专业美观版）
 */
async function showDetailProfile(author: AuthorInfo) {
    ztoolkit.log("showDetailProfile called for:", author.name, "dblpPid:", author.dblpPid);

    let dblpInfo: any = null;
    let recentPubs: DblpPublication[] = [];

    if (author.dblpPid) {
        dblpInfo = await fetchDblpAuthorInfo(author.dblpPid);
        recentPubs = await fetchDblpAuthorPublications(author.dblpPid);
    }

    const worksCount = dblpInfo?.worksCount ?? "-";
    const journalCount = dblpInfo?.journalCount ?? "-";
    const conferenceCount = dblpInfo?.conferenceCount ?? "-";
    const coauthors = dblpInfo?.coauthors?.filter((c: string) => c !== author.displayName).slice(0, 5)?.join("、") || "暂无";
    const institution = author.institution || "未知";
    const orcid = author.orcid || "";
    const dblpUrl = author.dblpUrl || (author.dblpPid ? `https://dblp.org/pid/${author.dblpPid}` : "");
    const dblpIdentifier = author.dblpName || author.displayName;

    // 构建专业详情弹窗（增加 2 行：导入按钮 + 状态提示）
    const dialog = new ztoolkit.Dialog(15, 2)
        // 标题区域
        .addCell(0, 0, {
            tag: "div",
            properties: { innerText: author.displayName },
            styles: {
                gridColumn: "span 2",
                textAlign: "center",
                fontSize: "20px",
                fontWeight: "600",
                color: "#1a237e",
                padding: "20px 24px 16px",
                background: "linear-gradient(180deg, #e8eaf6 0%, #fff 100%)",
                borderBottom: "1px solid #c5cae9",
                letterSpacing: "0.5px"
            }
        })
        // 基本信息区
        .addCell(1, 0, {
            tag: "div", properties: { innerText: "DBLP 标识" },
            styles: {
                fontWeight: "500",
                color: "#666",
                padding: "14px 20px",
                fontSize: "13px",
                background: "#fafafa",
                borderBottom: "1px solid #eee",
                width: "100px"
            }
        })
        .addCell(1, 1, {
            tag: "div", properties: { innerText: dblpIdentifier },
            styles: {
                padding: "14px 20px",
                fontSize: "13px",
                color: "#ff6f00",
                fontWeight: "600",
                background: "#fafafa",
                fontFamily: "'SF Mono', Consolas, monospace",
                borderBottom: "1px solid #eee"
            }
        })
        .addCell(2, 0, {
            tag: "div", properties: { innerText: "所属机构" },
            styles: { fontWeight: "500", color: "#666", padding: "14px 20px", fontSize: "13px", borderBottom: "1px solid #eee" }
        })
        .addCell(2, 1, {
            tag: "div", properties: { innerText: institution },
            styles: { padding: "14px 20px", fontSize: "13px", color: "#333", borderBottom: "1px solid #eee" }
        })
        // 学术统计区
        .addCell(3, 0, {
            tag: "div", properties: { innerText: "学术统计" },
            styles: {
                gridColumn: "span 2",
                fontWeight: "600",
                color: "#1a237e",
                padding: "16px 20px 12px",
                fontSize: "14px",
                background: "#f5f5f5",
                borderBottom: "1px solid #e0e0e0"
            }
        })
        .addCell(4, 0, {
            tag: "div",
            properties: { innerText: `📚 论文总数: ${worksCount}    📰 期刊: ${journalCount}    🎤 会议: ${conferenceCount}` },
            styles: {
                gridColumn: "span 2",
                padding: "12px 20px",
                fontSize: "14px",
                color: "#3f51b5",
                fontWeight: "500",
                borderBottom: "1px solid #eee",
                letterSpacing: "0.5px"
            }
        })
        .addCell(5, 0, {
            tag: "div", properties: { innerText: "主要合作者" },
            styles: { fontWeight: "500", color: "#666", padding: "14px 20px", fontSize: "13px", background: "#fafafa", borderBottom: "1px solid #eee" }
        })
        .addCell(5, 1, {
            tag: "div", properties: { innerText: coauthors },
            styles: { padding: "14px 20px", fontSize: "12px", color: "#555", background: "#fafafa", borderBottom: "1px solid #eee" }
        })
        // 外部链接区
        .addCell(6, 0, {
            tag: "div", properties: { innerText: "外部链接" },
            styles: {
                gridColumn: "span 2",
                fontWeight: "600",
                color: "#1a237e",
                padding: "16px 20px 12px",
                fontSize: "14px",
                background: "#f5f5f5",
                borderBottom: "1px solid #e0e0e0"
            }
        })
        // ORCID
        .addCell(7, 0, {
            tag: "div", properties: { innerText: "ORCID" },
            styles: { fontWeight: "500", color: "#666", padding: "14px 20px", fontSize: "13px", borderBottom: "1px solid #eee" }
        })
        .addCell(7, 1, {
            tag: "div",
            properties: { innerText: orcid || "暂无" },
            styles: {
                padding: "14px 20px",
                fontSize: "12px",
                color: orcid ? "#2e7d32" : "#999",
                borderBottom: "1px solid #eee",
                fontFamily: "'SF Mono', Consolas, monospace",
                wordBreak: "break-all",
                userSelect: "text",
                cursor: orcid ? "text" : "default"
            }
        })
        // DBLP
        .addCell(8, 0, {
            tag: "div", properties: { innerText: "DBLP 主页" },
            styles: { fontWeight: "500", color: "#666", padding: "14px 20px", fontSize: "13px", background: "#fafafa", borderBottom: "1px solid #eee" }
        })
        .addCell(8, 1, {
            tag: "div",
            properties: { innerText: dblpUrl || "暂无" },
            styles: {
                padding: "14px 20px",
                fontSize: "12px",
                color: dblpUrl ? "#1565c0" : "#999",
                background: "#fafafa",
                borderBottom: "1px solid #eee",
                fontFamily: "'SF Mono', Consolas, monospace",
                wordBreak: "break-all",
                userSelect: "text",
                cursor: dblpUrl ? "text" : "default"
            }
        })
        // 近期论文
        .addCell(9, 0, {
            tag: "div",
            properties: { innerText: "近期发表论文" },
            styles: {
                gridColumn: "span 2",
                fontWeight: "600",
                color: "#1a237e",
                padding: "16px 20px 12px",
                fontSize: "14px",
                background: "#f5f5f5",
                borderBottom: "1px solid #e0e0e0"
            }
        })
        .addCell(10, 0, {
            tag: "div",
            properties: {
                innerText: recentPubs.length > 0
                    ? recentPubs.slice(0, 5).map((p, i) => `${i + 1}. ${p.title} (${p.year || '-'})`).join('\n')
                    : "暂无数据"
            },
            styles: {
                gridColumn: "span 2",
                padding: "14px 20px",
                fontSize: "12px",
                color: "#444",
                whiteSpace: "pre-wrap",
                lineHeight: "1.9",
                background: "#fff"
            }
        })
        // 导入全部论文到 Zotero 按钮
        .addCell(11, 0, {
            tag: "button",
            namespace: "html",
            attributes: { type: "button" },
            properties: { innerText: `📥 导入全部论文到 Zotero（${recentPubs.length}篇）` },
            styles: {
                gridColumn: "span 2",
                margin: "12px 20px",
                padding: "10px 20px",
                borderRadius: "6px",
                background: "linear-gradient(135deg, #4CAF50 0%, #2E7D32 100%)",
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontWeight: "600",
                fontSize: "14px",
                transition: "all 0.2s",
                boxShadow: "0 2px 8px rgba(76, 175, 80, 0.3)",
                textAlign: "center"
            },
            listeners: [
                {
                    type: "click",
                    listener: async () => {
                        await handleImportPapersToZotero(author, recentPubs, dialog);
                    }
                }
            ]
        })
        // 导入状态提示行
        .addCell(12, 0, {
            tag: "div",
            id: "dblp-import-status",
            properties: { innerText: "" },
            styles: {
                gridColumn: "span 2",
                textAlign: "center",
                fontSize: "12px",
                color: "#666",
                padding: "6px 20px",
                background: "#fafafa",
                borderBottom: "1px solid #eee",
                minHeight: "20px"
            }
        })
        // AI 推荐 / 对话按钮
        .addCell(13, 0, {
            tag: "button",
            namespace: "html",
            attributes: { type: "button" },
            properties: { innerText: "🤖 AI 推荐 / 对话" },
            styles: {
                gridColumn: "span 2",
                margin: "12px 20px",
                padding: "10px 20px",
                borderRadius: "6px",
                background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontWeight: "600",
                fontSize: "14px",
                transition: "all 0.2s",
                boxShadow: "0 2px 8px rgba(102, 126, 234, 0.3)",
                textAlign: "center"
            },
            listeners: [
                {
                    type: "click",
                    listener: () => {
                        openAuthorAIChat(author, recentPubs, dblpInfo);
                    }
                }
            ]
        })
        // 底部
        .addCell(14, 0, {
            tag: "div",
            properties: { innerText: "数据来源: DBLP · Crossref" },
            styles: {
                gridColumn: "span 2",
                textAlign: "center",
                fontSize: "11px",
                color: "#999",
                padding: "12px",
                background: "#fafafa",
                borderTop: "1px solid #eee"
            }
        });

    dialog.addButton("关闭", "close");
    dialog.open(`${author.displayName} - 学术档案`);
}

/**
 * 调用 LLM Chat Completions（使用偏好设置中的配置）
 */
async function callLLMChat(messages: ChatMessage[]): Promise<string> {
    const config = getLLMConfig();
    if (!config.apiKey) {
        throw new Error("LLM API Key 未配置，请在插件偏好设置中设置");
    }

    // 构建 API URL
    let baseUrl = (config.baseUrl || "").trim().replace(/\/$/, "");
    if (!baseUrl) {
        // 根据提供商使用默认 URL
        switch (config.provider) {
            case "deepseek":
                baseUrl = "https://api.deepseek.com/v1";
                break;
            case "openai":
                baseUrl = "https://api.openai.com/v1";
                break;
            case "claude":
                baseUrl = "https://api.anthropic.com/v1";
                break;
            default:
                baseUrl = "https://api.deepseek.com/v1";
        }
    }

    const model = config.model || "deepseek-chat";

    const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages,
            temperature: 0.7,
        }),
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`LLM 调用失败: ${resp.status} ${resp.statusText} ${text}`);
    }

    const data: any = await resp.json();
    const content =
        data.choices?.[0]?.message?.content ??
        data.choices?.[0]?.delta?.content ??
        "";
    if (!content) {
        throw new Error("LLM 返回内容为空");
    }
    return content as string;
}

/**
 * 构造系统提示词：基于作者信息和论文，让大模型更好地做推荐
 */
function buildAuthorSystemPrompt(
    author: AuthorInfo,
    recentPubs: DblpPublication[],
    dblpInfo: any
): string {
    const pubsText =
        recentPubs.length > 0
            ? recentPubs
                .slice(0, 10)
                .map(
                    (p, i) =>
                        `${i + 1}. ${p.title} (${p.year || "-"}${p.venue ? `, ${p.venue}` : ""})`
                )
                .join("\n")
            : "暂无近期论文数据";

    const coauthors =
        dblpInfo?.coauthors?.slice(0, 10).join("、") || "未知";

    return `你是一个学术助手，负责根据作者的学术画像推荐论文和相关资源，并进行自然语言问答。

作者基本信息：
- 姓名：${author.displayName}
- 所属机构：${author.institution || "未知"}
- ORCID：${author.orcid || "未知"}
- DBLP 标识：${author.dblpName || author.displayName}
- 论文总数：${dblpInfo?.worksCount ?? "-"}（期刊：${dblpInfo?.journalCount ?? "-"}，会议：${dblpInfo?.conferenceCount ?? "-"}）
- 主要合作者：${coauthors}

近期论文（用于理解研究方向）：
${pubsText}

你的能力：
1. 主动基于以上信息推荐 5~10 篇重要或相关论文（可包含经典文献与最新进展），并说明推荐理由；
2. 推荐 3~5 个相关资源，如：数据集、科研工具、重要会议、期刊等；
3. 支持用户用自然语言继续追问，例如“再推荐几篇开源数据集的论文”“帮我总结研究方向”等；
4. 回答要尽量给出 title、作者、年份和大致来源（期刊、会议或 arXiv），并尽量附带 DOI 或可访问的链接（如果你知道的话）。

回答风格：
- 用中文回答；
- 分点列出推荐论文与资源；`;
}

/**
 * 打开“作者 AI 对话”窗口：
 * 1）加载时自动向 DeepSeek 发送一个“请基于作者信息推荐论文/资源”的问题；
 * 2）用户可以继续在下方输入框进行对话。
 */
async function openAuthorAIChat(
    author: AuthorInfo,
    recentPubs: DblpPublication[],
    dblpInfo: any
) {
    const dialog = new ztoolkit.Dialog(1, 1);
    dialog.addCell(
        0,
        0,
        {
            tag: "div",
            namespace: "html",
            id: "author-ai-chat-root",
            styles: {
                width: "780px",
                height: "560px",
                padding: "0",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                fontFamily:
                    "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
                fontSize: "13px",
                color: "#222",
            },
        },
        true
    );

    dialog.setDialogData({
        loadCallback: async () => {
            const win = dialog.window;
            const doc = win.document;
            const root = doc.getElementById(
                "author-ai-chat-root"
            ) as HTMLElement | null;
            if (!root) return;

            root.innerHTML = `
<div style="display:flex; flex-direction:column; height:100%;">
  <div style="padding:10px 14px; border-bottom:1px solid #e0e0e0; background:#f5f5f5;">
    <div style="font-weight:600; color:#1a237e; font-size:14px;">🤖 作者 AI 助手 - ${author.displayName}</div>
    <div style="font-size:12px; color:#555; margin-top:4px;">支持自动推荐论文/资源，也可以直接提问，例如“帮我推荐几篇代表作”“再推荐一些相关数据集”等。</div>
  </div>
  <div id="author-ai-chat-history" style="flex:1; padding:10px 14px; overflow:auto; background:#fafafa;"></div>
  <div style="border-top:1px solid #e0e0e0; padding:8px 10px; background:#fff;">
    <textarea id="author-ai-chat-input" rows="3"
      style="width:100%; box-sizing:border-box; resize:vertical; font-size:13px; padding:6px 8px;"></textarea>
    <div style="margin-top:6px; display:flex; justify-content:flex-end; gap:8px;">
      <button id="author-ai-chat-ask-rec" style="padding:4px 10px;">自动推荐论文/资源</button>
      <button id="author-ai-chat-send" style="padding:4px 12px; font-weight:600;">发送</button>
    </div>
  </div>
</div>`;

            const historyEl = doc.getElementById(
                "author-ai-chat-history"
            ) as HTMLElement | null;
            const inputEl = doc.getElementById(
                "author-ai-chat-input"
            ) as HTMLTextAreaElement | null;
            const sendBtn = doc.getElementById(
                "author-ai-chat-send"
            ) as HTMLButtonElement | null;
            const askRecBtn = doc.getElementById(
                "author-ai-chat-ask-rec"
            ) as HTMLButtonElement | null;

            if (!historyEl || !inputEl || !sendBtn || !askRecBtn) {
                ztoolkit.log("author-ai-chat DOM not ready");
                return;
            }

            const messages: ChatMessage[] = [
                {
                    role: "system",
                    content: buildAuthorSystemPrompt(author, recentPubs, dblpInfo),
                },
            ];

            function appendBubble(role: ChatRole, content: string) {
                const wrap = doc.createElement("div");
                wrap.style.marginBottom = "10px";
                wrap.style.display = "flex";
                wrap.style.justifyContent =
                    role === "user" ? "flex-end" : "flex-start";

                const bubble = doc.createElement("div");
                bubble.style.maxWidth = "80%";
                bubble.style.padding = "8px 10px";
                bubble.style.borderRadius = "8px";
                bubble.style.whiteSpace = "pre-wrap";
                bubble.style.lineHeight = "1.5";
                bubble.style.fontSize = "13px";
                bubble.style.boxShadow = "0 1px 2px rgba(0,0,0,0.08)";

                if (role === "user") {
                    bubble.style.background = "#e3f2fd";
                    bubble.style.color = "#0d47a1";
                } else {
                    bubble.style.background = "#ffffff";
                    bubble.style.color = "#333333";
                }

                bubble.textContent = content;
                wrap.appendChild(bubble);
                historyEl!.appendChild(wrap);
                historyEl!.scrollTop = historyEl!.scrollHeight;
            }

            let sending = false;

            async function sendUserMessage(query: string) {
                if (!query.trim() || sending) return;
                sending = true;

                const text = query.trim();
                appendBubble("user", text);
                inputEl!.value = "";

                messages.push({ role: "user", content: text });

                const loadingText = "🤖 正在思考中，请稍候…";
                appendBubble("assistant", loadingText);
                const loadingNode = historyEl!.lastElementChild as HTMLElement | null;

                try {
                    const reply = await callLLMChat(messages);
                    if (loadingNode && loadingNode.parentElement === historyEl) {
                        historyEl!.removeChild(loadingNode);
                    }
                    appendBubble("assistant", reply);
                    messages.push({ role: "assistant", content: reply });
                } catch (e: any) {
                    if (loadingNode && loadingNode.parentElement === historyEl) {
                        historyEl!.removeChild(loadingNode);
                    }
                    const msg = e?.message || String(e);
                    appendBubble("assistant", `调用大模型失败：${msg}`);
                    ztoolkit.log("DeepSeek 调用失败:", e);
                } finally {
                    sending = false;
                }
            }

            sendBtn.addEventListener("click", () => {
                sendUserMessage(inputEl.value);
            });

            inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
                if (ev.key === "Enter" && !ev.shiftKey) {
                    ev.preventDefault();
                    sendUserMessage(inputEl.value);
                }
            });

            askRecBtn.addEventListener("click", () => {
                sendUserMessage(
                    "请基于上面的作者信息，推荐 5~10 篇代表性或相关论文，并推荐 3~5 个相关的研究资源（如数据集、工具、重要期刊或会议），用中文分点列出，并简要说明推荐理由。"
                );
            });

            // 打开窗口后自动触发一次推荐
            win.setTimeout(() => {
                askRecBtn.click();
            }, 200);
        },
    });

    dialog.addButton("关闭", "close");
    dialog.open(`${author.displayName} - AI 对话`, {
        width: 820,
        height: 640,
        resizable: true,
        centerscreen: true,
        noDialogMode: true,
    });
}

// ─── 向量索引功能 ─────────────────────────────────────────────

/**
 * 注册"构建向量索引"右键菜单
 */
export function registerVectorIndexMenu() {
    if (ztoolkit.Menu.unregister) {
        ztoolkit.Menu.unregister("context-build-vector-index");
    }
    ztoolkit.Menu.register("item", {
        tag: "menuitem",
        id: "context-build-vector-index",
        label: "构建向量索引",
        commandListener: () => {
            const pane = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
            const items = pane ? pane.getSelectedItems() : [];
            buildVectorIndexForItems(items as Zotero.Item[]);
        }
    });
}

/**
 * 构建向量索引主流程
 */
async function buildVectorIndexForItems(items: Zotero.Item[]) {
    if (!items || items.length === 0) {
        ztoolkit.getGlobal("alert")("请先选择论文条目");
        return;
    }

    // 过滤出有 PDF 附件的论文条目
    const itemsWithPdf: Array<{ item: Zotero.Item; pdfBase64: string }> = [];
    for (const item of items) {
        if (!item.isRegularItem()) continue;
        const itemType = item.itemType;
        if (itemType !== "journalArticle" && itemType !== "conferencePaper" &&
            itemType !== "book" && itemType !== "bookSection") continue;

        const pdfBase64 = await getItemPdfBase64(item);
        if (pdfBase64) {
            itemsWithPdf.push({ item, pdfBase64 });
        }
    }

    if (itemsWithPdf.length === 0) {
        ztoolkit.getGlobal("alert")("所选条目中没有找到 PDF 附件");
        return;
    }

    // 显示进度对话框
    const total = itemsWithPdf.length;
    let success = 0;
    let failed = 0;
    const failedTitles: string[] = [];

    for (let i = 0; i < itemsWithPdf.length; i++) {
        const { item, pdfBase64 } = itemsWithPdf[i];
        const title = item.getField("title") as string || "未知标题";

        ztoolkit.log(`[VectorIndex] 正在索引 [${i + 1}/${total}]: ${title}`);

        try {
            const result = await importPdfToVectorIndex(item, pdfBase64, `paper_${item.id}`);
            if (result.success) {
                success++;
                ztoolkit.log(`[VectorIndex] ✅ 成功: ${title} (${result.chunks} chunks)`);
            } else {
                failed++;
                failedTitles.push(`${title}: ${result.error}`);
                ztoolkit.log(`[VectorIndex] ❌ 失败: ${title} - ${result.error}`);
            }
        } catch (e) {
            failed++;
            failedTitles.push(`${title}: ${String(e)}`);
            ztoolkit.log(`[VectorIndex] ❌ 异常: ${title} - ${e}`);
        }
    }

    // 显示结果
    let message = `✅ 向量索引构建完成！\n\n成功: ${success} 篇\n失败: ${failed} 篇`;
    if (failedTitles.length > 0) {
        message += `\n\n失败详情:\n${failedTitles.slice(0, 5).join('\n')}${failedTitles.length > 5 ? '\n...' : ''}`;
    }
    ztoolkit.getGlobal("alert")(message);
}

/**
 * 获取论文条目的 PDF 附件并转为 Base64
 */
async function getItemPdfBase64(item: Zotero.Item): Promise<string | null> {
    try {
        // 获取附件
        const attachments = await item.getAttachments();
        if (!attachments || attachments.length === 0) {
            ztoolkit.log(`[VectorIndex] 条目没有附件: ${item.id}`);
            return null;
        }

        // 查找 PDF 附件
        for (const attId of attachments) {
            const att = await Zotero.Items.get(attId);
            if (!att) continue;

            // 检查是否是 PDF
            const mimeType = att.attachmentMIMEType || "";
            if (mimeType !== "application/pdf") continue;

            // 获取 PDF 文件路径
            const localPath = att.getFilePath();
            if (!localPath) {
                ztoolkit.log(`[VectorIndex] 附件没有本地路径: ${attId}`);
                continue;
            }

            // 读取文件并转为 Base64
            const base64 = await readFileAsBase64(localPath);
            ztoolkit.log(`[VectorIndex] 读取 PDF: ${localPath} (${Math.round(base64.length / 1024)} KB)`);
            return base64;
        }

        ztoolkit.log(`[VectorIndex] 没有找到 PDF 附件: ${item.id}`);
        return null;
    } catch (e) {
        ztoolkit.log(`[VectorIndex] 获取 PDF 失败: ${item.id} - ${e}`);
        return null;
    }
}

/**
 * 将本地文件读取为 Base64
 */
async function readFileAsBase64(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        try {
            const file = Components.classes["@mozilla.org/file/local;1"]
                .createInstance(Components.interfaces.nsIFile);
            file.initWithPath(filePath);

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

/**
 * 调用后端 API 将 PDF 导入到向量索引
 */
async function importPdfToVectorIndex(
    item: Zotero.Item,
    pdfBase64: string,
    source: string
): Promise<{ success: boolean; chunks?: number; error?: string }> {
    try {
        const serverUrl = getServerUrl();
        const endpoint = `${serverUrl}/kb/import/document`;

        const title = item.getField("title") as string || source;
        const doi = item.getField("DOI") as string || "";
        const year = item.getField("year") as string || "";
        const authors = item.getCreators().map(c => `${c.firstName || ''} ${c.lastName || ''}`).join(', ');

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                source: source,
                file_base64: pdfBase64,
                doc_type: "paper",
                title: title,
                chunk_size: 500,
                chunk_overlap: 100,
                metadata: {
                    doi: doi,
                    year: year,
                    authors: authors,
                    zotero_item_id: item.id,
                }
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `HTTP ${response.status}: ${errorText}` };
        }

        const result = await response.json();
        if (result.success) {
            return {
                success: true,
                chunks: result.chunks || 0,
            };
        } else {
            return { success: false, error: result.error || "未知错误" };
        }
    } catch (e) {
        return { success: false, error: `连接失败: ${String(e)}` };
    }
}

/**
 * 获取服务器 URL
 */
function getServerUrl(): string {
    const { getPref } = require("./preferenceScript");
    const pref = getPref("serverUrl" as any) as string;
    return pref || "http://zotero-fill.local:8001";
}

