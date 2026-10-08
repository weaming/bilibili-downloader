import { describe, expect, test } from "bun:test";
import { formatBytes, formatTime, sanitizeFilename } from "./format";

describe("下载显示格式", () => {
  test("格式化文件大小", () => {
    expect(formatBytes(0)).toBe("0.0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  test("格式化剩余时间", () => {
    expect(formatTime(0)).toBe("0秒");
    expect(formatTime(125.9)).toBe("2分5秒");
  });

  test("清理下载文件名", () => {
    expect(sanitizeFilename("视频:/测试?*")).toBe("视频测试");
    expect(sanitizeFilename("   ")).toBe("bilibili");
    expect(sanitizeFilename(`${"a".repeat(200)}.`)).toHaveLength(180);
  });
});
