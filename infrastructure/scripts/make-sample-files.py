"""Sinh s.docx tối thiểu chứa một chuỗi định danh, dùng cho e2e (không cần thư viện ngoài).
PDF dùng tệp mẫu cố định fixtures/sample.pdf (PDF ghép tay không được pdf.js chấp nhận).
Dùng: python make-sample-files.py <thư mục> <token DOCX>"""
import sys, zipfile, os

out, tok_docx = sys.argv[1], sys.argv[2]

# ---- DOCX tối thiểu
ct = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
doc = f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quy che luong thuong. Ma tham chieu: {tok_docx}</w:t></w:r></w:p></w:body></w:document>'
with zipfile.ZipFile(os.path.join(out, "s.docx"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", ct)
    z.writestr("_rels/.rels", rels)
    z.writestr("word/document.xml", doc)
