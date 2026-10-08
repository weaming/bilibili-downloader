import type { DownloadResponse, RuntimeMessage } from "../shared/types";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRuntimeMessage(message: unknown): message is RuntimeMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as {
    type?: unknown;
    url?: unknown;
    filename?: unknown;
  };
  if (candidate.type === "start-download") {
    return true;
  }

  return (
    candidate.type === "download-direct" &&
    typeof candidate.url === "string" &&
    (candidate.filename === undefined || typeof candidate.filename === "string")
  );
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("无法获取当前标签页");
  }
  return tab;
}

async function handleMessage(message: RuntimeMessage): Promise<DownloadResponse> {
  if (message.type === "download-direct") {
    const id = await chrome.downloads.download({
      url: message.url,
      filename: message.filename || "video.mp4",
      saveAs: false
    });
    return { ok: true, id };
  }

  if (message.type !== "start-download") {
    throw new Error("不支持的运行时消息");
  }

  const tab = await getActiveTab();
  if (!/bilibili\.com\/video\//i.test(tab.url!)) {
    return { ok: false, error: "请在 B 站视频页使用" };
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    files: ["content_merge.js"],
    world: "MAIN"
  });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRuntimeMessage(message)) {
    return false;
  }

  void handleMessage(message)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ ok: false, error: getErrorMessage(error) }));

  return true;
});
