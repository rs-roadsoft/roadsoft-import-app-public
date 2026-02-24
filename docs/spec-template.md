---
pdf_options:
  format: A4
  margin: 12mm 18mm
  displayHeaderFooter: true
  headerTemplate: '<span></span>'
  footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#888;">{{footer}}</div>'
css: |-
  body { font-family: 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 9pt; color: #333; line-height: 1.25; }
  h1 { font-size: 16pt; color: #1a5276; border-bottom: 2px solid #1a5276; padding-bottom: 2px; margin-bottom: 4px; margin-top: 0; }
  h2 { font-size: 10.5pt; color: #1a5276; margin-top: 6px; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; margin-top: 2px; }
  th { background-color: #1a5276; color: white; padding: 3px 5px; text-align: left; }
  td { border: 1px solid #ddd; padding: 3px 5px; }
  tr:nth-child(even) { background-color: #f5f8fa; }
  .subtitle { font-size: 9.5pt; color: #666; margin-top: -4px; margin-bottom: 2px; }
  ul { margin-top: 2px; margin-bottom: 2px; padding-left: 16px; }
  li { margin-bottom: 0; }
  li strong { font-size: 10pt; color: #1a5276; }
  .note { background: #fef9e7; border-left: 3px solid #f39c12; padding: 2px 7px; font-size: 8.5pt; margin: 3px 0; }
  p { margin-top: 2px; margin-bottom: 2px; }
  .header { display: flex; align-items: center; gap: 10px; border-bottom: 2px solid #1a5276; padding-bottom: 4px; margin-bottom: 4px; }
  .header svg { width: 36px; height: 36px; flex-shrink: 0; }
  .header h1 { color: #000; border-bottom: none; margin: 0; padding: 0; font-size: 20pt; line-height: 1; }
  .header h1 .sep { color: #000; font-weight: 300; margin: 0 4px; }
  .header h1 .app-suffix { font-size: 14pt; font-weight: 600; color: #555; }
---

<div class="header">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><g><path fill="#000" d="M397.77,322.67l48.92,65.22A182.74,182.74,0,0,0,523,239.21h0a183,183,0,0,0-183-183H76.28V543.79H523L370.71,340.74H279.33l73.1,121.83H157.5V137.68h0l24.37,40.61h67l-30.46-40.61H340A101.53,101.53,0,0,1,441.52,239.21h0A101.35,101.35,0,0,1,397.77,322.67Z"/><polygon fill="#000" points="279.33 218.91 206.24 218.91 254.97 300.13 340.25 300.13 279.33 218.91"/></g></svg>

<h1>RoadSoft <span class="sep">|</span> <span class="app-suffix">{{app_suffix}}</span></h1>
</div>

<p class="subtitle">{{subtitle}}</p>

## {{section_overview}}

- **{{label_name}}:** {{app_name}}
- **{{label_purpose}}:** {{purpose}}
- **{{label_type}}:** {{type}}
- **{{label_platforms}}:** Windows 10/11 (x64)

## {{section_requirements}}

| {{col_requirement}} | {{col_specification}} |
| ------------------- | ----------------------------------------------------- |
| {{label_os}}        | {{os_value}}                                          |
| {{label_disk}}      | ~250 MB                                               |
| {{label_ram}}       | {{ram_value}}                                         |

## {{section_installation}}

- **{{label_installer_type}}:**
  - Windows: NSIS {{installer_desc}} (`.exe`)
- **{{label_privileges}}:** {{privileges_value}}

<div class="note"><p><strong>{{important_label}}:</strong> {{important_peruser}}</p></div>

## {{section_locations}}

- **{{label_app}}:**
  `C:\Users\{{{username_placeholder}}}\AppData\Local\Programs\RoadSoft\`
- **{{label_userdata}}** ({{userdata_desc}}):
  `C:\Users\{{{username_placeholder}}}\AppData\Roaming\RoadSoft\`
  - `config.db` — {{db_desc}}
  - `log.txt` — {{log_desc}}

<div class="note"><p><strong>{{note_label}}:</strong> {{note_hidden}}</p></div>

## {{section_file_processing}}

{{file_processing_intro}}

| {{col_folder}} | {{col_purpose}} | {{col_contents}} |
| -------------- | --------------- | ---------------- |
| `Archived/`    | {{archived_purpose}} | {{archived_contents}} |
| `Failed/`      | {{failed_purpose}} | {{failed_contents}} |

<div class="note"><p><strong>{{note_label}}:</strong> {{note_file_processing}}</p></div>

<div class="note"><p><strong>{{note_label}}:</strong> {{note_zip_trash}}</p></div>

## {{section_updates}}

- **{{autolaunch}}**
- **{{tray}}**
