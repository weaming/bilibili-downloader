import {
  getDownloadPageKey,
  getDownloadStatusKey,
  type DownloadResponse,
  type DownloadStatus,
  type RuntimeMessage
} from "../shared/types";

const DIRECT_DOWNLOAD_KEY_PREFIX = "vd_direct:";

interface DirectDownloadRecord {
  tabId: number;
  filename: string;
  pageKey: string;
}

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
    status?: unknown;
  };
  if (candidate.type === "start-download") {
    return true;
  }

  if (candidate.type === "status-update") {
    const status = candidate.status as Partial<DownloadStatus> | undefined;
    return Boolean(
      status &&
        typeof status.step === "string" &&
        typeof status.progress === "number" &&
        Number.isFinite(status.progress) &&
        typeof status.detail === "string"
    );
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

async function saveTabStatus(tabId: number, status: DownloadStatus): Promise<void> {
  const statusKey = getDownloadStatusKey(tabId);
  const currentResult = await chrome.storage.session.get(statusKey);
  const currentStatus = currentResult[statusKey] as DownloadStatus | undefined;
  if ((currentStatus?.done || currentStatus?.error) && !status.done && !status.error) {
    return;
  }

  await chrome.storage.session.set({
    [statusKey]: { ...status, ts: Date.now() }
  });
}

function getDirectDownloadKey(downloadId: number): string {
  return `${DIRECT_DOWNLOAD_KEY_PREFIX}${downloadId}`;
}

async function saveDirectDownloadRecord(downloadId: number, record: DirectDownloadRecord): Promise<void> {
  try {
    await chrome.storage.session.set({ [getDirectDownloadKey(downloadId)]: record });
  } catch (error: unknown) {
    console.warn("保存浏览器下载记录失败", error);
  }
}

async function finalizeDirectDownload(downloadId: number, state: "complete" | "interrupted"): Promise<void> {
  const recordKey = getDirectDownloadKey(downloadId);
  const result = await chrome.storage.session.get(recordKey);
  const record = result[recordKey] as DirectDownloadRecord | undefined;
  if (!record) {
    return;
  }

  const isComplete = state === "complete";
  await saveTabStatus(record.tabId, {
    step: isComplete ? "下载完成" : "下载失败",
    progress: isComplete ? 100 : 0,
    detail: isComplete
      ? `文件 ${record.filename} 已完成浏览器下载`
      : `文件 ${record.filename} 的浏览器下载被中断`,
    pageKey: record.pageKey,
    done: isComplete,
    error: !isComplete,
    filename: record.filename
  });
  await chrome.storage.session.remove(recordKey);
}

async function handleMessage(
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender
): Promise<DownloadResponse> {
  if (message.type === "status-update") {
    if (sender.tab?.id === undefined) {
      return { ok: false, error: "无法确定下载所属标签页" };
    }

    await saveTabStatus(sender.tab.id, message.status);
    return { ok: true };
  }

  if (message.type === "download-direct") {
    const id = await chrome.downloads.download({
      url: message.url,
      filename: message.filename || "video.mp4",
      conflictAction: "uniquify",
      saveAs: false
    });
    if (sender.tab?.id !== undefined) {
      await saveDirectDownloadRecord(id, {
        tabId: sender.tab.id,
        filename: message.filename || "video.mp4",
        pageKey: getDownloadPageKey(sender.tab.url || "")
      });

      const [download] = await chrome.downloads.search({ id });
      if (download?.state === "complete" || download?.state === "interrupted") {
        await finalizeDirectDownload(id, download.state);
      }
    }
    return { ok: true, id };
  }

  if (message.type !== "start-download") {
    throw new Error("不支持的运行时消息");
  }

  const tab = await getActiveTab();
  if (!/bilibili\.com\/(video|bangumi\/play)\//i.test(tab.url!)) {
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

  void handleMessage(message, _sender)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ ok: false, error: getErrorMessage(error) }));

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const allState = await chrome.storage.session.get(null);
    const directKeys = Object.entries(allState)
      .filter(([key, value]) => {
        const record = value as Partial<DirectDownloadRecord>;
        return key.startsWith(DIRECT_DOWNLOAD_KEY_PREFIX) && record.tabId === tabId;
      })
      .map(([key]) => key);

    await chrome.storage.session.remove([getDownloadStatusKey(tabId), ...directKeys]);
  })().catch((error: unknown) => {
    console.warn("清理标签页下载状态失败", error);
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") {
    return;
  }

  void finalizeDirectDownload(delta.id, state).catch((error: unknown) => {
    console.warn("更新浏览器下载状态失败", error);
  });
});
