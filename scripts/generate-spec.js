const { mdToPdf } = require('md-to-pdf');
const {
  Document,
  Paragraph,
  TextRun,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  ShadingType,
  Packer,
  PageNumber,
  NumberFormat,
  TableLayoutType,
  convertMillimetersToTwip,
} = require('docx');
const fs = require('fs');
const path = require('path');

const LOCALES = ['en', 'nl', 'de'];
const docsDir = path.join(__dirname, '..', 'docs');
const template = fs.readFileSync(path.join(docsDir, 'spec-template.md'), 'utf-8');
const logoPng = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'images', 'app-512.png'));

// ─── Style constants (match PDF) ───
const BLUE = '1a5276';
const GRAY = '333333';
const LIGHT_GRAY = 'DDDDDD';
const NOTE_BG = 'FEF9E7';
const NOTE_BORDER = 'F39C12';
const TABLE_EVEN_BG = 'F5F8FA';
const FONT = 'Segoe UI';
const PT = 2; // half-points per pt

const bodySize = 9 * PT;
const smallSize = 8.5 * PT;
const h2Size = 10.5 * PT;

// ─── Helpers ───

/** Strip HTML tags for docx plain text */
function stripHtml(str) {
  return str.replace(/<[^>]+>/g, '');
}

/** Parse bold fragments from text containing <strong> tags. Returns TextRun[] */
function parseRuns(text, opts = {}) {
  const size = opts.size || bodySize;
  const font = opts.font || FONT;
  const color = opts.color || GRAY;
  const parts = text.split(/(<strong>.*?<\/strong>)/g);
  return parts
    .filter((p) => p.length > 0)
    .map((part) => {
      const boldMatch = part.match(/^<strong>(.*?)<\/strong>$/);
      if (boldMatch) {
        return new TextRun({ text: boldMatch[1], bold: true, size, font, color });
      }
      return new TextRun({ text: stripHtml(part), size, font, color });
    });
}

function heading2(text) {
  return new Paragraph({
    spacing: { before: 120, after: 40 },
    children: [new TextRun({ text, bold: true, size: h2Size, font: FONT, color: BLUE })],
    border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: BLUE } },
  });
}

function bulletItem(label, value, opts = {}) {
  const runs = [new TextRun({ text: label + ': ', bold: true, size: bodySize, font: FONT, color: BLUE })];
  if (typeof value === 'string' && value.includes('<strong>')) {
    runs.push(...parseRuns(value));
  } else {
    runs.push(new TextRun({ text: stripHtml(value), size: bodySize, font: FONT, color: GRAY }));
  }
  return new Paragraph({ bullet: { level: opts.level || 0 }, spacing: { after: 20 }, children: runs });
}

function simpleBullet(text, opts = {}) {
  return new Paragraph({
    bullet: { level: opts.level || 0 },
    spacing: { after: 20 },
    children: parseRuns(text, opts),
  });
}

function noteBlock(label, text) {
  return new Paragraph({
    spacing: { before: 200, after: 60 },
    indent: { left: convertMillimetersToTwip(2) },
    border: { left: { style: BorderStyle.SINGLE, size: 6, color: NOTE_BORDER } },
    shading: { type: ShadingType.CLEAR, fill: NOTE_BG },
    children: [
      new TextRun({ text: label + ': ', bold: true, size: smallSize, font: FONT, color: GRAY }),
      ...parseRuns(text, { size: smallSize }),
    ],
  });
}

function bodyParagraph(text) {
  return new Paragraph({
    spacing: { after: 40 },
    children: parseRuns(text),
  });
}

const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: LIGHT_GRAY };

function makeTable(headers, rows) {
  const colCount = headers.length;
  const tableWidth = convertMillimetersToTwip(174); // A4 (210mm) minus margins (18+18mm)
  const colWidth = Math.floor(tableWidth / colCount);

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(
      (h) =>
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill: BLUE },
          width: { size: colWidth, type: WidthType.DXA },
          children: [
            new Paragraph({
              children: [new TextRun({ text: h, bold: true, size: smallSize, font: FONT, color: 'FFFFFF' })],
            }),
          ],
        }),
    ),
  });

  const dataRows = rows.map(
    (cells, idx) =>
      new TableRow({
        children: cells.map(
          (cellText) =>
            new TableCell({
              shading: idx % 2 === 1 ? { type: ShadingType.CLEAR, fill: TABLE_EVEN_BG } : undefined,
              width: { size: colWidth, type: WidthType.DXA },
              borders: { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: stripHtml(cellText), size: smallSize, font: FONT, color: GRAY })],
                }),
              ],
            }),
        ),
      }),
  );

  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: tableWidth, type: WidthType.DXA },
    columnWidths: Array(colCount).fill(colWidth),
    rows: [headerRow, ...dataRows],
  });
}

// ─── DOCX generation ───

async function generateDocx(i18n, locale) {
  const children = [];

  // Header: logo + title
  children.push(
    new Paragraph({
      spacing: { after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: BLUE } },
      children: [
        new ImageRun({ data: logoPng, transformation: { width: 36, height: 36 }, type: 'png' }),
        new TextRun({ text: '  RoadSoft ', size: 20 * PT, font: FONT, bold: true }),
        new TextRun({ text: '| ', size: 20 * PT, font: FONT, color: '000000' }),
        new TextRun({ text: i18n.app_suffix, size: 14 * PT, font: FONT, bold: true, color: '555555' }),
      ],
    }),
  );

  // Subtitle
  children.push(
    new Paragraph({
      spacing: { after: 40 },
      children: [
        new TextRun({
          text: stripHtml(i18n.subtitle.replace('&mdash;', '—')),
          size: 9.5 * PT,
          font: FONT,
          color: '666666',
        }),
      ],
    }),
  );
  children.push(new Paragraph({ spacing: { after: 80 } }));

  // Section: Overview
  children.push(heading2(i18n.section_overview));
  children.push(bulletItem(i18n.label_name, i18n.app_name));
  children.push(bulletItem(i18n.label_purpose, stripHtml(i18n.purpose)));
  children.push(bulletItem(i18n.label_type, i18n.type));
  children.push(bulletItem(i18n.label_platforms, 'Windows 10/11 (x64)'));
  children.push(new Paragraph({ spacing: { after: 80 } }));

  // Section: Requirements
  children.push(heading2(i18n.section_requirements));
  children.push(
    makeTable(
      [i18n.col_requirement, i18n.col_specification],
      [
        [i18n.label_os, i18n.os_value],
        [i18n.label_disk, '~250 MB'],
        [i18n.label_ram, i18n.ram_value],
      ],
    ),
  );
  children.push(new Paragraph({ spacing: { after: 80 } }));

  // Section: Installation
  children.push(heading2(i18n.section_installation));
  children.push(bulletItem(i18n.label_installer_type, ''));
  children.push(simpleBullet(`Windows: NSIS ${i18n.installer_desc} (.exe)`, { level: 1 }));
  children.push(new Paragraph({ spacing: { after: 80 } }));
  children.push(bulletItem(i18n.label_privileges, i18n.privileges_value));
  children.push(noteBlock(i18n.important_label, i18n.important_peruser));
  children.push(new Paragraph({ spacing: { after: 80 } }));

  // Section: File Locations
  children.push(heading2(i18n.section_locations));
  children.push(
    bulletItem(i18n.label_app, `C:\\Users\\{${i18n.username_placeholder}}\\AppData\\Local\\Programs\\RoadSoft\\`),
  );
  children.push(
    bulletItem(
      `${i18n.label_userdata} (${i18n.userdata_desc})`,
      `C:\\Users\\{${i18n.username_placeholder}}\\AppData\\Roaming\\RoadSoft\\`,
    ),
  );
  children.push(simpleBullet(`config.db — ${i18n.db_desc}`, { level: 1 }));
  children.push(simpleBullet(`log.txt — ${i18n.log_desc}`, { level: 1 }));
  children.push(noteBlock(i18n.note_label, i18n.note_hidden));
  children.push(new Paragraph({ spacing: { after: 80 } }));

  // Section: File Processing & Storage
  children.push(heading2(i18n.section_file_processing));
  children.push(bodyParagraph(stripHtml(i18n.file_processing_intro)));
  children.push(
    makeTable(
      [i18n.col_folder, i18n.col_purpose, i18n.col_contents],
      [
        ['Archived/', i18n.archived_purpose, i18n.archived_contents],
        ['Failed/', i18n.failed_purpose, stripHtml(i18n.failed_contents)],
      ],
    ),
  );
  children.push(noteBlock(i18n.note_label, i18n.note_file_processing));
  children.push(noteBlock(i18n.note_label, i18n.note_zip_trash));
  children.push(new Paragraph({ spacing: { after: 80 } }));

  // Section: Updates
  children.push(heading2(i18n.section_updates));
  children.push(simpleBullet(i18n.autolaunch));
  children.push(simpleBullet(i18n.tray));

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
            margin: {
              top: convertMillimetersToTwip(12),
              bottom: convertMillimetersToTwip(12),
              left: convertMillimetersToTwip(18),
              right: convertMillimetersToTwip(18),
            },
          },
        },
        footers: {
          default: {
            options: {
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({ text: i18n.footer + '  —  ', size: 8 * PT, font: FONT, color: '888888' }),
                    new TextRun({ children: [PageNumber.CURRENT], size: 8 * PT, font: FONT, color: '888888' }),
                  ],
                }),
              ],
            },
          },
        },
        children,
      },
    ],
    numbering: {
      config: [
        {
          reference: 'default-bullet',
          levels: [
            { level: 0, format: NumberFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT },
            { level: 1, format: NumberFormat.BULLET, text: '\u25E6', alignment: AlignmentType.LEFT },
          ],
        },
      ],
    },
  });

  const buffer = await Packer.toBuffer(doc);
  const dest = path.join(docsDir, `CLIENT_SPECIFICATION_${locale}.docx`);
  fs.writeFileSync(dest, buffer);
  console.log(`Generated: CLIENT_SPECIFICATION_${locale}.docx`);
}

// ─── Main ───

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
    await generateDocx(i18n, locale);
  }
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
