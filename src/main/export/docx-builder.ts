/**
 * 零依赖 DOCX builder（P2-D T2）——OPC/OOXML（ECMA-376）最小真子集。
 *
 * 部件序（OPC 惯例：[Content_Types].xml 首位）：
 *   [Content_Types].xml / _rels/.rels / word/document.xml /
 *   word/styles.xml / word/_rels/document.xml.rels
 * document.xml：Title 段（书名）→ 每章 Heading1 段（章标）→ 正文段 Normal；
 * 段落口径同 book-doc：一段一 <w:p>，段内软换行 \n 在同一次运行内展开为
 * <w:br/>（不新增段落），每视觉行一个 <w:t>。
 * 确定性来自 zip-writer 固定 DOS 时间；部件内容无时间戳/随机 id。
 */
import { buildZip, type ZipEntry } from './zip-writer';
import { escapeXml, parasOf, type ChaptersDoc } from './book-doc';

function renderDocument(doc: ChaptersDoc): string {
  const blocks: string[] = [];
  blocks.push(
    `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(doc.title)}</w:t></w:r></w:p>`,
  );
  for (const ch of doc.chapters) {
    blocks.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(ch.label)}</w:t></w:r></w:p>`,
    );
    for (const p of parasOf(ch.body)) {
      const runs = p
        .split('\n')
        .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
        .join('<w:br/>');
      blocks.push(`<w:p><w:r>${runs}</w:r></w:p>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${blocks.join('\n    ')}
  </w:body>
</w:document>
`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>
`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="200" w:line="360" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:sz w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:after="400"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="48"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="400" w:after="200"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
  </w:style>
</w:styles>
`;

export function buildDocx(doc: ChaptersDoc): Buffer {
  const utf8 = (s: string) => Buffer.from(s, 'utf8');
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: utf8(ROOT_RELS) },
    { name: 'word/document.xml', data: utf8(renderDocument(doc)) },
    { name: 'word/styles.xml', data: utf8(STYLES_XML) },
    { name: 'word/_rels/document.xml.rels', data: utf8(DOCUMENT_RELS) },
  ];
  return buildZip(entries);
}
