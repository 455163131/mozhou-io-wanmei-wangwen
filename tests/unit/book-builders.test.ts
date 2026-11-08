// tests/unit/book-builders.test.ts
import { describe, it, expect } from 'vitest';
import { readZipEntries } from '@main/export/zip-writer';
import { toChaptersDoc, escapeXml, parasOf } from '@main/export/book-doc';
import { txtDoc, mdDoc } from '@main/export/txt-md';
import { buildEpub } from '@main/export/epub-builder';
import { buildDocx } from '@main/export/docx-builder';

describe('book-doc 与容器 builder', () => {
  const doc = toChaptersDoc({
    title: '测试<书> & "符号"',
    lang: 'zh',
    chapters: [
      { label: '第一章 起', body: '第一段。\n第二段。\n\n第三段（空行分开）。' },
      { label: '第二章 承', body: '独白。**残留**' },
    ],
  });
  it('escapeXml 五字符全覆盖，& 先行', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
  it('parasOf：空行成段界，段内软换行原样保留（不切段）', () => {
    expect(parasOf('a\n\n\nb')).toEqual(['a', 'b']);
    // 歧义探针的语义钉：'第一段。\n第二段。' 之间是单个 \n（软换行），不算段界，
    // 与 '第三段…' 之间是空行（\n\n），算段界 → ch1 共 2 段。
    expect(parasOf('第一段。\n第二段。\n\n第三段（空行分开）。')).toEqual([
      '第一段。\n第二段。',
      '第三段（空行分开）。',
    ]);
  });
  it('txt：章标+空行+正文，章间分隔线', () => {
    const t = txtDoc(doc);
    expect(t).toContain('第一章 起');
    expect(t.split('\n---\n')).toHaveLength(2);
  });
  it('md：## 前缀', () => {
    expect(mdDoc(doc)).toContain('## 第一章 起');
  });
  it('epub：mimetype 首条目 stored；xhtml 段数=parasOf；软换行渲染 <br/>；标题转义；ncx 存在', () => {
    const es = readZipEntries(buildEpub(doc));
    expect(es[0].name).toBe('mimetype');
    expect(es[0].method).toBe(0);
    expect(es[0].data.toString()).toBe('application/epub+zip');
    const names = es.map((e) => e.name);
    expect(names).toContain('EPUB/content.opf');
    expect(names).toContain('EPUB/toc.ncx');
    expect(names).toContain('EPUB/chapter-1.xhtml');
    const x1 = es.find((e) => e.name === 'EPUB/chapter-1.xhtml')!.data.toString();
    // 真值核定：parasOf 只按空行运行（/\n\s*\n/）切段，段内单个 \n 是软换行、不切段。
    // 所以 ch1 的样本是【2 段】而非 brief 占位的 3——'第一段。\n第二段。' 合成一个
    // <p>，中间软换行渲染为段内一个 <br/>；'第三段（空行分开）。' 独立成第二个 <p>。
    expect((x1.match(/<p>/g) ?? []).length).toBe(2);
    expect((x1.match(/<br\/>/g) ?? []).length).toBe(1);
    const opf = es.find((e) => e.name === 'EPUB/content.opf')!.data.toString();
    expect(opf).toContain('测试&lt;书&gt; &amp;');
    expect(opf).not.toContain('<书>');
  });
  it('docx：一段一 <w:p>（Title+章标+parasOf 正文段），软换行段内 <w:br/>；标题转义', () => {
    const es = readZipEntries(buildDocx(doc));
    const names = es.map((e) => e.name);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('_rels/.rels');
    expect(names).toContain('word/document.xml');
    expect(names).toContain('word/styles.xml');
    const d = es.find((e) => e.name === 'word/document.xml')!.data.toString();
    const bodyParas = parasOf(doc.chapters[0].body).length + parasOf(doc.chapters[1].body).length;
    // 语义钉定为「一段一 <w:p>，段内软换行用 <w:br/> 展开」。
    // brief 占位断言（<w:t> 总数=bodyParas）与规格要求的结构不符：Title 段与
    // 章标 Heading1 段也必须各带 <w:t> 文本运行，计入后总数必然大于 bodyParas，
    // 故按实现真相断言 <w:p> 总数 = 1（Title）+ 章数（Heading1）+ bodyParas。
    expect((d.match(/<w:p>/g) ?? []).length).toBe(1 + doc.chapters.length + bodyParas);
    expect((d.match(/<w:br\/>/g) ?? []).length).toBe(1);
    expect(d).toContain('测试&lt;书&gt; &amp;');
    expect(d).not.toContain('<书>');
  });
  it('确定性：同 doc 两次 buildEpub 逐字节相等', () => {
    expect(buildEpub(doc).equals(buildEpub(doc))).toBe(true);
  });
});
