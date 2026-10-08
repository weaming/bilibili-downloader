import type { FFmpeg } from "@ffmpeg/ffmpeg";

export interface DownloadStatus {
  step: string;
  progress: number;
  detail: string;
  done?: boolean;
  error?: boolean;
  filename?: string;
  pageKey?: string;
  ts?: number;
}

export type DownloadMode = "video" | "audio";

const DOWNLOAD_STATUS_KEY_PREFIX = "vd_status:";

export function getDownloadStatusKey(tabId: number): string {
  return `${DOWNLOAD_STATUS_KEY_PREFIX}${tabId}`;
}

export function getDownloadPageKey(url: string): string {
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.origin}${parsedUrl.pathname}${parsedUrl.search}`;
  } catch {
    return url.split("#", 1)[0];
  }
}

export type RuntimeMessage =
  | { type: "start-download" }
  | { type: "download-direct"; url: string; filename?: string }
  | { type: "status-update"; status: DownloadStatus };

export interface DownloadResponse {
  ok: boolean;
  error?: string;
  id?: number;
}

export interface DirectDownloadRequest {
  requestId: string;
  url: string;
  filename: string;
}

export interface DirectDownloadResult {
  requestId: string;
  ok: boolean;
  error?: string;
}

export interface DashMedia {
  id?: number;
  bandwidth?: number;
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
}

export interface BilibiliDash {
  video?: DashMedia[];
  audio?: DashMedia[];
}

interface BilibiliDurl {
  url?: string;
}

export interface BilibiliPlayData {
  dash?: BilibiliDash;
  durl?: BilibiliDurl[];
}

interface BilibiliPlayInfo {
  dash?: BilibiliDash;
}

export interface FFmpegWasmNamespace {
  FFmpeg: new () => FFmpeg;
}

export interface BilibiliViewData {
  aid?: number;
  cid?: number;
  pages?: Array<{ cid?: number; page?: number }>;
}

export interface BilibiliPlayerContext {
  aid?: number;
  bvid?: string;
  cid?: number;
  epId?: number;
  qn?: number;
  pageKey?: string;
}

declare global {
  interface Window {
    __BILI_DOWNLOAD_BRIDGE_READY__?: boolean;
    __BILI_DOWNLOAD_RUNNING__?: boolean;
    __BILI_DOWNLOAD_MODE__?: DownloadMode;
    __BILI_PLAYER_CONTEXT__?: BilibiliPlayerContext;
    __FFMPEG_CLASS_WORKER_URL__?: string;
    __FFMPEG_CORE_URL__?: string;
    __FFMPEG_WASM_URL__?: string;
    FFmpegWASM?: FFmpegWasmNamespace;
    __playinfo__?: BilibiliPlayInfo;
    playinfo?: BilibiliPlayInfo;
  }
}

export {};
