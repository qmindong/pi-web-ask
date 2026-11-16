/* pi-web-ask background：只负责开侧边栏 + 把选中文字带过去 */

async function openSidebar() {
  try {
    await browser.sidebarAction.open();
  } catch (e) {
    console.error("pi-web-ask: 无法打开侧边栏", e);
  }
  // 侧边栏可能刚创建，稍等一下再发消息
  setTimeout(async () => {
    try {
      await browser.runtime.sendMessage({ type: "pi-web-ask:focus" });
    } catch {
      /* 侧边栏还没起来就算了 */
    }
  }, 150);
}

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd === "ask-pi") await openSidebar();
});

browser.browserAction.onClicked.addListener(async () => {
  try {
    await browser.sidebarAction.toggle();
  } catch {
    await openSidebar();
  }
});

browser.menus.create(
  {
    id: "pi-ask-selection",
    title: "用 pi 问这段…",
    contexts: ["selection"],
  },
  () => void browser.runtime.lastError
);

browser.menus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "pi-ask-selection") return;
  await openSidebar();
});
