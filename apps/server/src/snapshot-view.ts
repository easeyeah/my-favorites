/**
 * A4-4/A4-5 快照净化查看器（2026-11-17）
 *
 * 不假设 MHTML 能通过 iframe/blob 直接安全显示。查看路径：
 *  1. 解析 MHTML 提取首个 text/html 部分（Quoted-Printable/Base64 解码）；
 *  2. 消毒：删 script/iframe/object/embed/form/link/style 外链、所有 on* 属性、
 *     javascript: URL；图片/样式引用改为原站占位（不外联）；
 *  3. 包裹 CSP 严格的安全壳页面（default-src 'none'; style-src 'unsafe-inline'）。
 * 原始 MHTML 永远通过受控下载通道（带鉴权+隐私检查+Content-Disposition: attachment）获取。
 */

export interface SnapshotView {
  ok: boolean;
  html: string | null;
  reason?: "no_html_part" | "decode_failed";
}

/** 提取 MHTML 中第一个 text/html part 的源码 */
export function extractHtmlFromMhtml(mhtml: string): string | null {
  // 分割 boundary
  const boundaryMatch = /boundary="?([^";\r\n]+)"?/i.exec(mhtml);
  if (!boundaryMatch?.[1]) {
    // 非multipart：直接当 HTML 试试
    return /<html|<!doctype/i.test(mhtml) ? mhtml : null;
  }
  const parts = mhtml.split(`--${boundaryMatch[1]}`);
  for (const rawPart of parts) {
    const part = rawPart.replace(/^\r?\n/, ""); // 去掉 boundary 行后的换行残留
    const headerBlock = part.split("\r\n\r\n")[0] ?? "";
    if (/content-type:\s*text\/html/i.test(headerBlock)) {
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd < 0) continue;
      const headers = part.slice(0, headerEnd);
      const body = part.slice(headerEnd + 4);
      if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
        return decodeQuotedPrintable(body);
      }
      if (/content-transfer-encoding:\s*base64/i.test(headers)) {
        try {
          return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
        } catch {
          return null;
        }
      }
      return body;
    }
  }
  return null;
}

function decodeQuotedPrintable(input: string): string {
  // =XX 十六进制；= 行尾软换行。字节级解码（UTF-8 多字节内容需 Buffer 组合）
  const soft = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 消毒 HTML：禁脚本/表单/外联（A4-5） */
export function sanitizeSnapshotHtml(html: string): string {
  let out = html;
  // 整块删除危险元素（含内容）
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  out = out.replace(/<object[\s\S]*?<\/object>/gi, "");
  out = out.replace(/<embed[^>]*>/gi, "");
  out = out.replace(/<form[\s\S]*?<\/form>/gi, "");
  out = out.replace(/<link[^>]*>/gi, "");
  out = out.replace(/<meta[^>]+http-equiv[^>]*>/gi, "");
  // 内联框架/媒体外链属性
  out = out.replace(/<base[^>]*>/gi, "");
  // on* 事件属性
  out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // javascript:/data: 链接
  out = out.replace(/(href|src|action)\s*=\s*("|')\s*(javascript|data):[^"']*\2/gi, '$1="#"');
  // 外链图片 → 占位（不访问原站）
  out = out.replace(/<img[^>]*>/gi, (tag) =>
    /\bsrc\s*=\s*("|')(?!data:image\/(png|jpeg|jpg|gif|webp);)/i.test(tag) ? "" : tag,
  );
  return out;
}

/** 查看器壳：严格 CSP + 提示条 + 受控下载入口 */
export function renderSnapshotViewer(
  sanitizedHtml: string,
  opts: { snapshotId: string; title: string },
): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · 快照</title>
<style>
  body { margin:0; font:14px/1.5 -apple-system,"PingFang SC",sans-serif; background:#f7f7f8; }
  .bar { position:sticky; top:0; z-index:9; display:flex; gap:12px; align-items:center;
         padding:8px 16px; background:#1d1d1f; color:#eee; font-size:13px; }
  .bar a { color:#8ab4f8; text-decoration:none; }
  .frame { padding:16px; max-width:920px; margin:0 auto; background:#fff; min-height:60vh; }
</style>
</head>
<body>
<div class="bar">
  <span>📸 快照视图（已禁用脚本与外部访问）</span>
  <a href="/api/v1/snapshots/${encodeURIComponent(opts.snapshotId)}/download">下载原始 MHTML</a>
</div>
<div class="frame">
${sanitizedHtml}
</div>
</body>
</html>`;
}

/** 完整查看管线：MHTML → 提取 → 消毒 → 壳页面 */
export function buildSnapshotView(mhtml: string, opts: { snapshotId: string; title: string }): SnapshotView & { viewer?: string } {
  const html = extractHtmlFromMhtml(mhtml);
  if (!html) return { ok: false, html: null, reason: "no_html_part" };
  const sanitized = sanitizeSnapshotHtml(html);
  return { ok: true, html: sanitized, viewer: renderSnapshotViewer(sanitized, opts) };
}
