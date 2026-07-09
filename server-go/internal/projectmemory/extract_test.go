package projectmemory

import (
	"archive/zip"
	"bytes"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

// makeZip builds an in-memory zip from name→content pairs.
func makeZip(t testing.TB, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, content := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// makePDF constructs a minimal valid single-page PDF whose content stream shows
// `text` via a Tj operator, with a correct xref so poppler parses it cleanly.
func makePDF(text string) []byte {
	var b bytes.Buffer
	off := make([]int64, 6)
	b.WriteString("%PDF-1.4\n")
	off[1] = int64(b.Len())
	b.WriteString("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
	off[2] = int64(b.Len())
	b.WriteString("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n")
	off[3] = int64(b.Len())
	b.WriteString("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n")
	stream := "BT /F1 12 Tf 72 700 Td (" + text + ") Tj ET"
	off[4] = int64(b.Len())
	fmt.Fprintf(&b, "4 0 obj\n<< /Length %d >>\nstream\n%s\nendstream\nendobj\n", len(stream), stream)
	off[5] = int64(b.Len())
	b.WriteString("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n")
	xref := int64(b.Len())
	b.WriteString("xref\n0 6\n")
	fmt.Fprintf(&b, "%010d %05d f \n", 0, 65535)
	for i := 1; i <= 5; i++ {
		fmt.Fprintf(&b, "%010d %05d n \n", off[i], 0)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", xref)
	return b.Bytes()
}

func docxFixture(text string) []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>` + text + `</w:t></w:r></w:p></w:body></w:document>`)
}

func pptxFixture(text string) []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>` + text + `</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`)
}

func xlsxFixture(t testing.TB) []byte {
	return makeZip(t, map[string]string{
		"xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>Name</t></si><si><t>Value</t></si></sst>`,
		"xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>`,
	})
}

func TestSupported(t *testing.T) {
	cases := []struct {
		mime, name string
		want       bool
	}{
		{"application/pdf", "a.pdf", true},
		{"", "a.pdf", true},
		{"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", true},
		{"application/vnd.openxmlformats-officedocument.presentationml.presentation", "a.pptx", true},
		{"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx", true},
		{"text/plain", "a.txt", false},
		{"application/octet-stream", "a.bin", false},
	}
	for _, c := range cases {
		if got := Supported(c.mime, c.name); got != c.want {
			t.Errorf("Supported(%q,%q)=%v want %v", c.mime, c.name, got, c.want)
		}
	}
}

func TestExtractText(t *testing.T) {
	cases := []struct {
		name     string
		mime     string
		filename string
		data     []byte
		want     string // substring expected in extracted text
		wantErr  bool
	}{
		{
			name:     "docx",
			mime:     "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			filename: "doc.docx",
			data:     makeZip(t, map[string]string{"word/document.xml": string(docxFixture("Hello DOCX"))}),
			want:     "Hello DOCX",
		},
		{
			name:     "pptx",
			mime:     "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			filename: "deck.pptx",
			data:     makeZip(t, map[string]string{"ppt/slides/slide1.xml": string(pptxFixture("Slide One"))}),
			want:     "Slide One",
		},
		{
			name:     "xlsx",
			mime:     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			filename: "sheet.xlsx",
			data:     xlsxFixture(t),
			want:     "Name",
		},
		{
			name:     "pdf",
			mime:     "application/pdf",
			filename: "doc.pdf",
			data:     makePDF("Hello PDF"),
			want:     "Hello PDF",
		},
		{
			name:     "corrupt docx (not a zip)",
			mime:     "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			filename: "x.docx",
			data:     []byte("definitely not a zip file"),
			wantErr:  true,
		},
		{
			name:     "corrupt pdf",
			mime:     "application/pdf",
			filename: "x.pdf",
			data:     []byte("not a pdf at all"),
			wantErr:  true,
		},
		{
			name:     "unsupported type",
			mime:     "image/png",
			filename: "x.png",
			data:     []byte("anything"),
			wantErr:  true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			text, trunc, err := ExtractText(c.data, c.mime, c.filename)

			// PDF extraction needs pdftotext on PATH; skip gracefully if absent.
			if err != nil && c.name == "pdf" && strings.Contains(err.Error(), "pdftotext not found") {
				t.Skip("pdftotext not available in this build")
			}

			if c.wantErr {
				if err == nil {
					t.Fatalf("expected error, got text=%q trunc=%v", text, trunc)
				}
				return
			}
			if err != nil {
				t.Fatalf("ExtractText: unexpected error: %v", err)
			}
			if !strings.Contains(text, c.want) {
				t.Fatalf("extracted text %q does not contain %q", text, c.want)
			}
		})
	}
}

// TestExtractTextNoPanic feeds garbage into every format path and confirms the
// recover wrapper turns any panic into an error rather than crashing the test.
func TestExtractTextNoPanic(t *testing.T) {
	garbage := []byte{0x00, 0x01, 0x02, 'P', 'K', 0x03, 0x04, 0xff, 0xfe}
	formats := []struct{ mime, name string }{
		{"application/pdf", "x.pdf"},
		{"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x.docx"},
		{"application/vnd.openxmlformats-officedocument.presentationml.presentation", "x.pptx"},
		{"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x.xlsx"},
	}
	for _, f := range formats {
		f := f
		t.Run(f.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("ExtractText panicked on %s: %v", f.name, r)
				}
			}()
			_, _, _ = ExtractText(garbage, f.mime, f.name)
			// An error (or even empty success) is fine; a panic is not. The PDF
			// case may skip internally only when pdftotext is missing — here we
			// just assert no panic escapes.
		})
	}
}

func TestTruncation(t *testing.T) {
	// Build a DOCX whose <w:t> holds well over 250k characters.
	big := strings.Repeat("a", textCharCap+5000)
	data := makeZip(t, map[string]string{"word/document.xml": string(docxFixture(big))})
	text, trunc, err := ExtractText(data, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "big.docx")
	if err != nil {
		t.Fatalf("ExtractText: %v", err)
	}
	if !trunc {
		t.Fatal("expected truncated=true for oversized text")
	}
	if rc := utf8.RuneCountInString(text); rc > textCharCap {
		t.Fatalf("extracted text rune count %d exceeds cap %d", rc, textCharCap)
	}
	// Under-cap input must not be truncated.
	small := strings.Repeat("b", 1000)
	sdata := makeZip(t, map[string]string{"word/document.xml": string(docxFixture(small))})
	if _, trunc2, err := ExtractText(sdata, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "s.docx"); err != nil || trunc2 {
		t.Fatalf("small doc should not truncate: err=%v trunc=%v", err, trunc2)
	}
}
