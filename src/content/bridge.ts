import { getDownloadPageKey } from "../shared/types";
import type {
  DirectDownloadRequest,
  DirectDownloadResult,
  DownloadResponse,
  DownloadStatus,
  RuntimeMessage
} from "../shared/types";

if (!window.__BILI_DOWNLOAD_BRIDGE_READY__) {
  window.__BILI_DOWNLOAD_BRIDGE_READY__ = true;

  const STATUS_THROTTLE_MS = 300;
  let lastStatusSavedAt = 0;
  let pendingStatus: DownloadStatus | undefined;
  let statusTimerId: number | undefined;
  let isSavingStatus = false;

  function flushStatus(): void {
    if (isSavingStatus || !pendingStatus) {
      return;
    }

    const status = pendingStatus;
    pendingStatus = undefined;
    isSavingStatus = true;
    lastStatusSavedAt = Date.now();

    const statusWithPage = {
      ...status,
      pageKey: getDownloadPageKey(location.href)
    };
    void chrome.runtime
      .sendMessage<RuntimeMessage, DownloadResponse>({ type: "status-update", status: statusWithPage })
      .then((response) => {
        if (!response?.ok) {
          console.warn("保存下载状态失败", response?.error || "后台未确认状态");
        }
      })
      .catch((error: unknown) => {
        console.warn("保存下载状态失败", error);
      })
      .finally(() => {
        isSavingStatus = false;
        if (pendingStatus) {
          scheduleStatusSave(pendingStatus);
        }
      });
  }

  function scheduleStatusSave(status: DownloadStatus): void {
    pendingStatus = status;
    const isTerminal = Boolean(status.done || status.error);
    if (isSavingStatus) {
      return;
    }

    if (isTerminal) {
      if (statusTimerId !== undefined) {
        window.clearTimeout(statusTimerId);
        statusTimerId = undefined;
      }
      flushStatus();
      return;
    }

    if (statusTimerId !== undefined) {
      return;
    }

    const elapsed = Date.now() - lastStatusSavedAt;
    const delay = Math.max(0, STATUS_THROTTLE_MS - elapsed);
    statusTimerId = window.setTimeout(() => {
      statusTimerId = undefined;
      flushStatus();
    }, delay);
  }

  window.addEventListener("BILI_DOWN_STATUS", (event: Event) => {
    const detail = (event as CustomEvent<DownloadStatus>).detail;
    if (detail) {
      scheduleStatusSave(detail);
    }
  });

  window.addEventListener("BILI_DIRECT_DOWNLOAD", (event: Event) => {
    const request = (event as CustomEvent<DirectDownloadRequest>).detail;
    if (!request?.requestId || !request.url || !request.filename) {
      return;
    }

    void chrome.runtime
      .sendMessage<RuntimeMessage, DownloadResponse>({
        type: "download-direct",
        url: request.url,
        filename: request.filename
      })
      .then((response) => {
        const result: DirectDownloadResult = {
          requestId: request.requestId,
          ok: Boolean(response?.ok),
          error: response?.error
        };
        window.dispatchEvent(new CustomEvent<DirectDownloadResult>("BILI_DIRECT_DOWNLOAD_RESULT", { detail: result }));
      })
      .catch((error: unknown) => {
        const result: DirectDownloadResult = {
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
        window.dispatchEvent(new CustomEvent<DirectDownloadResult>("BILI_DIRECT_DOWNLOAD_RESULT", { detail: result }));
      });
  });
}
