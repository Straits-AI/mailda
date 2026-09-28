/**
 * A stored (uncompressed) ZIP built by hand from the format's own layout: local headers, then the central
 * directory, then the end record. `zipEntries` reads only the last two, which is the whole point.
 */
export function zipOf(entries: Array<[name: string, content: string]>, opts: { comment?: string; zip64?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, content] of entries) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...nameBytes, ...data,
    ]);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0),
      ...u16(0), ...u32(0), ...u32(offset), ...nameBytes,
    ]));
    parts.push(local);
    offset += local.length;
  }
  const directory = central.reduce((n, one) => n + one.length, 0);
  const comment = enc.encode(opts.comment ?? "");
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(directory), ...u32(opts.zip64 === true ? 0xffffffff : offset), ...u16(comment.length), ...comment,
  ]);
  const whole = new Uint8Array(offset + directory + eocd.length);
  let at = 0;
  for (const one of [...parts, ...central, eocd]) { whole.set(one, at); at += one.length; }
  return whole;
}
