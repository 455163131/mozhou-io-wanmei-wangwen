/**
 * 最小 ZIP 容器写手 + 读取器（P2-D T2，零依赖）。
 * local header(0x04034b50) + central directory(0x02014b50) + EOCD(0x06054b50)。
 * 压缩走 node:zlib deflateRaw；stored 供 EPUB mimetype 规范用。
 * DOS 时间固定 1980-01-01 00:00（确定性字节——同输入同 Buffer，hash 可审计）。
 * ★ 只读自身写入的结构（readZipEntries 不做通用容错）：往返自证够用，
 *   通用解压器的宽容不是本模块的责任面。
 *
 * 字段偏移核对 APPNOTE 6.3.x（与 PKWARE .ZIP 规范一致，未做任何迁就）：
 *   local   ：sig@0 ver@4 flags@6 method@8 time@10 date@12 crc@14
 *             csize@18 usize@22 namelen@26 extralen@28，共 30 字节头。
 *   central ：sig@0 madever@4 ver@6 flags@8 method@10 time@12 date@14 crc@16
 *             csize@20 usize@24 namelen@28 extralen@30 commentlen@32
 *             disk@34 intattr@36 extattr@38 localoff@42，共 46 字节头。
 *   EOCD    ：sig@0 disk@4 cddisk@6 countDisk@8 countTotal@10
 *             cdsize@12 cdoffset@16 commentlen@20，共 22 字节。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
  stored?: boolean;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = 0x0021; // 1980-01-01（(0<<9)|(1<<5)|1）
const NAME_FLAG = 0x0800; // UTF-8 名

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = e.stored ? e.data : deflateRawSync(e.data, { level: 9 });
    const method = e.stored ? 0 : 8;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(NAME_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(NAME_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export function readZipEntries(zip: Buffer): Array<{ name: string; data: Buffer; method: 0 | 8 }> {
  const out: Array<{ name: string; data: Buffer; method: 0 | 8 }> = [];
  if (zip.length === 0) return out;
  let p = 0;
  while (p + 4 <= zip.length && zip.readUInt32LE(p) === 0x04034b50) {
    const flags = zip.readUInt16LE(p + 6);
    const method = zip.readUInt16LE(p + 8) as 0 | 8;
    const compSize = zip.readUInt32LE(p + 18);
    const nameLen = zip.readUInt16LE(p + 26);
    const extraLen = zip.readUInt16LE(p + 28);
    const name = zip.subarray(p + 30, p + 30 + nameLen).toString(flags & NAME_FLAG ? 'utf8' : 'latin1');
    const dataStart = p + 30 + nameLen + extraLen;
    const raw = zip.subarray(dataStart, dataStart + compSize);
    out.push({ name, method, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    p = dataStart + compSize;
  }
  return out;
}
