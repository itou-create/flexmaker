// 依存を増やさないための、無圧縮（stored）zip ライタ。
// GTFS は数KB〜数百KBのテキストなので圧縮しなくても困らない。
// 仕様：PKWARE APPNOTE のローカルヘッダ＋セントラルディレクトリ＋終端レコード。
// ファイル名は UTF-8（汎用ビットフラグ bit 11 を立てる）。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(d: Date): { date: number; time: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { date, time }
}

export function buildZip(files: Record<string, string | Uint8Array>, now = new Date()): Uint8Array {
  const enc = new TextEncoder()
  const { date, time } = dosDateTime(now)
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name)
    const data = typeof content === 'string' ? enc.encode(content) : content
    const crc = crc32(data)

    const local = new DataView(new ArrayBuffer(30 + nameBytes.length))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true) // version needed
    local.setUint16(6, 0x0800, true) // flags: UTF-8 names
    local.setUint16(8, 0, true) // stored
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true)
    const localBytes = new Uint8Array(local.buffer)
    localBytes.set(nameBytes, 30)

    const central = new DataView(new ArrayBuffer(46 + nameBytes.length))
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(4, 20, true) // version made by
    central.setUint16(6, 20, true) // version needed
    central.setUint16(8, 0x0800, true)
    central.setUint16(10, 0, true)
    central.setUint16(12, time, true)
    central.setUint16(14, date, true)
    central.setUint32(16, crc, true)
    central.setUint32(20, data.length, true)
    central.setUint32(24, data.length, true)
    central.setUint16(28, nameBytes.length, true)
    central.setUint16(30, 0, true) // extra
    central.setUint16(32, 0, true) // comment
    central.setUint16(34, 0, true) // disk
    central.setUint16(36, 0, true) // internal attrs
    central.setUint32(38, 0, true) // external attrs
    central.setUint32(42, offset, true)
    const centralBytes = new Uint8Array(central.buffer)
    centralBytes.set(nameBytes, 46)

    locals.push(localBytes, data)
    centrals.push(centralBytes)
    offset += localBytes.length + data.length
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(4, 0, true)
  end.setUint16(6, 0, true)
  end.setUint16(8, centrals.length, true)
  end.setUint16(10, centrals.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  end.setUint16(20, 0, true)

  const total = offset + centralSize + 22
  const out = new Uint8Array(total)
  let p = 0
  for (const b of [...locals, ...centrals, new Uint8Array(end.buffer)]) {
    out.set(b, p)
    p += b.length
  }
  return out
}

/** ブラウザでダウンロードさせる */
export function downloadBytes(bytes: Uint8Array, filename: string, mime = 'application/zip'): void {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
