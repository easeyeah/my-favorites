/**
 * SSE 读取工具：fetch 流式（带鉴权头）逐帧解析 `event:` + `data:`。
 * 管理台长任务（死链检测 / 目录资料扫描）共用——EventSource 不能带 Authorization 头，
 * 故统一用 fetch + ReadableStream，断开由调用方 AbortSignal 控制。
 */
export async function consumeSse(
  res: Response,
  onEvent: (event: string, payload: Record<string, unknown>) => void,
): Promise<void> {
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      const event = frame.match(/^event:\s*(\S+)/m)?.[1]
      const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'))
      if (!event || dataLines.length === 0) continue
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(
          dataLines.map((l) => l.slice(5).replace(/^ /, '')).join('\n'),
        ) as Record<string, unknown>
      } catch {
        continue
      }
      onEvent(event, payload)
    }
  }
}
