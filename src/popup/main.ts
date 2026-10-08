import {
  getDownloadPageKey,
  getDownloadStatusKey,
  type DownloadMode,
  type DownloadStatus
} from "../shared/types";

const STATUS_TTL_MS = 10 * 60 * 1000;
const SUBTITLE_CACHE_TTL_MS = 5 * 60 * 1000;

const sendButtonElement = document.querySelector<HTMLButtonElement>("#send");
const audioButtonElement = document.querySelector<HTMLButtonElement>("#audio");
const subtitleButtonElement = document.querySelector<HTMLButtonElement>("#subtitle");
const actionsElement = document.querySelector<HTMLDivElement>("#actions");
const pageStateElement = document.querySelector<HTMLDivElement>("#page-state");
const descriptionElement = document.querySelector<HTMLParagraphElement>("#description");
const messageElementElement = document.querySelector<HTMLDivElement>("#msg");
const statusElementElement = document.querySelector<HTMLDivElement>("#status");

if (
  !sendButtonElement ||
  !audioButtonElement ||
  !subtitleButtonElement ||
  !actionsElement ||
  !pageStateElement ||
  !descriptionElement ||
  !messageElementElement ||
  !statusElementElement
) {
  throw new Error("弹窗页面缺少必要元素");
}

const sendButton = sendButtonElement;
const audioButton = audioButtonElement;
const subtitleButton = subtitleButtonElement;
const actions = actionsElement;
const pageState = pageStateElement;
const description = descriptionElement;
const messageElement = messageElementElement;
const statusElement = statusElementElement;

function setMessage(message: string): void {
  messageElement.textContent = message;
}

function clearStatus(): void {
  statusElement.textContent = "";
  statusElement.removeAttribute("data-state");
}

type PageKind = "bilibili" | "unsupported";

function isBilibiliPage(url: string | undefined): boolean {
  return Boolean(url && /bilibili\.com\/(video|bangumi\/play)\//i.test(url));
}

function getPageKind(url: string | undefined): PageKind {
  if (isBilibiliPage(url)) {
    return "bilibili";
  }
  return "unsupported";
}

function applyPageState(pageKind: PageKind): void {
  pageState.dataset.state = pageKind;
  if (pageKind !== "bilibili") {
    subtitleButton.hidden = true;
  }
  actions.hidden = pageKind === "unsupported";

  if (pageKind === "bilibili") {
    pageState.textContent = "B 站视频页面";
    description.textContent = "按当前播放清晰度下载视频，或导出 M4A 音频。";
    return;
  }

  pageState.textContent = "当前页面不支持";
  description.textContent = "请打开 B 站视频播放页后使用下载功能。";
  clearStatus();
  setMessage("");
}

function isSupportedVideoPage(url: string | undefined): boolean {
  return getPageKind(url) !== "unsupported";
}

interface SubtitleProbeResult {
  known: boolean;
  hasSubtitle: boolean;
  content?: string;
  error?: string;
}

interface SubtitleCacheEntry {
  result: SubtitleProbeResult;
  expiresAt: number;
}

const subtitleCache = new Map<string, SubtitleCacheEntry>();

async function getPageSubtitle(includeContent: boolean): Promise<SubtitleProbeResult> {
  const pageKey = `${location.pathname}${location.search}`;
  const captured = window.__BILI_PLAYER_CONTEXT__;
  let aid = captured?.pageKey === pageKey ? captured.aid : undefined;
  let cid = captured?.pageKey === pageKey ? captured.cid : undefined;
  const bvid = location.pathname.match(/\/video\/(BV[\w]+)/i)?.[1];
  const aidFromPath = location.pathname.match(/\/video\/av(\d+)/i)?.[1];

  if ((!cid || !aid) && (bvid || aidFromPath)) {
    const viewParams = new URLSearchParams(bvid ? { bvid } : { aid: aidFromPath! });
    const viewResponse = await fetch(`https://api.bilibili.com/x/web-interface/view?${viewParams}`, {
      credentials: "include"
    });
    if (!viewResponse.ok) {
      throw new Error(`获取视频信息失败: ${viewResponse.status}`);
    }

    const viewData = (await viewResponse.json()) as {
      data?: { aid?: number; cid?: number; pages?: Array<{ cid?: number }> };
    };
    aid ||= viewData.data?.aid;
    if (!cid) {
      const pageNumber = Number(new URLSearchParams(location.search).get("p")) || 1;
      cid = viewData.data?.pages?.[pageNumber - 1]?.cid || viewData.data?.cid;
    }
  }

  if (!cid || !aid) {
    return { known: false, hasSubtitle: false, error: "暂未获取到当前视频的字幕信息" };
  }

  const playerResponse = await fetch(`https://api.bilibili.com/x/player/v2?cid=${cid}&aid=${aid}`, {
    credentials: "include"
  });
  if (!playerResponse.ok) {
    throw new Error(`获取字幕信息失败: ${playerResponse.status}`);
  }

  const playerData = (await playerResponse.json()) as {
    code?: number;
    data?: { subtitle?: { subtitles?: Array<{ subtitle_url?: string }> } };
  };
  if (playerData.code !== undefined && playerData.code !== 0) {
    return { known: false, hasSubtitle: false, error: "B 站暂未返回字幕信息" };
  }

  const subtitleUrl = playerData.data?.subtitle?.subtitles?.[0]?.subtitle_url;
  if (!subtitleUrl) {
    return { known: true, hasSubtitle: false };
  }
  if (!includeContent) {
    return { known: true, hasSubtitle: true };
  }

  const subtitleResponse = await fetch(subtitleUrl.startsWith("//") ? `https:${subtitleUrl}` : subtitleUrl, {
    credentials: "omit"
  });
  if (!subtitleResponse.ok) {
    throw new Error(`下载字幕失败: ${subtitleResponse.status}`);
  }

  const subtitleData = (await subtitleResponse.json()) as { body?: unknown };
  const content =
    typeof subtitleData.body === "string"
      ? subtitleData.body
      : JSON.stringify(subtitleData.body || subtitleData, null, 2);
  return { known: true, hasSubtitle: true, content };
}

async function probeSubtitle(tab: chrome.tabs.Tab, includeContent: boolean): Promise<SubtitleProbeResult | undefined> {
  if (tab.id === undefined || !tab.url) {
    return undefined;
  }

  const pageKey = getDownloadPageKey(tab.url);
  const cached = subtitleCache.get(pageKey);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    (!includeContent || !cached.result.hasSubtitle || Boolean(cached.result.content))
  ) {
    return cached.result;
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: getPageSubtitle,
    args: [includeContent],
    world: "MAIN"
  });
  const subtitleResult = result?.result as SubtitleProbeResult | undefined;
  if (subtitleResult) {
    subtitleCache.set(pageKey, {
      result: subtitleResult,
      expiresAt: Date.now() + SUBTITLE_CACHE_TTL_MS
    });
  }
  return subtitleResult;
}

async function startDownload(mode: DownloadMode): Promise<void> {
  sendButton.disabled = true;
  audioButton.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!isSupportedVideoPage(tab?.url)) {
      setMessage("请在 B 站视频播放页使用");
      return;
    }

    await chrome.storage.session.remove(getDownloadStatusKey(tab.id!));
    clearStatus();

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
      func: (downloadMode: DownloadMode) => {
        window.__BILI_DOWNLOAD_MODE__ = downloadMode;
      },
      args: [mode],
      world: "MAIN"
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ["content_merge.js"],
      world: "MAIN"
    });
    setMessage(mode === "audio" ? "已启动音频下载" : "已启动视频下载");
  } catch (error: unknown) {
    setMessage(`启动失败: ${error instanceof Error ? error.message : "未知错误"}`);
  } finally {
    sendButton.disabled = false;
    audioButton.disabled = false;
  }
}

async function copySubtitle(): Promise<void> {
  subtitleButton.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!isBilibiliPage(tab?.url)) {
      setMessage("请在 B 站视频或番剧页面使用");
      return;
    }

    const subtitleResult = await probeSubtitle(tab, true);
    if (!subtitleResult?.hasSubtitle || !subtitleResult.content?.trim()) {
      throw new Error(subtitleResult?.error || "字幕内容为空");
    }
    await navigator.clipboard.writeText(subtitleResult.content);
    setMessage("字幕已复制到剪贴板");
  } catch (error: unknown) {
    setMessage(`复制字幕失败: ${error instanceof Error ? error.message : "未知错误"}`);
  } finally {
    subtitleButton.disabled = false;
  }
}

async function detectSubtitle(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isBilibiliPage(tab?.url)) {
    return;
  }

  try {
    const subtitleResult = await probeSubtitle(tab, false);
    subtitleButton.hidden = subtitleResult?.known ? !subtitleResult.hasSubtitle : false;
  } catch (error: unknown) {
    subtitleButton.hidden = false;
    console.warn("检测字幕失败", error);
  }
}

function formatStatus(status: DownloadStatus): string {
  const progress = status.progress != null ? ` - 进度 ${status.progress}%` : "";
  const detail = status.detail ? ` - ${status.detail}` : "";
  return `${status.step || ""}${progress}${detail}`;
}

function renderStatus(status: DownloadStatus): void {
  statusElement.textContent = formatStatus(status);
  statusElement.dataset.state = status.error ? "error" : status.done ? "done" : "running";
}

async function updateStatus(): Promise<boolean> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) {
      applyPageState("unsupported");
      clearStatus();
      return false;
    }

    const pageKind = getPageKind(tab.url);
    applyPageState(pageKind);
    if (!isSupportedVideoPage(tab.url)) {
      clearStatus();
      return false;
    }

    const statusKey = getDownloadStatusKey(tab.id);
    const result = await chrome.storage.session.get(statusKey);
    const status = result[statusKey] as DownloadStatus | undefined;
    if (!status) {
      clearStatus();
      return false;
    }

    if (!status.pageKey || status.pageKey !== getDownloadPageKey(tab.url || "")) {
      await chrome.storage.session.remove(statusKey);
      clearStatus();
      return false;
    }

    if (status.ts && Date.now() - status.ts > STATUS_TTL_MS) {
      await chrome.storage.session.remove(statusKey);
      clearStatus();
      return false;
    }

    renderStatus(status);
    return Boolean(status.done || status.error);
  } catch (error: unknown) {
    console.warn("读取下载状态失败", error);
    return false;
  }
}

sendButton.addEventListener("click", () => {
  void startDownload("video");
});

audioButton.addEventListener("click", () => {
  void startDownload("audio");
});

subtitleButton.addEventListener("click", () => {
  void copySubtitle();
});

void detectSubtitle();

void updateStatus();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session" || !Object.keys(changes).some((key) => key.startsWith("vd_status:"))) {
    return;
  }
  void updateStatus();
});

window.setInterval(() => {
  void updateStatus();
}, 30_000);
