import type { BilibiliPlayerContext } from "../shared/types";

declare global {
  interface Window {
    __BILI_PLAYER_PROBE_READY__?: boolean;
  }
}

function toPositiveNumber(value: string | null): number | undefined {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function isPlayerRequest(requestUrl: string): boolean {
  try {
    const parsedUrl = new URL(requestUrl, location.href);
    if (parsedUrl.hostname !== "bilibili.com" && !parsedUrl.hostname.endsWith(".bilibili.com")) {
      return false;
    }

    return (
      parsedUrl.pathname === "/x/player/playurl" ||
      parsedUrl.pathname === "/x/player/wbi/playurl" ||
      parsedUrl.pathname === "/x/player/v2" ||
      parsedUrl.pathname === "/pgc/player/web/playurl" ||
      parsedUrl.pathname === "/pgc/player/web/playurl/"
    );
  } catch {
    return false;
  }
}

function updatePlayerContext(requestUrl: string): void {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestUrl, location.href);
  } catch {
    return;
  }

  if (!isPlayerRequest(parsedUrl.href)) {
    return;
  }

  const params = parsedUrl.searchParams;
  const context: BilibiliPlayerContext = {
    aid: toPositiveNumber(params.get("aid")),
    bvid: params.get("bvid") || undefined,
    cid: toPositiveNumber(params.get("cid")),
    epId: toPositiveNumber(params.get("ep_id") || params.get("epid")),
    qn: toPositiveNumber(params.get("qn") || params.get("quality")),
    pageKey: `${location.pathname}${location.search}`
  };

  if (!context.aid && !context.bvid && !context.cid && !context.epId && !context.qn) {
    return;
  }

  window.__BILI_PLAYER_CONTEXT__ = {
    ...window.__BILI_PLAYER_CONTEXT__,
    ...(context.aid ? { aid: context.aid } : {}),
    ...(context.bvid ? { bvid: context.bvid } : {}),
    ...(context.cid ? { cid: context.cid } : {}),
    ...(context.epId ? { epId: context.epId } : {}),
    ...(context.qn ? { qn: context.qn } : {}),
    pageKey: context.pageKey
  };
}

if (!window.__BILI_PLAYER_PROBE_READY__) {
  window.__BILI_PLAYER_PROBE_READY__ = true;

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
    const requestUrl = typeof args[1] === "string" ? args[1] : String(args[1] || "");
    this.addEventListener("load", () => {
      updatePlayerContext(this.responseURL || requestUrl);
    });
    Reflect.apply(originalOpen, this, args);
  } as typeof XMLHttpRequest.prototype.open;

  const originalFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    updatePlayerContext(requestUrl);
    return originalFetch(input, init).then((response) => {
      updatePlayerContext(response.url);
      return response;
    });
  }) as typeof window.fetch;
}

export {};
