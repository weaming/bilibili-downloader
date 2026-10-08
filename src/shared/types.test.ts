import { describe, expect, test } from "bun:test";
import { getDownloadPageKey, getDownloadStatusKey } from "./types";

describe("下载状态标识", () => {
  test("按标签页生成独立状态键", () => {
    expect(getDownloadStatusKey(42)).toBe("vd_status:42");
  });

  test("页面键忽略 hash", () => {
    expect(getDownloadPageKey("https://www.bilibili.com/video/BV1?a=1#part")).toBe(
      "https://www.bilibili.com/video/BV1?a=1"
    );
  });
});
