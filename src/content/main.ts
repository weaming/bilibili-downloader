import type {
  BilibiliDash,
  BilibiliPlayData,
  BilibiliPlayerContext,
  BilibiliViewData,
  DashMedia,
  DirectDownloadResult,
  DownloadMode,
  DownloadStatus,
  FFmpegWasmNamespace
} from "../shared/types";
import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { formatBytes, formatTime, sanitizeFilename } from "../shared/format";

interface DownloadOverlay {
  setStep(step: string): void;
  setProgress(progress: number): void;
  setDetail(detail: string): void;
  done(): void;
  remove(): void;
}

interface ResolvedMedia {
  video: string;
  audio: string;
}

interface FFmpegSession {
  instance: FFmpeg;
  release(): void;
}

interface BilibiliApiResponse<T> {
  code?: number;
  message?: string;
  data?: T;
  result?: T;
}

const controller = new AbortController();
const signal = controller.signal;
const BILIBILI_API_TIMEOUT_MS = 20_000;
const BILIBILI_API_RETRY_DELAY_MS = 250;

function reportStatus(status: DownloadStatus): void {
  window.dispatchEvent(new CustomEvent<DownloadStatus>("BILI_DOWN_STATUS", { detail: status }));
}

function createOverlay(): DownloadOverlay {
  const element = document.createElement("div");
  Object.assign(element.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "999999",
    background: "rgba(0,0,0,0.75)",
    color: "#fff",
    font: "14px/1.6 system-ui,Segoe UI,Arial",
    padding: "12px 14px",
    borderRadius: "10px",
    boxShadow: "0 6px 20px rgba(0,0,0,0.3)",
    cursor: "move"
  });

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;
  let isRemoved = false;

  element.addEventListener("mousedown", (event: MouseEvent) => {
    if (event.target === cancelButton) {
      return;
    }

    isDragging = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = element.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    element.style.right = "auto";
    element.style.bottom = "auto";
    element.style.left = `${initialLeft}px`;
    element.style.top = `${initialTop}px`;
    event.preventDefault();
  });

  const moveOverlay = (event: MouseEvent): void => {
    if (!isDragging) {
      return;
    }
    element.style.left = `${initialLeft + event.clientX - startX}px`;
    element.style.top = `${initialTop + event.clientY - startY}px`;
  };

  const stopDragging = (): void => {
    isDragging = false;
  };

  const removeOverlay = (): void => {
    if (isRemoved) {
      return;
    }

    isRemoved = true;
    window.removeEventListener("mousemove", moveOverlay);
    window.removeEventListener("mouseup", stopDragging);
    element.remove();
  };

  window.addEventListener("mousemove", moveOverlay);
  window.addEventListener("mouseup", stopDragging, { once: false });

  const stepElement = document.createElement("div");
  stepElement.textContent = "准备中...";
  element.appendChild(stepElement);

  const barContainer = document.createElement("div");
  Object.assign(barContainer.style, {
    marginTop: "6px",
    width: "280px",
    background: "#333",
    borderRadius: "6px",
    overflow: "hidden"
  });

  const barElement = document.createElement("div");
  Object.assign(barElement.style, {
    height: "8px",
    width: "0",
    background: "#00aeec"
  });
  barContainer.appendChild(barElement);
  element.appendChild(barContainer);

  const detailElement = document.createElement("div");
  Object.assign(detailElement.style, {
    marginTop: "6px",
    opacity: ".9"
  });
  element.appendChild(detailElement);

  const cancelButton = document.createElement("div");
  cancelButton.textContent = "取消下载";
  Object.assign(cancelButton.style, {
    marginTop: "8px",
    textAlign: "right",
    fontSize: "12px",
    color: "#ff6b6b",
    cursor: "pointer",
    textDecoration: "underline"
  });
  cancelButton.addEventListener("click", () => {
    controller.abort();
    removeOverlay();
    reportStatus({ step: "已取消", progress: 0, detail: "用户取消下载", error: true });
  });
  element.appendChild(cancelButton);
  document.body.appendChild(element);

  return {
    setStep: (step) => {
      stepElement.textContent = step;
    },
    setProgress: (progress) => {
      barElement.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    },
    setDetail: (detail) => {
      detailElement.textContent = detail;
    },
    done: () => {
      element.style.background = "rgba(0,0,0,0.55)";
      cancelButton.style.display = "none";
    },
    remove: removeOverlay
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`请求失败: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const requestController = new AbortController();
  const abortByDownload = (): void => requestController.abort();
  const timeoutId = window.setTimeout(() => requestController.abort(), timeoutMs);
  if (signal.aborted) {
    requestController.abort();
  } else {
    signal.addEventListener("abort", abortByDownload, { once: true });
  }

  try {
    const response = await fetch(url, { ...init, signal: requestController.signal });
    if (requestController.signal.aborted && !signal.aborted) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒）`);
    }
    return response;
  } catch (error: unknown) {
    if (requestController.signal.aborted && !signal.aborted) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒）`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    signal.removeEventListener("abort", abortByDownload);
  }
}

async function fetchBilibiliApi(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, init, BILIBILI_API_TIMEOUT_MS);
      if (response.status < 500 || attempt === 1) {
        return response;
      }
      await response.body?.cancel();
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError" && signal.aborted) {
        throw error;
      }
      lastError = error;
      if (attempt === 1) {
        throw error;
      }
    }

    await new Promise<void>((resolve) => window.setTimeout(resolve, BILIBILI_API_RETRY_DELAY_MS));
  }

  throw lastError instanceof Error ? lastError : new Error("B 站接口请求失败");
}

function getBilibiliId(): string {
  return location.pathname.match(/\/video\/(BV[\w]+)/i)?.[1] || getCurrentPlayerContext()?.bvid || "";
}

function getBilibiliAid(): string {
  const aid = location.pathname.match(/\/video\/av(\d+)/i)?.[1] || getCurrentPlayerContext()?.aid;
  return aid ? String(aid) : "";
}

function getCurrentPlayerContext(): BilibiliPlayerContext | undefined {
  const context = window.__BILI_PLAYER_CONTEXT__;
  if (!context || context.pageKey !== `${location.pathname}${location.search}`) {
    return undefined;
  }
  return context;
}

function getBilibiliPageNumber(): number {
  const pageNumber = Number(new URLSearchParams(location.search).get("p"));
  return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
}

function getBilibiliCid(data: BilibiliViewData): number | undefined {
  const capturedCid = getCurrentPlayerContext()?.cid;
  if (capturedCid) {
    return capturedCid;
  }

  const pages = data.pages || [];
  const currentPage = pages[getBilibiliPageNumber() - 1];
  return currentPage?.cid || data.cid || pages[0]?.cid;
}

function getBilibiliApiError<T>(payload: BilibiliApiResponse<T>): Error | null {
  if (payload.code === undefined || payload.code === 0) {
    return null;
  }

  const detail = payload.message ? `: ${payload.message}` : "";
  return new Error(`B 站接口错误 (${payload.code})${detail}`);
}

async function fetchBilibiliViewData(bvid: string, aid: string): Promise<BilibiliViewData | null> {
  const viewParams = new URLSearchParams(bvid ? { bvid } : { aid });
  const response = await fetchBilibiliApi(`https://api.bilibili.com/x/web-interface/view?${viewParams}`, {
    credentials: "include",
    cache: "no-store",
    signal
  });
  const payload = await parseJson<BilibiliApiResponse<BilibiliViewData>>(response);
  const error = getBilibiliApiError(payload);
  if (error) {
    throw error;
  }
  return payload.data || null;
}

async function getBilibiliCidForRequest(bvid: string, aid: string): Promise<number | undefined> {
  const capturedCid = getCurrentPlayerContext()?.cid;
  if (capturedCid) {
    return capturedCid;
  }

  const viewData = await fetchBilibiliViewData(bvid, aid);
  return viewData ? getBilibiliCid(viewData) : undefined;
}

function getBilibiliEpisodeId(): number | undefined {
  const contextEpisodeId = getCurrentPlayerContext()?.epId;
  if (contextEpisodeId) {
    return contextEpisodeId;
  }

  const pathEpisodeId = location.pathname.match(/\/ep(\d+)/i)?.[1];
  const queryEpisodeId = new URLSearchParams(location.search).get("ep_id");
  const episodeId = pathEpisodeId || queryEpisodeId;
  if (episodeId) {
    return Number(episodeId);
  }

  const nextDataElement = document.querySelector<HTMLScriptElement>("#__NEXT_DATA__");
  if (!nextDataElement?.textContent) {
    return undefined;
  }

  try {
    const nextData = JSON.parse(nextDataElement.textContent) as unknown;
    return findNumericField(nextData, new Set(["ep_id", "epId", "epid"]));
  } catch (error: unknown) {
    console.warn("解析番剧页面数据失败", error);
    return undefined;
  }
}

function findNumericField(value: unknown, fieldNames: Set<string>, depth = 0): number | undefined {
  if (depth > 8 || value === null || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findNumericField(item, fieldNames, depth + 1);
      if (result) {
        return result;
      }
    }
    return undefined;
  }

  for (const [key, item] of Object.entries(value)) {
    if (fieldNames.has(key)) {
      const result = typeof item === "number" ? item : Number(item);
      if (Number.isInteger(result) && result > 0) {
        return result;
      }
    }

    const nestedResult = findNumericField(item, fieldNames, depth + 1);
    if (nestedResult) {
      return nestedResult;
    }
  }

  return undefined;
}

function isBilibiliPgcPage(): boolean {
  return location.pathname.includes("/bangumi/play/");
}

function getCurrentPgcQuality(): number | undefined {
  const activeQuality = document.querySelector<HTMLElement>(".squirtle-select-item.active[data-value]");
  const quality = Number(activeQuality?.dataset.value);
  if (!Number.isInteger(quality) || quality <= 0) {
    return undefined;
  }

  return quality === 16 ? 32 : quality;
}

function getCurrentBilibiliQuality(): number | undefined {
  if (isBilibiliPgcPage()) {
    const pgcQuality = getCurrentPgcQuality();
    if (pgcQuality) {
      return pgcQuality;
    }
  }

  return getCurrentPlayerContext()?.qn;
}

function getRequestedBilibiliQuality(): number {
  return getCurrentBilibiliQuality() || 120;
}

function getBilibiliPlayData(payload: BilibiliApiResponse<BilibiliPlayData>): BilibiliPlayData | null {
  const error = getBilibiliApiError(payload);
  if (error) {
    throw error;
  }
  return payload.data || payload.result || null;
}

async function resolveBilibiliPgc(): Promise<BilibiliDash | null> {
  const episodeId = getBilibiliEpisodeId();
  if (!episodeId) {
    return null;
  }

  try {
    const params = new URLSearchParams({
      ep_id: String(episodeId),
      qn: String(getRequestedBilibiliQuality()),
      fnval: "4048",
      fourk: "1"
    });
    const response = await fetchBilibiliApi(`https://api.bilibili.com/pgc/player/web/playurl?${params}`, {
      credentials: "include",
      cache: "no-store",
      signal
    });
    const payload = await parseJson<BilibiliApiResponse<BilibiliPlayData>>(response);
    return getBilibiliPlayData(payload)?.dash || null;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    console.warn("解析 Bilibili 番剧播放信息失败", error);
    throw error;
  }
}

async function resolveBilibili(): Promise<BilibiliDash | null> {
  if (isBilibiliPgcPage()) {
    return resolveBilibiliPgc();
  }

  const pagePlayInfo = window.__playinfo__ || window.playinfo;
  if (pagePlayInfo?.dash) {
    return pagePlayInfo.dash;
  }

  const bvid = getBilibiliId();
  const aid = getBilibiliAid();
  if (!bvid && !aid) {
    return null;
  }

  try {
    const cid = await getBilibiliCidForRequest(bvid, aid);
    if (!cid) {
      return null;
    }

    const playParams = new URLSearchParams({
      cid: String(cid),
      qn: String(getRequestedBilibiliQuality()),
      fnval: "4048",
      fourk: "1"
    });
    playParams.set(bvid ? "bvid" : "aid", bvid || aid);
    const playResponse = await fetchBilibiliApi(`https://api.bilibili.com/x/player/playurl?${playParams}`, {
      credentials: "include",
      cache: "no-store",
      signal
    });
    const playData = await parseJson<BilibiliApiResponse<{ dash?: BilibiliDash }>>(playResponse);
    const error = getBilibiliApiError(playData);
    if (error) {
      throw error;
    }
    return playData.data?.dash || null;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    console.warn("解析 Bilibili 播放信息失败", error);
    throw error;
  }
}

function pickBestBilibili(media: DashMedia[] | undefined, maxQuality?: number): string | null {
  if (!media?.length) {
    return null;
  }

  const qualityLimitedMedia = maxQuality
    ? media.filter((item) => item.id === undefined || item.id <= maxQuality)
    : media;
  const availableMedia = qualityLimitedMedia.length ? qualityLimitedMedia : media;
  const maxId = Math.max(...availableMedia.map((item) => item.id || 0));
  const candidates = availableMedia.filter((item) => (item.id || 0) === maxId);
  const best = candidates.reduce((current, item) => {
    return (item.bandwidth || 0) > (current.bandwidth || 0) ? item : current;
  });
  return best.baseUrl || best.base_url || best.backupUrl?.[0] || null;
}

async function fetchWithProgress(
  url: string,
  label: string,
  overlay: DownloadOverlay,
  progressStart: number,
  progressEnd: number
): Promise<Uint8Array> {
  const response = await fetch(url, {
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "strict-origin-when-cross-origin",
    signal
  });
  if (!response.ok) {
    throw new Error(`${label}拉取失败: ${response.status}`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body?.getReader();
  if (!reader) {
    const result = new Uint8Array(await response.arrayBuffer());
    overlay.setProgress(progressEnd);
    return result;
  }

  let loaded = 0;
  const startedAt = performance.now();
  let preallocated = total > 0 ? new Uint8Array(total) : undefined;
  const chunks: Uint8Array[] = [];
  overlay.setStep(`正在下载${label}...`);
  overlay.setDetail(total ? `大小 ${formatBytes(total)}` : "大小未知");

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = value as Uint8Array;
    if (preallocated && loaded + chunk.length <= preallocated.length) {
      preallocated.set(chunk, loaded);
    } else {
      if (preallocated && loaded > 0) {
        chunks.push(preallocated.subarray(0, loaded));
      }
      preallocated = undefined;
      chunks.push(chunk);
    }
    loaded += chunk.length;
    const elapsed = Math.max((performance.now() - startedAt) / 1000, 0.001);
    const speed = loaded / elapsed;
    const progress = total
      ? progressStart + Math.min(1, loaded / total) * (progressEnd - progressStart)
      : progressStart;
    const detail = total
      ? `已下载 ${formatBytes(loaded)} / ${formatBytes(total)}，速度 ${formatBytes(speed)}/s，剩余约 ${formatTime((total - loaded) / speed)}`
      : `已下载 ${formatBytes(loaded)}`;

    overlay.setProgress(progress);
    overlay.setDetail(detail);
    reportStatus({ step: `正在下载${label}`, progress: Math.round(progress), detail });
  }

  if (preallocated && loaded <= preallocated.length) {
    overlay.setProgress(progressEnd);
    return loaded === preallocated.length ? preallocated : preallocated.subarray(0, loaded);
  }

  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  overlay.setProgress(progressEnd);
  return result;
}

async function fetchBilibiliDirectUrl(): Promise<string | null> {
  const currentQuality = getCurrentBilibiliQuality() || 80;
  const qualityCandidates = currentQuality === 80 ? [80] : [currentQuality, 80];

  if (isBilibiliPgcPage()) {
    const episodeId = getBilibiliEpisodeId();
    if (!episodeId) {
      return null;
    }

    return fetchBilibiliDurlForQualities(
      "https://api.bilibili.com/pgc/player/web/playurl",
      qualityCandidates,
      (quality) => new URLSearchParams({ ep_id: String(episodeId), qn: String(quality), fnval: "0" })
    );
  }

  const bvid = getBilibiliId();
  const aid = getBilibiliAid();
  if (!bvid && !aid) {
    return null;
  }

  const cid = await getBilibiliCidForRequest(bvid, aid);
  if (!cid) {
    return null;
  }

  return fetchBilibiliDurlForQualities("https://api.bilibili.com/x/player/playurl", qualityCandidates, (quality) => {
    const playParams = new URLSearchParams({ cid: String(cid), qn: String(quality), fnval: "0" });
    playParams.set(bvid ? "bvid" : "aid", bvid || aid);
    return playParams;
  });
}

async function fetchBilibiliDurl(endpoint: string, params: URLSearchParams): Promise<string | null> {
  const response = await fetchBilibiliApi(`${endpoint}?${params}`, {
    credentials: "include",
    cache: "no-store",
    signal
  });
  const payload = await parseJson<BilibiliApiResponse<BilibiliPlayData>>(response);
  return getBilibiliPlayData(payload)?.durl?.[0]?.url || null;
}

async function fetchBilibiliDurlForQualities(
  endpoint: string,
  qualities: number[],
  createParams: (quality: number) => URLSearchParams
): Promise<string | null> {
  let lastError: unknown;
  for (const quality of qualities) {
    try {
      const directUrl = await fetchBilibiliDurl(endpoint, createParams(quality));
      if (directUrl) {
        return directUrl;
      }
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      lastError = error;
    }
  }

  if (lastError) {
    console.warn("获取 Bilibili 直链失败", lastError);
  }
  return null;
}

function triggerBrowserDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function requestDirectDownload(url: string, filename: string): Promise<void> {
  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    let timeoutId: number | undefined;
    const handleResult = (event: Event): void => {
      const result = (event as CustomEvent<DirectDownloadResult>).detail;
      if (!result || result.requestId !== requestId) {
        return;
      }

      window.removeEventListener("BILI_DIRECT_DOWNLOAD_RESULT", handleResult);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }

      if (result.ok) {
        resolve();
      } else {
        reject(new Error(result.error || "浏览器下载失败"));
      }
    };

    window.addEventListener("BILI_DIRECT_DOWNLOAD_RESULT", handleResult);
    window.dispatchEvent(
      new CustomEvent("BILI_DIRECT_DOWNLOAD", {
        detail: { requestId, url, filename }
      })
    );
    timeoutId = window.setTimeout(() => {
      window.removeEventListener("BILI_DIRECT_DOWNLOAD_RESULT", handleResult);
      reject(new Error("等待浏览器下载响应超时"));
    }, 10000);
  });
}

async function fallbackToDirectDownload(overlay: DownloadOverlay, reason: string): Promise<void> {
  overlay.setStep("合并失败，提交直链下载");
  reportStatus({ step: "合并失败，提交直链下载", progress: 60, detail: reason });
  const directUrl = await fetchBilibiliDirectUrl();
  if (!directUrl) {
    throw new Error("无法获取直链");
  }

  const filename = `${sanitizeFilename(document.title || "bilibili")}.mp4`;
  await requestDirectDownload(directUrl, filename);
  overlay.setStep("已提交浏览器下载");
  overlay.setProgress(100);
  overlay.done();
  reportStatus({
    step: "下载已提交",
    progress: 100,
    detail: `合并失败（${reason}），已将直链提交给浏览器`,
    done: false
  });
}

async function createPageAssetUrl(url: string, contentType: string): Promise<string> {
  const response = await fetchWithTimeout(url, { cache: "no-store" }, BILIBILI_API_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`无法读取 FFmpeg 资源: ${response.status}`);
  }

  const data = await response.arrayBuffer();
  return URL.createObjectURL(new Blob([data], { type: contentType }));
}

async function loadFFmpeg(): Promise<FFmpegSession> {
  const extensionWorkerURL = window.__FFMPEG_CLASS_WORKER_URL__;
  const extensionCoreURL = window.__FFMPEG_CORE_URL__;
  const extensionWasmURL = window.__FFMPEG_WASM_URL__;
  if (!extensionWorkerURL || !extensionCoreURL || !extensionWasmURL) {
    throw new Error("找不到 FFmpeg 运行时资源");
  }

  const ffmpegNamespace = window.FFmpegWASM as FFmpegWasmNamespace | undefined;
  if (!ffmpegNamespace?.FFmpeg) {
    throw new Error("找不到 FFmpeg npm 运行时");
  }

  const pageAssetUrls: string[] = [];
  let ffmpeg: FFmpeg | undefined;
  let isReleased = false;

  const release = (): void => {
    if (isReleased) {
      return;
    }

    isReleased = true;
    ffmpeg?.terminate();
    pageAssetUrls.forEach((url) => URL.revokeObjectURL(url));
  };

  try {
    const classWorkerURL = await createPageAssetUrl(extensionWorkerURL, "text/javascript");
    pageAssetUrls.push(classWorkerURL);
    const coreURL = await createPageAssetUrl(extensionCoreURL, "text/javascript");
    pageAssetUrls.push(coreURL);
    const wasmURL = await createPageAssetUrl(extensionWasmURL, "application/wasm");
    pageAssetUrls.push(wasmURL);

    ffmpeg = new ffmpegNamespace.FFmpeg();
    await ffmpeg.load({ classWorkerURL, coreURL, wasmURL }, { signal });
  } catch (error: unknown) {
    release();
    throw error;
  }

  if (!ffmpeg) {
    release();
    throw new Error("FFmpeg 初始化失败");
  }

  return { instance: ffmpeg, release };
}

async function mergeMedia(
  ffmpeg: FFmpeg,
  video: Uint8Array | undefined,
  audio: Uint8Array,
  overlay: DownloadOverlay,
  isAudioOnly: boolean
): Promise<{ data: Uint8Array; seconds: number }> {
  if (!isAudioOnly && !video) {
    throw new Error("缺少视频数据");
  }

  if (video) {
    await ffmpeg.writeFile("v.m4s", video, { signal });
  }
  await ffmpeg.writeFile("a.m4s", audio, { signal });
  const startedAt = performance.now();
  const mergeTimer = window.setInterval(() => {
    const seconds = (performance.now() - startedAt) / 1000;
    overlay.setDetail(`正在合并... 已用时 ${formatTime(seconds)}`);
    reportStatus({ step: "正在合并音视频", progress: 75, detail: `已用时 ${formatTime(seconds)}` });
  }, 1000);

  try {
    const outputFilename = isAudioOnly ? "out.m4a" : "out.mp4";
    const mergeArgs = isAudioOnly
      ? ["-y", "-i", "a.m4s", "-vn", "-c:a", "copy", outputFilename]
      : ["-y", "-i", "v.m4s", "-i", "a.m4s", "-c", "copy", outputFilename];
    let exitCode = await ffmpeg.exec(mergeArgs, -1, { signal });
    if (exitCode !== 0 && isAudioOnly) {
      reportStatus({ step: "正在转码音频", progress: 80, detail: "当前音频编码不适合直接封装，正在转换为 AAC" });
      exitCode = await ffmpeg.exec(
        ["-y", "-i", "a.m4s", "-vn", "-c:a", "aac", "-b:a", "192k", outputFilename],
        -1,
        { signal }
      );
    }
    if (exitCode !== 0) {
      throw new Error(`FFmpeg 合并失败，退出码: ${exitCode}`);
    }
  } finally {
    window.clearInterval(mergeTimer);
  }

  const output = await ffmpeg.readFile(isAudioOnly ? "out.m4a" : "out.mp4", "binary", { signal });
  if (typeof output === "string") {
    throw new Error("FFmpeg 输出不是二进制数据");
  }

  return {
    data: output,
    seconds: (performance.now() - startedAt) / 1000
  };
}

async function startDownload(): Promise<void> {
  if (window.__BILI_DOWNLOAD_RUNNING__) {
    return;
  }

  window.__BILI_DOWNLOAD_RUNNING__ = true;
  const overlay = createOverlay();
  const isAudioOnly = window.__BILI_DOWNLOAD_MODE__ === "audio";
  let overlayRemovalScheduled = false;
  let ffmpeg: FFmpeg | undefined;
  let releaseFFmpeg: (() => void) | undefined;

  const removeOverlayLater = (): void => {
    if (overlayRemovalScheduled) {
      return;
    }

    overlayRemovalScheduled = true;
    window.setTimeout(() => overlay.remove(), 5000);
  };

  try {
    const dash = await resolveBilibili();
    const currentQuality = getCurrentBilibiliQuality();
    const media = dash
      ? {
          video: pickBestBilibili(dash.video, currentQuality) || "",
          audio: pickBestBilibili(dash.audio, currentQuality) || ""
        }
      : null;
    const filename = sanitizeFilename(document.title || "bilibili");
    if (!media) {
      overlay.setStep("未找到 Bilibili 播放信息");
      reportStatus({ step: "未找到播放信息", progress: 0, detail: "可能需要登录或会员权限" });
      return;
    }

    if (!media.audio || (!isAudioOnly && !media.video)) {
      overlay.setStep("未获取到音视频地址");
      reportStatus({ step: "未获取到音视频地址", progress: 0, detail: "" });
      return;
    }

    let video: Uint8Array | undefined;
    let audio: Uint8Array;
    try {
      if (!isAudioOnly) {
        video = await fetchWithProgress(media.video, "视频", overlay, 0, 25);
      }
      audio = await fetchWithProgress(media.audio, "音频", overlay, isAudioOnly ? 0 : 25, 50);
    } catch (error: unknown) {
      if (isAudioOnly) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      overlay.setStep("拉取失败，提交直链下载");
      reportStatus({ step: "拉取失败，提交直链下载", progress: 0, detail: message });
      const directUrl = await fetchBilibiliDirectUrl();
      if (!directUrl) {
        throw error;
      }
      await requestDirectDownload(directUrl, `${filename}.mp4`);
      overlay.setStep("已提交浏览器下载");
      overlay.setProgress(100);
      overlay.done();
      reportStatus({
        step: "下载已提交",
        progress: 100,
        detail: "由于音视频直拉失败，已将直链提交给浏览器",
        done: false
      });
      removeOverlayLater();
      return;
    }

    overlay.setProgress(50);
    reportStatus({ step: isAudioOnly ? "已下载音频数据" : "已下载音视频数据", progress: 50, detail: "" });
    overlay.setStep("正在加载合并组件...");
    const loadStartedAt = performance.now();
    let merged: { data: Uint8Array; seconds: number };
    try {
      const session = await loadFFmpeg();
      ffmpeg = session.instance;
      releaseFFmpeg = session.release;

      const loadSeconds = (performance.now() - loadStartedAt) / 1000;
      reportStatus({ step: "正在加载合并组件", progress: 55, detail: `组件加载用时 ${formatTime(loadSeconds)}` });
      overlay.setStep(isAudioOnly ? "正在封装音频..." : "正在合并音视频...");
      overlay.setDetail(`已加载组件，用时 ${formatTime(loadSeconds)}`);
      merged = await mergeMedia(ffmpeg, video, audio, overlay, isAudioOnly);
    } catch (error: unknown) {
      if (isAudioOnly) {
        throw error;
      }
      await fallbackToDirectDownload(overlay, error instanceof Error ? error.message : String(error));
      removeOverlayLater();
      return;
    }

    overlay.setProgress(95);
    reportStatus({
      step: isAudioOnly ? "音频封装完成，正在保存" : "合并完成，正在保存",
      progress: 95,
      detail: `处理耗时 ${formatTime(merged.seconds)}`
    });
    overlay.setStep("正在保存文件...");
    const mergedSize = merged.data.byteLength;
    const mergeSeconds = merged.seconds;
    const outputExtension = isAudioOnly ? "m4a" : "mp4";
    const outputMimeType = isAudioOnly ? "audio/mp4" : "video/mp4";
    const outputFilename = `${filename}.${outputExtension}`;
    const blob = new Blob([merged.data as unknown as BlobPart], { type: outputMimeType });
    const objectUrl = URL.createObjectURL(blob);
    triggerBrowserDownload(objectUrl, outputFilename);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    overlay.setProgress(100);
    overlay.setStep("已提交浏览器下载");
    overlay.setDetail(`处理耗时 ${formatTime(mergeSeconds)}，总大小 ${formatBytes(mergedSize)}`);
    overlay.done();
    reportStatus({
      step: "下载已提交",
      progress: 100,
      detail: `文件 ${outputFilename} 已提交给浏览器下载`,
      filename: outputFilename,
      done: true
    });
    removeOverlayLater();
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      ffmpeg?.terminate();
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    overlay.setStep("下载失败");
    overlay.setDetail(message);
    reportStatus({ step: "下载失败", progress: 0, detail: message, error: true });
    console.error("下载失败", error);
    removeOverlayLater();
  } finally {
    releaseFFmpeg?.();
    if (!overlayRemovalScheduled) {
      overlay.remove();
    }
    window.__BILI_DOWNLOAD_RUNNING__ = false;
  }
}

void startDownload();
