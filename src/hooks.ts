import {
  BasicExampleFactory,
  KeyExampleFactory,
  UIExampleFactory,
} from "./modules/examples";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { registerAuthorProfileMenu, registerVectorIndexMenu } from "./modules/authorProfile";
import { registerAcademicFormMenu } from "./modules/academicForm";
import { initDatabase } from "./modules/database";
async function onStartup() {
  Zotero.debug("[AcademicForm] 插件启动 onStartup 开始...");

  // 等待 Zotero 核心初始化完成
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  Zotero.debug("[AcademicForm] Zotero 核心初始化完成，准备初始化数据库...");

  // 初始化数据库并捕获可能的错误
  try {
    await initDatabase();
    Zotero.debug("[AcademicForm] 数据库初始化完成 ✅");
  } catch (err) {
    Zotero.debug("[AcademicForm] 数据库初始化失败 ❌: " + String(err));
  }

  // 初始化语言本地化
  initLocale();

  // 注册作者Profile右键菜单
  registerAuthorProfileMenu();

  // 注册构建向量索引右键菜单
  registerVectorIndexMenu();

  // 注册学术成果填表右键菜单
  registerAcademicFormMenu();

  // 注册示例相关功能（保留必要部分）
  BasicExampleFactory.registerPrefs();
  BasicExampleFactory.registerNotifier();
  KeyExampleFactory.registerShortcuts();

  // 主窗口加载钩子
  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win))
  );

  // 标记插件已初始化
  addon.data.initialized = true;
  Zotero.debug("[AcademicForm] onStartup 执行完毕，插件初始化完成 🎉");
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: getString("startup-begin"),
      type: "default",
      progress: 0,
    })
    .show();

  await Zotero.Promise.delay(1000);
  popupWin.changeLine({
    progress: 30,
    text: `[30%] ${getString("startup-begin")}`,
  });

  UIExampleFactory.registerStyleSheet(win);

  // 不再调用 registerRightClickMenuItem 和 registerRightClickMenuPopup
  // 不再调用 registerWindowMenuWithSeparator（移除文件菜单中的示例菜单）

  // 不再调用 PromptExampleFactory 里的 NormalCommandExample/Anonymous/Conditional
  await Zotero.Promise.delay(1000);

  popupWin.changeLine({
    progress: 100,
    text: `[100%] ${getString("startup-finish")}`,
  });
  popupWin.startCloseTimer(5000);

  // 禁用 Dialog Example 弹窗
  // addon.hooks.onDialogEvents("dialogExample");
}


async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this funcion clear.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // You can add your code to the corresponding notify type
  ztoolkit.log("notify", event, type, ids, extraData);
  if (
    event == "select" &&
    type == "tab" &&
    extraData[ids[0]].type == "reader"
  ) {
    BasicExampleFactory.exampleNotifierCallback();
  } else {
    return;
  }
}

/**
 * This function is just an example of dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this funcion clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(type: string) {
  switch (type) {
    case "larger":
      KeyExampleFactory.exampleShortcutLargerCallback();
      break;
    case "smaller":
      KeyExampleFactory.exampleShortcutSmallerCallback();
      break;
    default:
      break;
  }
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
};
