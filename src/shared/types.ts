import type { FFmpeg } from "@ffmpeg/ffmpeg";

export interface DownloadStatus {
  step: string;
  progress: number;
  detail: string;
  done?: boolean;
  error?: boolean;
  filename?: string;
  ts?: number;
}

export type RuntimeMessage =
  | { type: "start-download" }
  | { type: "download-direct"; url: string; filename?: string };

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

interface BilibiliPlayInfo {
  dash?: BilibiliDash;
}

export interface FFmpegWasmNamespace {
  FFmpeg: new () => FFmpeg;
}

export interface BilibiliViewData {
  cid?: number;
  pages?: Array<{ cid?: number; page?: number }>;
}

export interface YouTubeFormat {
  mimeType?: string;
  url?: string;
  bitrate?: number;
}

export interface YouTubePlayerResponse {
  streamingData?: {
    adaptiveFormats?: YouTubeFormat[];
  };
}

declare global {
  interface Window {
    __BILI_DOWNLOAD_BRIDGE_READY__?: boolean;
    __BILI_DOWNLOAD_RUNNING__?: boolean;
    __FFMPEG_CLASS_WORKER_URL__?: string;
    __FFMPEG_CORE_URL__?: string;
    __FFMPEG_WASM_URL__?: string;
    FFmpegWASM?: FFmpegWasmNamespace;
    __playinfo__?: BilibiliPlayInfo;
    playinfo?: BilibiliPlayInfo;
    ytInitialPlayerResponse?: YouTubePlayerResponse;
  }
}

export {};
