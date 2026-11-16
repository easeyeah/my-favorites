/**
 * Netscape HTML 书签文件解析（F1.1 通道2：Firefox/Safari 手动导出的兜底导入）
 *
 * Netscape 格式结构固定（<DL><DT><A HREF=...>），用逐行正则而非完整 DOM
 * 解析：格式规范、无嵌套陷阱，且避免在扩展/服务端引入 DOM 依赖。
 */

export interface ParsedBookmark {
  url: string;
  title: string;
  /** 目录路径（如 ["书签栏", "开发"]），不含书签名 */
  folderPath: string[];
  addedAt?: string;
}

const A_RE = /<A\s+([^>]*HREF="([^"]+)"[^>]*)>([^<]*)<\/A>/i;
const H3_RE = /<H3[^>]*>([^<]*)<\/H3>/i;
const DL_OPEN = /<DL[^>]*>/i;
const DL_CLOSE = /<\/DL>/i;
const ADD_DATE = /ADD_DATE="(\d+)"/i;

/** 从 <A> 标签属性串提取 ADD_DATE（秒级 Unix 时间戳） */
function extractAddedDate(attrs: string): string | undefined {
  const m = ADD_DATE.exec(attrs);
  if (!m?.[1]) return undefined;
  const seconds = Number(m[1]);
  // 兼容毫秒时间戳（>10^12 视为毫秒）
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  return new Date(ms).toISOString();
}

export function parseNetscapeBookmarks(html: string): ParsedBookmark[] {
  const results: ParsedBookmark[] = [];
  /** 目录栈：遇到 <H3> push，</DL> pop */
  const stack: string[] = [];

  for (const line of html.split(/\r?\n/)) {
    const trimmed = line.trim();

    const h3 = H3_RE.exec(trimmed);
    if (h3?.[1]) {
      stack.push(h3[1]);
      continue;
    }

    if (DL_CLOSE.test(trimmed) && !DL_OPEN.test(trimmed)) {
      stack.pop();
      continue;
    }

    const a = A_RE.exec(trimmed);
    const url = a?.[2];
    const titleText = a?.[3];
    if (url && titleText !== undefined) {
      results.push({
        url,
        title: titleText.trim() || url,
        folderPath: [...stack],
        addedAt: extractAddedDate(a[1] ?? ""),
      });
    }
  }
  return results;
}

/** 导出为 Netscape HTML（F1.6：数据可迁移承诺） */
export function exportNetscapeHtml(
  items: Array<ParsedBookmark & { folderPath: string[] }>,
): string {
  const lines: string[] = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- my-favorites export -->",
    "<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">",
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];

  let lastPath: string[] = [];
  const closeTo = (depth: number) => {
    while (lastPath.length > depth) {
      lines.push("</DL><p>");
      lastPath.pop();
    }
  };

  // 按输入顺序发射（不排序——排序会破坏目录开合与 round-trip）
  for (const item of items) {
    // 公共前缀之后的层级：先收合再展开（处理"从深层回到浅层"）
    let i = 0;
    while (i < item.folderPath.length && lastPath[i] === item.folderPath[i]) i++;
    closeTo(i);
    for (let j = i; j < item.folderPath.length; j++) {
      const name = item.folderPath[j];
      if (name === undefined) continue;
      lines.push(`<DT><H3>${name}</H3>`);
      lines.push("<DL><p>");
      lastPath.push(name);
    }
    const date = item.addedAt
      ? ` ADD_DATE="${Math.floor(new Date(item.addedAt).getTime() / 1000)}"`
      : "";
    lines.push(
      `<DT><A HREF="${item.url.replace(/"/g, "&quot;")}"${date}>${item.title
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</A>`,
    );
  }
  closeTo(0);
  lines.push("</DL><p>");
  return lines.join("\n");
}
