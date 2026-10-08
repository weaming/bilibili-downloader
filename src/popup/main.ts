import type { DownloadStatus } from "../shared/types";

const sendButtonElement = document.querySelector<HTMLButtonElement>("#send");
const messageElementElement = document.querySelector<HTMLDivElement>("#msg");
const statusElementElement = document.querySelector<HTMLDivElement>("#status");

if (!sendButtonElement || !messageElementElement || !statusElementElement) {
  throw new Error("弹窗页面缺少必要元素");
}

const sendButton = sendButtonElement;
const messageElement = messageElementElement;
const statusElement = statusElementElement;

function setMessage(message: string): void {
  messageElement.textContent = message;
}

function isSupportedVideoPage(url: string | undefined): boolean {
  return Boolean(url && /(bilibili\.com\/video\/|youtube\.com\/watch)/i.test(url));
}

async function startDownload(): Promise<void> {
  sendButton.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!isSupportedVideoPage(tab?.url)) {
      setMessage("请在 B 站或 YouTube 视频播放页使用");
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ["content_bridge.js"],
      world: "ISOLATED"
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ["ffmpeg/ffmpeg.js"],
      world: "MAIN"
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: (workerUrl: string, coreUrl: string, wasmUrl: string) => {
        window.__FFMPEG_CLASS_WORKER_URL__ = workerUrl;
        window.__FFMPEG_CORE_URL__ = coreUrl;
        window.__FFMPEG_WASM_URL__ = wasmUrl;
      },
      args: [
        chrome.runtime.getURL("ffmpeg/ffmpeg.worker.js"),
        chrome.runtime.getURL("ffmpeg/ffmpeg-core.js"),
        chrome.runtime.getURL("ffmpeg/ffmpeg-core.wasm")
      ],
      world: "MAIN"
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ["content_merge.js"],
      world: "MAIN"
    });
    setMessage("已启动下载");
  } catch (error: unknown) {
    setMessage(`启动失败: ${error instanceof Error ? error.message : "未知错误"}`);
  } finally {
    sendButton.disabled = false;
  }
}

function formatStatus(status: DownloadStatus): string {
  const progress = status.progress != null ? ` - 进度 ${status.progress}%` : "";
  const detail = status.detail ? ` - ${status.detail}` : "";
  return `${status.step || ""}${progress}${detail}`;
}

async function updateStatus(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get("vd_status");
    const status = result.vd_status as DownloadStatus | undefined;
    if (!status) {
      return false;
    }

    statusElement.textContent = formatStatus(status);
    return Boolean(status.done || status.error);
  } catch (error: unknown) {
    console.warn("读取下载状态失败", error);
    return false;
  }
}

sendButton.addEventListener("click", () => {
  void startDownload();
});

const statusTimer = window.setInterval(() => {
  void updateStatus().then((isFinished) => {
    if (isFinished) {
      window.clearInterval(statusTimer);
    }
  });
}, 1000);
