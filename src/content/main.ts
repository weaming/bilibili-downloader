import type {
  BilibiliDash,
  BilibiliViewData,
  DashMedia,
  DirectDownloadResult,
  DownloadStatus,
  FFmpegWasmNamespace,
  YouTubeFormat,
  YouTubePlayerResponse
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

const controller = new AbortController();
const signal = controller.signal;

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
    element.remove();
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
    remove: () => {
      window.removeEventListener("mousemove", moveOverlay);
      window.removeEventListener("mouseup", stopDragging);
      element.remove();
    }
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`请求失败: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function resolveYouTube(): Promise<ResolvedMedia | null> {
  let playerResponse: YouTubePlayerResponse | undefined = window.ytInitialPlayerResponse;
  if (!playerResponse) {
    const match = document.documentElement.innerHTML.match(/var ytInitialPlayerResponse = ({.*?});/);
    if (match) {
      try {
        playerResponse = JSON.parse(match[1]) as YouTubePlayerResponse;
      } catch (error: unknown) {
        console.warn("解析 YouTube 播放信息失败", error);
      }
    }
  }

  const formats = playerResponse?.streamingData?.adaptiveFormats;
  if (!formats) {
    return null;
  }

  const videos = formats
    .filter((format: YouTubeFormat) => format.mimeType?.includes("video/mp4") && format.url)
    .sort((left, right) => (right.bitrate || 0) - (left.bitrate || 0));
  const audios = formats
    .filter((format: YouTubeFormat) => format.mimeType?.includes("audio/mp4") && format.url)
    .sort((left, right) => (right.bitrate || 0) - (left.bitrate || 0));

  if (!videos[0]?.url || !audios[0]?.url) {
    return null;
  }
  return { video: videos[0].url, audio: audios[0].url };
}

function getBilibiliId(): string {
  return location.pathname.match(/\/video\/(BV[\w]+)/i)?.[1] || "";
}

async function resolveBilibili(): Promise<BilibiliDash | null> {
  const pagePlayInfo = window.__playinfo__ || window.playinfo;
  if (pagePlayInfo?.dash) {
    return pagePlayInfo.dash;
  }

  const bvid = getBilibiliId();
  if (!bvid) {
    return null;
  }

  try {
    const viewResponse = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      { credentials: "include", signal }
    );
    const viewData = await parseJson<{ data?: BilibiliViewData }>(viewResponse);
    const cid = viewData.data?.cid || viewData.data?.pages?.[0]?.cid;
    if (!cid) {
      return null;
    }

    const playResponse = await fetch(
      `https://api.bilibili.com/x/player/playurl?cid=${cid}&bvid=${bvid}&qn=120&fnval=4048&fourk=1`,
      { credentials: "include", signal }
    );
    const playData = await parseJson<{ data?: { dash?: BilibiliDash } }>(playResponse);
    return playData.data?.dash || null;
  } catch (error: unknown) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      console.warn("解析 Bilibili 播放信息失败", error);
    }
    return null;
  }
}

function pickBestBilibili(media: DashMedia[] | undefined): string | null {
  if (!media?.length) {
    return null;
  }

  const maxId = Math.max(...media.map((item) => item.id || 0));
  const candidates = media.filter((item) => (item.id || 0) === maxId);
  const best = candidates.reduce((current, item) => {
    return (item.bandwidth || 0) > (current.bandwidth || 0) ? item : current;
  });
  return best.baseUrl || best.base_url || best.backupUrl?.[0] || null;
}

async function fetchWithProgress(
  url: string,
  label: string,
  overlay: DownloadOverlay
): Promise<Uint8Array> {
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "strict-origin-when-cross-origin",
    signal
  });
  if (!response.ok) {
    throw new Error(`${label}拉取失败: ${response.status}`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array(await response.arrayBuffer());
  }

  let loaded = 0;
  const startedAt = performance.now();
  const chunks: Uint8Array[] = [];
  overlay.setStep(`正在下载${label}...`);
  overlay.setDetail(total ? `大小 ${formatBytes(total)}` : "大小未知");

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = value as Uint8Array;
    loaded += chunk.length;
    chunks.push(chunk);
    const elapsed = Math.max((performance.now() - startedAt) / 1000, 0.001);
    const speed = loaded / elapsed;
    const progress = total ? (loaded / total) * 50 : 0;
    const detail = total
      ? `已下载 ${formatBytes(loaded)} / ${formatBytes(total)}，速度 ${formatBytes(speed)}/s，剩余约 ${formatTime((total - loaded) / speed)}`
      : `已下载 ${formatBytes(loaded)}`;

    overlay.setProgress(progress);
    overlay.setDetail(detail);
    reportStatus({ step: `正在下载${label}`, progress: Math.round(progress), detail });
  }

  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function fetchBilibiliDirectUrl(): Promise<string | null> {
  const bvid = getBilibiliId();
  if (!bvid) {
    return null;
  }

  const viewResponse = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { credentials: "include", signal }
  );
  const viewData = await parseJson<{ data?: BilibiliViewData }>(viewResponse);
  const cid = viewData.data?.cid || viewData.data?.pages?.[0]?.cid;
  if (!cid) {
    return null;
  }

  const playResponse = await fetch(
    `https://api.bilibili.com/x/player/playurl?cid=${cid}&bvid=${bvid}&qn=80&fnval=0`,
    { credentials: "include", signal }
  );
  const playData = await parseJson<{ data?: { durl?: Array<{ url?: string }> } }>(playResponse);
  return playData.data?.durl?.[0]?.url || null;
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

async function fallbackTo1080P(overlay: DownloadOverlay, reason: string): Promise<void> {
  if (location.hostname.includes("youtube.com")) {
    overlay.setStep("下载失败");
    reportStatus({ step: "下载失败", progress: 0, detail: `YouTube 下载失败: ${reason}`, error: true });
    return;
  }

  overlay.setStep("合并失败，尝试 1080P 直链");
  reportStatus({ step: "合并失败，尝试 1080P 直链", progress: 60, detail: reason });
  const directUrl = await fetchBilibiliDirectUrl();
  if (!directUrl) {
    throw new Error("无法获取 1080P 直链");
  }

  const filename = `${sanitizeFilename(document.title || "bilibili")}.mp4`;
  await requestDirectDownload(directUrl, filename);
  overlay.setStep("已保存 1080P 直链");
  overlay.setProgress(100);
  overlay.done();
  reportStatus({
    step: "下载完成（1080P直链）",
    progress: 100,
    detail: `4K 合并失败（${reason}），已保存 1080P`,
    done: true
  });
  window.setTimeout(() => overlay.remove(), 5000);
}

async function createPageAssetUrl(url: string, contentType: string): Promise<string> {
  const response = await fetch(url);
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
    const [classWorkerURL, coreURL, wasmURL] = await Promise.all([
      createPageAssetUrl(extensionWorkerURL, "text/javascript"),
      createPageAssetUrl(extensionCoreURL, "text/javascript"),
      createPageAssetUrl(extensionWasmURL, "application/wasm")
    ]);
    pageAssetUrls.push(classWorkerURL, coreURL, wasmURL);

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
  video: Uint8Array,
  audio: Uint8Array,
  overlay: DownloadOverlay
): Promise<{ data: Uint8Array; seconds: number }> {
  await ffmpeg.writeFile("v.m4s", video, { signal });
  await ffmpeg.writeFile("a.m4s", audio, { signal });
  const startedAt = performance.now();
  const mergeTimer = window.setInterval(() => {
    const seconds = (performance.now() - startedAt) / 1000;
    overlay.setDetail(`正在合并... 已用时 ${formatTime(seconds)}`);
    reportStatus({ step: "正在合并音视频", progress: 75, detail: `已用时 ${formatTime(seconds)}` });
  }, 1000);

  try {
    const exitCode = await ffmpeg.exec(["-i", "v.m4s", "-i", "a.m4s", "-c", "copy", "out.mp4"], -1, { signal });
    if (exitCode !== 0) {
      throw new Error(`FFmpeg 合并失败，退出码: ${exitCode}`);
    }
  } finally {
    window.clearInterval(mergeTimer);
  }

  const output = await ffmpeg.readFile("out.mp4", "binary", { signal });
  if (typeof output === "string") {
    throw new Error("FFmpeg 输出不是二进制数据");
  }

  return {
    data: output,
    seconds: (performance.now() - startedAt) / 1000
  };
}

async function startDownload(): Promise<void> {
  const overlay = createOverlay();
  let ffmpeg: FFmpeg | undefined;
  let releaseFFmpeg: (() => void) | undefined;

  try {
    let media: ResolvedMedia | null;
    let filename: string;
    if (location.hostname.includes("youtube.com")) {
      media = await resolveYouTube();
      filename = sanitizeFilename(document.title);
      if (!media) {
        overlay.setStep("未找到 YouTube 播放信息");
        reportStatus({ step: "未找到播放信息", progress: 0, detail: "无法解析视频地址，可能是加密视频" });
        return;
      }
    } else {
      const dash = await resolveBilibili();
      media = dash
        ? {
            video: pickBestBilibili(dash.video) || "",
            audio: pickBestBilibili(dash.audio) || ""
          }
        : null;
      filename = sanitizeFilename(document.title || "bilibili");
      if (!media) {
        overlay.setStep("未找到 Bilibili 播放信息");
        reportStatus({ step: "未找到播放信息", progress: 0, detail: "可能需要登录或会员权限" });
        return;
      }
    }

    if (!media.video || !media.audio) {
      overlay.setStep("未获取到音视频地址");
      reportStatus({ step: "未获取到音视频地址", progress: 0, detail: "" });
      return;
    }

    let video: Uint8Array;
    let audio: Uint8Array;
    try {
      video = await fetchWithProgress(media.video, "视频", overlay);
      audio = await fetchWithProgress(media.audio, "音频", overlay);
    } catch (error: unknown) {
      if (location.hostname.includes("youtube.com")) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      overlay.setStep("拉取失败，尝试 1080P 直链");
      reportStatus({ step: "拉取失败，尝试 1080P 直链", progress: 0, detail: message });
      const directUrl = await fetchBilibiliDirectUrl();
      if (!directUrl) {
        throw error;
      }
      await requestDirectDownload(directUrl, `${filename}.mp4`);
      overlay.setStep("已保存 1080P 直链");
      overlay.setProgress(100);
      overlay.done();
      reportStatus({ step: "下载完成（1080P直链）", progress: 100, detail: "由于跨域限制，已保存 1080P MP4", done: true });
      window.setTimeout(() => overlay.remove(), 5000);
      return;
    }

    overlay.setProgress(50);
    reportStatus({ step: "已下载音视频数据", progress: 50, detail: "" });
    overlay.setStep("正在加载合并组件...");
    const loadStartedAt = performance.now();
    let merged: { data: Uint8Array; seconds: number };
    try {
      const session = await loadFFmpeg();
      ffmpeg = session.instance;
      releaseFFmpeg = session.release;

      const loadSeconds = (performance.now() - loadStartedAt) / 1000;
      reportStatus({ step: "正在加载合并组件", progress: 55, detail: `组件加载用时 ${formatTime(loadSeconds)}` });
      overlay.setStep("正在合并音视频...");
      overlay.setDetail(`已加载组件，用时 ${formatTime(loadSeconds)}`);
      merged = await mergeMedia(ffmpeg, video, audio, overlay);
    } catch (error: unknown) {
      await fallbackTo1080P(overlay, error instanceof Error ? error.message : String(error));
      return;
    }

    overlay.setProgress(95);
    reportStatus({ step: "合并完成，正在保存", progress: 95, detail: `合并耗时 ${formatTime(merged.seconds)}` });
    overlay.setStep("正在保存文件...");
    const outputBuffer = new ArrayBuffer(merged.data.byteLength);
    new Uint8Array(outputBuffer).set(merged.data);
    const blob = new Blob([outputBuffer], { type: "video/mp4" });
    const objectUrl = URL.createObjectURL(blob);
    triggerBrowserDownload(objectUrl, `${filename}.mp4`);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    overlay.setProgress(100);
    overlay.setStep("下载完成");
    overlay.setDetail(`合并耗时 ${formatTime(merged.seconds)}，总大小 ${formatBytes(merged.data.byteLength)}`);
    overlay.done();
    reportStatus({
      step: "下载完成",
      progress: 100,
      detail: `文件 ${filename}.mp4 已保存到浏览器默认下载目录`,
      filename: `${filename}.mp4`,
      done: true
    });
    window.setTimeout(() => overlay.remove(), 5000);
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
  } finally {
    releaseFFmpeg?.();
  }
}

void startDownload();
