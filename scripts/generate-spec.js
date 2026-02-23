const { mdToPdf } = require('md-to-pdf');
const { marked } = require('marked');
const HTMLtoDOCX = require('html-to-docx');
const fs = require('fs');
const path = require('path');

const LOCALES = ['en', 'nl', 'de'];
const docsDir = path.join(__dirname, '..', 'docs');
const template = fs.readFileSync(path.join(docsDir, 'spec-template.md'), 'utf-8');

/** Strip YAML frontmatter and extract the css field. */
function parseFrontmatter(md) {
  const match = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { css: '', body: md };

  const yaml = match[1];
  const body = match[2];

  // Extract css block (it's a YAML block scalar starting with "css: |-")
  const cssMatch = yaml.match(/^css:\s*\|-?\n([\s\S]*?)(?=\n\w|\n---$|$)/m);
  let css = '';
  if (cssMatch) {
    css = cssMatch[1]
      .split('\n')
      .map((line) => line.replace(/^ {2}/, ''))
      .join('\n');
  }

  return { css, body };
}

async function generate() {
  for (const locale of LOCALES) {
    const i18n = JSON.parse(fs.readFileSync(path.join(docsDir, 'i18n', `${locale}.json`), 'utf-8'));

    let content = template;
    for (const [key, value] of Object.entries(i18n)) {
      content = content.replaceAll(`{{${key}}}`, value);
    }

    // Generate PDF
    const pdfDest = path.join(docsDir, `CLIENT_SPECIFICATION_${locale}.pdf`);
    await mdToPdf({ content }, { dest: pdfDest });
    console.log(`Generated: CLIENT_SPECIFICATION_${locale}.pdf`);

    // Generate DOCX
    const { css, body } = parseFrontmatter(content);
    const htmlBody = marked.parse(body);
    const fullHtml = `<!DOCTYPE html><html><head><style>${css}</style></head><body>${htmlBody}</body></html>`;

    const docxBuffer = await HTMLtoDOCX(fullHtml, null, {
      pageSize: { width: 11906, height: 16838 }, // A4
      margins: { top: 850, bottom: 850, left: 1134, right: 1134 }, // 15mm / 20mm
      font: 'Segoe UI',
      fontSize: 18, // 9pt in HIP
      table: { row: { cantSplit: true } },
      footer: true,
      pageNumber: true,
    });

    const docxDest = path.join(docsDir, `CLIENT_SPECIFICATION_${locale}.docx`);
    fs.writeFileSync(docxDest, docxBuffer);
    console.log(`Generated: CLIENT_SPECIFICATION_${locale}.docx`);
  }
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
