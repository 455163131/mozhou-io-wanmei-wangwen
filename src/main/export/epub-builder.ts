/**
 * 零依赖 EPUB builder（P2-D T2）。
 *
 * 最小而真实的 EPUB 3 包（附 NCX 兼容旧阅读器——brief 钉 toc.ncx 必须存在）：
 *   mimetype（★首位、stored、恰为 'application/epub+zip'——EPUB OCF 规范硬性要求）
 *   META-INF/container.xml → EPUB/content.opf
 *   EPUB/toc.ncx / EPUB/style.css / EPUB/chapter-N.xhtml
 *
 * 确定性三处收口（同输入 → 逐字节相等，导出 hash 可审计）：
 *   1) zip-writer 固定 DOS 时间 1980-01-01；
 *   2) dc:identifier = md5(title) 拼 uuid 形——★非加密用途，只求 title→id 稳定；
 *   3) dcterms:modified 固定 1980-01-01T00:00:00Z（EPUB3 必填，取 zip DOS 同一纪元）。
 *
 * 段落口径：parasOf → 一段一 <p>；段内软换行 \n → <br/>（book-doc 文件头）。
 */
import { createHash } from 'node:crypto';
import { buildZip, type ZipEntry } from './zip-writer';
import { escapeXml, parasOf, type ChaptersDoc } from './book-doc';

/** md5-of-title → 8-4-4-4-12 uuid 形。★ 非安全哈希：只要确定性，别在这里找随机性。 */
function uuidFromTitle(title: string): string {
  const h = createHash('md5').update(title, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function renderXhtml(doc: ChaptersDoc, index: number): string {
  const ch = doc.chapters[index];
  const paras = parasOf(ch.body)
    .map((p) => `<p>${escapeXml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n    ');
  const label = escapeXml(ch.label);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${doc.lang}" lang="${doc.lang}">
<head>
<meta charset="utf-8"/>
<title>${label}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
<h1>${label}</h1>
${paras}
</body>
</html>
`;
}

function renderOpf(doc: ChaptersDoc, uuid: string): string {
  const items = doc.chapters
    .map((_, i) => `    <item id="xhtml${i + 1}" href="chapter-${i + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const refs = doc.chapters.map((_, i) => `    <itemref idref="xhtml${i + 1}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeXml(doc.title)}</dc:title>
    <dc:creator>${escapeXml(doc.author)}</dc:creator>
    <dc:language>${doc.lang}</dc:language>
    <meta property="dcterms:modified">1980-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
${items}
  </manifest>
  <spine toc="ncx">
${refs}
  </spine>
</package>
`;
}

function renderNcx(doc: ChaptersDoc, uuid: string): string {
  const points = doc.chapters
    .map(
      (ch, i) =>
        `    <navPoint id="${ch.anchor}" playOrder="${i + 1}">` +
        `<navLabel><text>${escapeXml(ch.label)}</text></navLabel>` +
        `<content src="chapter-${i + 1}.xhtml#${ch.anchor}"/></navPoint>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(doc.title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`;
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const STYLE_CSS = `body { margin: 1em; line-height: 1.6; }
h1 { font-size: 1.4em; }
p { text-indent: 2em; margin: 0.5em 0; }
`;

export function buildEpub(doc: ChaptersDoc): Buffer {
  const uuid = uuidFromTitle(doc.title);
  const utf8 = (s: string) => Buffer.from(s, 'utf8');
  const entries: ZipEntry[] = [
    // ★ EPUB 规范要求 mimetype 是第一个条目、不压缩（method 0）、内容恰为此串。
    { name: 'mimetype', data: utf8('application/epub+zip'), stored: true },
    { name: 'META-INF/container.xml', data: utf8(CONTAINER_XML) },
    { name: 'EPUB/content.opf', data: utf8(renderOpf(doc, uuid)) },
    { name: 'EPUB/toc.ncx', data: utf8(renderNcx(doc, uuid)) },
    ...doc.chapters.map((_, i) => ({
      name: `EPUB/chapter-${i + 1}.xhtml`,
      data: utf8(renderXhtml(doc, i)),
    })),
    { name: 'EPUB/style.css', data: utf8(STYLE_CSS) },
  ];
  return buildZip(entries);
}
