// GTFS の CSV を書く／読むための最小限の道具。
// GTFS は UTF-8・カンマ区切り・ダブルクォートで囲む。改行は CRLF でも LF でもよい（ここでは LF）。

export type Row = Record<string, string | number | undefined>

function escapeCell(v: string | number | undefined): string {
  if (v === undefined || v === null) return ''
  const s = String(v)
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

/** columns の順で1ファイル分の CSV 文字列を作る。列に無いキーは無視される */
export function toCsv(columns: string[], rows: Row[]): string {
  const lines = [columns.join(',')]
  for (const r of rows) lines.push(columns.map((c) => escapeCell(r[c])).join(','))
  return lines.join('\n') + '\n'
}

/** 単純な CSV パーサ（引用符・改行を含むセルに対応）。既存 Flex データの読み込みに使う */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let cur: string[] = []
  let cell = ''
  let inQuote = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else inQuote = false
      } else cell += ch
    } else if (ch === '"') inQuote = true
    else if (ch === ',') {
      cur.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      cur.push(cell)
      rows.push(cur)
      cur = []
      cell = ''
    } else cell += ch
  }
  if (cell.length || cur.length) {
    cur.push(cell)
    rows.push(cur)
  }
  if (rows.length === 0) return []
  const header = rows[0].map((h) => h.trim())
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])))
}
