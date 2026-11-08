// tests/unit/zip-writer.test.ts
import { describe, it, expect } from 'vitest';
import { buildZip, readZipEntries } from '@main/export/zip-writer';

describe('zip-writer（零依赖手写）', () => {
  it('CRC32 标准向量：crc32("123456789")=0xCBF43926（经往返条目校验）', () => {
    const z = buildZip([{ name: 'a.txt', data: Buffer.from('123456789') }]);
    const [e] = readZipEntries(z);
    expect(e.data.toString()).toBe('123456789');
    // 直接核 local header 里的 CRC 字段
    const crc = z.readUInt32LE(14);
    expect(crc).toBe(0xcbf43926);
  });
  it('deflate 条目确被压（method=8，compSize<uncompSize）', () => {
    const big = Buffer.from('啊'.repeat(5000));
    const z = buildZip([{ name: 'big.txt', data: big }]);
    const [e] = readZipEntries(z);
    expect(e.method).toBe(8);
    expect(z.length).toBeLessThan(big.length);
  });
  it('stored 条目原样存放（mimetype 场景），可带目录名', () => {
    const z = buildZip([
      { name: 'mimetype', data: Buffer.from('application/epub+zip'), stored: true },
      { name: 'META-INF/container.xml', data: Buffer.from('<x/>') },
    ]);
    const es = readZipEntries(z);
    expect(es[0].method).toBe(0);
    expect(es[0].data.toString()).toBe('application/epub+zip');
    expect(es[1].name).toBe('META-INF/container.xml');
  });
  it('中文名 UTF-8 标志位（bit11）置起且往返无损', () => {
    const z = buildZip([{ name: '第一章.txt', data: Buffer.from('x') }]);
    expect(z.readUInt16LE(6) & 0x0800).not.toBe(0);
    expect(readZipEntries(z)[0].name).toBe('第一章.txt');
  });
  it('空册 zip 仍合法（EOCD 签名 + 零条目）', () => {
    const z = buildZip([]);
    expect(z.length).toBe(22);
    expect(z.readUInt32LE(0)).toBe(0x06054b50);
    expect(readZipEntries(z)).toEqual([]);
  });
  it('确定性：同输入两次 buildZip 逐字节相等（DOS 时间固定 1980-01-01）', () => {
    const mk = () => buildZip([{ name: 'a', data: Buffer.from('aa') }]);
    expect(mk().equals(mk())).toBe(true);
  });
});
