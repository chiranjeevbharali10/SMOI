"""Build the SMOI demo corpus from pinned Wikipedia revisions (standard library only).

    python eval/corpus/build_corpus.py --pin    # record the current revision of every article in manifest.json
    python eval/corpus/build_corpus.py          # rebuild docs/ from the pinned revisions

Each article's rendered HTML is fetched for its pinned revision and reduced to headings and
paragraphs. Tables, infoboxes, images, maths, footnote markers and the reference sections are
removed. The text is then written in the format the manifest names:

- .txt: UTF-8, a blank line between paragraphs
- .docx: a minimal Word file whose headings use "heading N" styles
- .pdf: a text-only PDF (Helvetica, no images), so the PDF parser is exercised without
  redistributing any image, whose licence may differ from the article's

Wikipedia text is licensed CC BY-SA 4.0. SOURCES.md, written by this script, gives the
attribution and licence for every file. The generated files are committed, so the evaluation
doesn't need the network; this script documents exactly how they were made.
"""

import argparse
import html
import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "manifest.json"
DOCS = HERE / "docs"
API = "https://en.wikipedia.org/w/api.php"
USER_AGENT = "SMOI-eval/0.1 (https://github.com/chiranjeevbharali10/SMOI; corpus builder)"

# Sections that hold references or links rather than article text.
STOP_SECTIONS = {
    "see also", "notes", "references", "sources", "further reading", "external links",
    "bibliography", "citations", "footnotes", "works cited", "notes and references",
    "explanatory notes", "general and cited references", "cited sources", "literature",
}
SKIP_TAGS = {"table", "style", "script", "figure", "math", "sup", "img", "noscript", "map", "audio", "video"}
SKIP_CLASSES = {
    "reflist", "references", "navbox", "hatnote", "infobox", "thumb", "mw-editsection", "noprint",
    "metadata", "mbox-small", "sidebar", "mwe-math-element", "gallery", "toc", "shortdescription",
    "mw-empty-elt", "printfooter", "portalbox", "side-box", "ambox", "mw-references-wrap", "reference",
    "plainlinks", "authority-control", "catlinks", "mw-cite-backlink", "IPA", "rt-commentedText",
}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
BLOCK_TAGS = {"p", "li", "dd", "dt", "blockquote"}
HEADING_TAGS = {"h2": 2, "h3": 3, "h4": 4}


def api_get(params: dict) -> dict:
    query = urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    request = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


class ArticleText(HTMLParser):
    """Collects (level, text) blocks: level 0 is a paragraph, 2 to 4 are headings."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks: list[tuple[int, str]] = []
        self.skip_depth = 0
        self.stopped = False
        self.current: list[str] | None = None
        self.current_level = 0

    def handle_starttag(self, tag, attrs):
        if tag in VOID_TAGS:
            return
        if self.skip_depth:
            self.skip_depth += 1
            return
        classes = set((dict(attrs).get("class") or "").split())
        if tag in SKIP_TAGS or classes & SKIP_CLASSES:
            self.skip_depth = 1
            return
        if self.stopped:
            return
        if tag in HEADING_TAGS:
            self.flush()
            self.current, self.current_level = [], HEADING_TAGS[tag]
        elif tag in BLOCK_TAGS:
            self.flush()
            self.current, self.current_level = [], 0

    def handle_endtag(self, tag):
        if tag in VOID_TAGS:
            return
        if self.skip_depth:
            self.skip_depth -= 1
            return
        if tag in HEADING_TAGS or tag in BLOCK_TAGS:
            self.flush()

    def handle_data(self, data):
        if not self.skip_depth and not self.stopped and self.current is not None:
            self.current.append(data)

    def flush(self):
        if self.current is None:
            return
        text = re.sub(r"\s+", " ", "".join(self.current)).strip()
        level = self.current_level
        self.current = None
        if not text:
            return
        if level and text.lower() in STOP_SECTIONS:
            self.stopped = True
            return
        if level and level >= 2 and self.stopped:
            return
        self.blocks.append((level, clean(text)))


def clean(text: str) -> str:
    text = re.sub(r"\[(?:\d+|[a-z]|citation needed|note \d+|nb \d+)\]", "", text)
    text = re.sub(r"\s+([,.;:)])", r"\1", text)
    text = re.sub(r"\(\s*\)", "", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def extract(revid: int) -> tuple[list[tuple[int, str]], list[str]]:
    data = api_get({"action": "parse", "oldid": revid, "prop": "text", "disableeditsection": 1})
    body = data["parse"]["text"]
    parser = ArticleText()
    parser.feed(body)
    parser.flush()
    blocks = [b for b in parser.blocks if b[0] or len(b[1]) >= 20]
    # Drop headings that ended up with no paragraph under them (for example a section that only held a table).
    kept = []
    for i, (level, text) in enumerate(blocks):
        if level:
            following = blocks[i + 1] if i + 1 < len(blocks) else None
            if following is None or (following[0] and following[0] <= level):
                continue
        kept.append((level, text))
    plain = re.sub(r"<[^>]+>", " ", body)
    notices = sorted(set(re.findall(r"This article incorporates[^.]{0,300}\.", html.unescape(plain))))
    return kept, [re.sub(r"\s+", " ", n) for n in notices]


# ---------- writers ----------

def write_txt(path: Path, title: str, blocks):
    parts = [title] + [text for _, text in blocks]
    path.write_text("\n\n".join(parts) + "\n", encoding="utf-8")


def write_docx(path: Path, title: str, blocks):
    w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

    def para(level, text):
        style = f'<w:pPr><w:pStyle w:val="Heading{level}"/></w:pPr>' if level else ""
        return f'<w:p>{style}<w:r><w:t xml:space="preserve">{html.escape(text, quote=False)}</w:t></w:r></w:p>'

    body = para(1, title) + "".join(para(level, text) for level, text in blocks)
    styles = "".join(
        f'<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/></w:style>' for n in range(1, 7))
    parts = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
            '</Types>'),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>'),
        "word/_rels/document.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '</Relationships>'),
        "word/document.xml": f'<?xml version="1.0" encoding="UTF-8"?><w:document {w}><w:body>{body}</w:body></w:document>',
        "word/styles.xml": f'<?xml version="1.0" encoding="UTF-8"?><w:styles {w}>{styles}</w:styles>',
    }
    # A fixed timestamp keeps the file byte-identical between builds.
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in parts.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, content.encode("utf-8"))


PDF_REPLACEMENTS = {"−": "-", " ": " ", " ": " ", " ": " ", "≈": "~", "≤": "<=",
                    "≥": ">=", "′": "'", "″": '"', "‐": "-", "‑": "-", "⁠": ""}


def to_winansi(text: str) -> tuple[bytes, int]:
    """Encode for a standard PDF font (Windows-1252). Returns the bytes and how many characters had to be replaced."""
    out, replaced = [], 0
    for ch in text:
        ch = PDF_REPLACEMENTS.get(ch, ch)
        try:
            out.append(ch.encode("cp1252"))
        except UnicodeEncodeError:
            folded = unicodedata.normalize("NFKD", ch).encode("ascii", "ignore")
            out.append(folded or b"?")
            replaced += 1
    return b"".join(out), replaced


def wrap(text: str, width: int) -> list[str]:
    lines, line = [], ""
    for word in text.split(" "):
        if line and len(line) + 1 + len(word) > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}" if line else word
    if line:
        lines.append(line)
    return lines


def write_pdf(path: Path, title: str, blocks) -> int:
    """A text-only PDF on A4 pages. Paragraphs are separated by a gap of about three lines, which is
    how PDF text extraction recognises a new paragraph. Returns the number of replaced characters."""
    page_w, page_h, margin = 595, 842, 56
    items = [(1, title)] + list(blocks)
    pages, ops, y, replaced = [], [], page_h - margin, 0

    def new_page():
        nonlocal ops, y
        if ops:
            pages.append(b"\n".join(ops))
        ops, y = [], page_h - margin

    for level, text in items:
        size, font, width = (16, "F2", 60) if level == 1 else (12.5, "F2", 76) if level else (10, "F1", 95)
        leading = size * 1.35
        lines = wrap(text, width)
        if y - leading * min(len(lines), 2) < margin:
            new_page()
        for line in lines:
            if y - leading < margin:
                new_page()
            y -= leading
            encoded, n = to_winansi(line)
            replaced += n
            escaped = encoded.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
            ops.append(b"BT /%s %.1f Tf %d %.1f Td (%s) Tj ET" % (font.encode(), size, margin, y, escaped))
        y -= leading * 2.2
    new_page()

    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", None,
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"]
    page_ids = []
    for content in pages:
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(content), content))
        content_id = len(objects)
        objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents %d 0 R >>"
                       % (page_w, page_h, content_id))
        page_ids.append(len(objects))
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % i for i in page_ids), len(page_ids))

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    path.write_bytes(bytes(out))
    return replaced


# ---------- commands ----------

def pin(manifest: dict):
    titles = [d["title"] for d in manifest["documents"]]
    data = api_get({"action": "query", "titles": "|".join(titles), "prop": "revisions", "rvprop": "ids|timestamp"})
    by_title = {p["title"]: p for p in data["query"]["pages"]}
    for d in manifest["documents"]:
        page = by_title.get(d["title"])
        if not page or "missing" in page:
            sys.exit(f"Article not found: {d['title']}")
        rev = page["revisions"][0]
        d["revid"], d["revision_timestamp"] = rev["revid"], rev["timestamp"]
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Pinned {len(titles)} revisions in {MANIFEST.name}")


def build(manifest: dict):
    rows = []
    for d in manifest["documents"]:
        if "revid" not in d:
            sys.exit("manifest.json has unpinned articles; run with --pin first")
        blocks, notices = extract(d["revid"])
        out_dir = DOCS / d["group"]
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / d["file"]
        replaced = 0
        suffix = path.suffix
        if suffix == ".txt":
            write_txt(path, d["title"], blocks)
        elif suffix == ".docx":
            write_docx(path, d["title"], blocks)
        elif suffix == ".pdf":
            replaced = write_pdf(path, d["title"], blocks)
        else:
            sys.exit(f"Unsupported format: {d['file']}")
        words = sum(len(text.split()) for _, text in blocks)
        rows.append((d, words, path.stat().st_size, replaced, notices))
        print(f"{d['group']:10} {d['file']:28} {words:6} words {path.stat().st_size:8} bytes"
              + (f"  ({replaced} characters replaced for the PDF font)" if replaced else ""))
    write_sources(rows)


def write_sources(rows):
    lines = [
        "# Corpus sources and licences",
        "",
        "Generated by `eval/corpus/build_corpus.py`. Do not edit by hand.",
        "",
        "Every document is the text of an English Wikipedia article at the revision listed, by Wikipedia",
        "contributors, licensed under the [Creative Commons Attribution-ShareAlike 4.0 International",
        "licence](https://creativecommons.org/licenses/by-sa/4.0/) (CC BY-SA 4.0). The list of authors of",
        "each article is its history page, linked below.",
        "",
        "**Changes made:** tables, infoboxes, images, captions, maths, footnote markers and the reference",
        "sections (See also, Notes, References, External links and similar) were removed, and the remaining",
        "headings and paragraphs were saved as plain text, a Word file or a text-only PDF. In the PDFs,",
        "characters outside the Windows-1252 character set were replaced with the nearest ASCII character",
        "or `?` (count below).",
        "",
        "These files are licensed under CC BY-SA 4.0 as adaptations. That licence applies to the files in",
        "`eval/corpus/docs/` only, not to the rest of this repository.",
        "",
        "| Group | File | Article | Revision | Words | Notes |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for d, words, size, replaced, notices in rows:
        title_url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(d["title"].replace(" ", "_"))
        rev_url = f"https://en.wikipedia.org/w/index.php?oldid={d['revid']}"
        hist_url = "https://en.wikipedia.org/w/index.php?" + urllib.parse.urlencode({"title": d["title"], "action": "history"})
        notes = []
        if replaced:
            notes.append(f"{replaced} characters replaced")
        notes.extend(f"Upstream notice: {n}" for n in notices)
        lines.append(f"| {d['group']} | `{d['file']}` | [{d['title']}]({title_url}) ([authors]({hist_url})) "
                     f"| [{d['revid']}]({rev_url}), {d['revision_timestamp'][:10]} | {words} | {'; '.join(notes) or ''} |")
    (HERE / "SOURCES.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pin", action="store_true", help="record the current revision of every article")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if args.pin:
        pin(manifest)
    else:
        build(manifest)


if __name__ == "__main__":
    main()
