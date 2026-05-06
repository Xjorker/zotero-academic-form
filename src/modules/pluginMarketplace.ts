import { getString } from "../utils/locale";

const { AddonManager } = ChromeUtils.import(
    "resource://gre/modules/AddonManager.jsm",
);
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

interface MarketplacePlugin {
    id: string;
    name: string;
    version: string;
    xpi_url: string;
    description?: string;
    minZotero?: string;
    maxZotero?: string;
}

interface MarketplaceManifest {
    plugins: MarketplacePlugin[];
}

// 说明：用户要求不做“插件市场清单地址”，仅支持从本地选择 .xpi 直接安装。

function isCompatible(entry: MarketplacePlugin): boolean {
    const current = Zotero.version || "0.0.0";
    const vc = Services.vc;
    if (entry.minZotero && vc.compare(current, entry.minZotero) < 0) {
        return false;
    }
    if (entry.maxZotero && entry.maxZotero !== "*" && entry.maxZotero !== "7.*") {
        // 将通配符简单替换，避免抛异常
        const max = entry.maxZotero.replace("*", "99");
        if (vc.compare(current, max) > 0) {
            return false;
        }
    }
    return true;
}

async function isInstalledLatest(entry: MarketplacePlugin): Promise<boolean> {
    const existing = await AddonManager.getAddonByID(entry.id).catch(() => null);
    if (!existing) return false;
    const cmp = Services.vc.compare(existing.version, entry.version);
    return cmp >= 0;
}

async function installAddon(entry: MarketplacePlugin): Promise<boolean> {
    const install = await AddonManager.getInstallForURL(entry.xpi_url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });

    return await new Promise<boolean>((resolve) => {
        install.addListener({
            onDownloadFailed() {
                resolve(false);
            },
            onInstallFailed() {
                resolve(false);
            },
            onInstallEnded() {
                resolve(true);
            },
        });
        install.install();
    });
}

async function promptAndInstall(entries: MarketplacePlugin[]) {
    const win = Zotero.getMainWindow();
    const listText = entries
        .map(
            (p) =>
                `${p.name} (${p.version})\n${p.description || getString("startup-begin")}`,
        )
        .join("\n\n");

    const button = Services.prompt.confirmEx(
        win,
        "插件安装确认",
        `将为你安装/更新以下插件：\n\n${listText}\n\n是否继续？`,
        Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
        Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING,
        "开始安装",
        "取消",
        null,
        null,
        {},
    );

    if (button !== 0) {
        return;
    }

    const progress = new ztoolkit.ProgressWindow(
        addon.data.config.addonName || "Plugin Marketplace",
        { closeOnClick: true },
    ).createLine({
        text: "准备安装插件……",
        progress: 0,
        type: "default",
    });
    progress.show();

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const percent = Math.round(((i + 1) / entries.length) * 100);
        progress.changeLine({
            text: `安装 ${entry.name} (${entry.version})`,
            progress: percent,
            type: "default",
        });
        const ok = await installAddon(entry);
        progress.changeLine({
            text: ok
                ? `已安装/更新：${entry.name}`
                : `安装失败：${entry.name}`,
            progress: percent,
            type: ok ? "success" : "warning",
        });
        await Zotero.Promise.delay(300);
    }
    progress.startCloseTimer(2000);
}

export async function openPluginMarketplace() {
    ztoolkit.getGlobal("alert")(
        "已关闭远程清单模式。请在偏好设置页使用“选择 XPI 并安装”。",
    );
}

export function registerPluginMarketplaceMenu() {
    // 挂在 File 菜单下，如需调整可改为 Tools 菜单
    ztoolkit.Menu.register("menuFile", {
        tag: "menuseparator",
        id: "zotero-plugin-marketplace-sep",
    });
    ztoolkit.Menu.register("menuFile", {
        tag: "menuitem",
        id: "zotero-plugin-marketplace-entry",
        label: "插件市场（安装依赖）",
        commandListener: () => openPluginMarketplace(),
    });
}

export async function installAddonFromXpiPicker(win?: Window): Promise<boolean> {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    const targetWin = win || Zotero.getMainWindow();
    // 将 Window 转换为 BrowsingContext
    const browsingContext = (targetWin as any).docShell?.browsingContext || null;
    picker.init(
        browsingContext,
        "选择要安装的 XPI 文件",
        Ci.nsIFilePicker.modeOpen,
    );
    picker.appendFilter("Zotero/Firefox 插件包 (*.xpi)", "*.xpi");
    // filterAll 可能不存在，检查后再使用
    if (Ci.nsIFilePicker.filterAll !== undefined) {
        picker.appendFilters(Ci.nsIFilePicker.filterAll);
    }

    const rv = await new Promise<number>((resolve) => {
        // older/compat: open(callback)
        picker.open((result: number) => resolve(result));
    });
    if (rv !== Ci.nsIFilePicker.returnOK || !picker.file) {
        return false;
    }

    const file = picker.file;
    const install = await AddonManager.getInstallForFile(file);

    const ok = await new Promise<boolean>((resolve) => {
        install.addListener({
            onInstallEnded(_install: any, addon: any) {
                ztoolkit.log("XPI 安装成功:", addon?.id || addon?.name || "");
                resolve(true);
            },
            onInstallFailed() {
                resolve(false);
            },
        });
        install.install();
    });

    if (ok) {
        // 很多插件需要重启才能完全生效
        try {
            const button = Services.prompt.confirmEx(
                Zotero.getMainWindow(),
                "安装完成",
                "插件已安装/更新。部分插件可能需要重启 Zotero 才能生效。\n\n现在重启吗？",
                Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
                Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING,
                "现在重启",
                "稍后重启",
                null,
                null,
                {},
            );
            if (button === 0) {
                Services.startup.quit(
                    Services.startup.eAttemptQuit | Services.startup.eRestart,
                );
            }
        } catch (e) {
            // ignore
        }
    }

    return ok;
}

