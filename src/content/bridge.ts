import type {
  DirectDownloadRequest,
  DirectDownloadResult,
  DownloadResponse,
  DownloadStatus,
  RuntimeMessage
} from "../shared/types";

if (!window.__BILI_DOWNLOAD_BRIDGE_READY__) {
  window.__BILI_DOWNLOAD_BRIDGE_READY__ = true;

  function saveStatus(status: DownloadStatus): void {
    void chrome.storage.local.set({ vd_status: { ...status, ts: Date.now() } }).catch((error: unknown) => {
      console.warn("保存下载状态失败", error);
    });
  }

  window.addEventListener("BILI_DOWN_STATUS", (event: Event) => {
    const detail = (event as CustomEvent<DownloadStatus>).detail;
    if (detail) {
      saveStatus(detail);
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
