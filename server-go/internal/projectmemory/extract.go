// Package projectmemory implements the server-side half of the Project Memory
// feature: HTTP handlers (H6) and deterministic text extraction (H7). The server
// is a dumb store — it never calls AI; the only compute it does is turning
// uploaded PDF/Office blobs into plain text at upload time.
package projectmemory

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Locked caps (mirror shared-contract/project-memory.ts).
const (
	textCharCap     = 250_000          // stored extracted text cap, in characters (runes)
	maxDecompressed = 50 * 1024 * 1024 // decompression-bomb guard for Office/zip
)

var errDecompressionBomb = errors.New("decompressed size exceeds 50 MB limit")

// format is the detected document kind.
type format int

const (
	fmtUnknown format = iota
	fmtPDF
	fmtDOCX
	fmtPPTX
	fmtXLSX
)

// detectFormat picks the kind from mime type (preferred) then filename extension.
func detectFormat(mimeType, filename string) format {
	ext := strings.ToLower(filepath.Ext(filename))
	mt := strings.ToLower(strings.TrimSpace(mimeType))
	switch {
	case mt == "application/pdf" || ext == ".pdf":
		return fmtPDF
	case mt == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext == ".docx":
		return fmtDOCX
	case mt == "application/vnd.openxmlformats-officedocument.presentationml.presentation" || ext == ".pptx":
		return fmtPPTX
	case mt == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || ext == ".xlsx":
		return fmtXLSX
	}
	return fmtUnknown
}

// Supported reports whether ExtractText can handle the type in this build.
func Supported(mimeType, filename string) bool {
	return detectFormat(mimeType, filename) != fmtUnknown
}

// ExtractText turns raw bytes into plain text for pdf/docx/pptx/xlsx.
// Output is capped at 250,000 chars (truncated=true when cut). Never panics;
// unsupported or unparseable input returns ("", false, err).
func ExtractText(data []byte, mimeType, filename string) (text string, truncated bool, err error) {
	defer func() {
		if r := recover(); r != nil {
			text, truncated, err = "", false, fmt.Errorf("extraction panicked: %v", r)
		}
	}()

	var raw string
	switch detectFormat(mimeType, filename) {
	case fmtPDF:
		raw, err = extractPDF(data)
	case fmtDOCX:
		raw, err = extractDOCX(data)
	case fmtPPTX:
		raw, err = extractPPTX(data)
	case fmtXLSX:
		raw, err = extractXLSX(data)
	default:
		return "", false, errors.New("unsupported file type")
	}
	if err != nil {
		return "", false, err
	}
	text, truncated = capText(raw, textCharCap)
	return text, truncated, nil
}

// capText truncates s to at most max runes, cutting on a rune boundary.
func capText(s string, max int) (string, bool) {
	if len(s) <= max {
		// byte length ≤ max ⇒ rune count ≤ max; nothing to do.
		return s, false
	}
	n := 0
	for i := range s {
		if n == max {
			return s[:i], true
		}
		n++
	}
	return s, false
}

// --- PDF (shells out to pdftotext if present) ---

// pdftotextPath resolves the binary once and caches the result.
var pdftotextPath = sync.OnceValue(func() string {
	p, err := exec.LookPath("pdftotext")
	if err != nil {
		return ""
	}
	return p
})

func extractPDF(data []byte) (string, error) {
	bin := pdftotextPath()
	if bin == "" {
		return "", errors.New("pdf extraction unsupported in this build: pdftotext not found")
	}
	tmp, err := os.CreateTemp("", "pm-extract-*.pdf")
	if err != nil {
		return "", err
	}
	path := tmp.Name()
	defer os.Remove(path)
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	// pdftotext -layout <file> -  → text on stdout.
	cmd := exec.Command(bin, "-layout", path, "-")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("pdftotext failed: %w", err)
	}
	return out.String(), nil
}

// --- Office (zip of XML) shared machinery ---

// zipBombGuard reads zip entries while enforcing a total decompressed budget.
type zipBombGuard struct {
	remaining int64
}

// open reads one entry, failing if it (or the running total) exceeds the budget.
func (g *zipBombGuard) open(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	limit := g.remaining
	if limit < 0 {
		limit = 0
	}
	lr := io.LimitReader(rc, limit+1)
	data, err := io.ReadAll(lr)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errDecompressionBomb
	}
	g.remaining -= int64(len(data))
	return data, nil
}

func openZip(data []byte) (*zip.Reader, error) {
	return zip.NewReader(bytes.NewReader(data), int64(len(data)))
}

// collectTagText streams an XML document and concatenates the character content
// of every element whose local name matches `tag`, inserting a space after each
// tag instance and a newline at each paragraph end (local name "p"). This is
// enough for <w:t> (DOCX) and <a:t> (PPTX) without modeling the full schema.
func collectTagText(r io.Reader, tag string) (string, error) {
	dec := xml.NewDecoder(r)
	var sb strings.Builder
	depth := 0
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return sb.String(), err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == tag {
				depth++
			}
		case xml.CharData:
			if depth > 0 {
				sb.Write(t)
			}
		case xml.EndElement:
			if t.Name.Local == tag {
				if depth > 0 {
					depth--
					sb.WriteByte(' ')
				}
			}
			if t.Name.Local == "p" {
				sb.WriteByte('\n')
			}
		}
	}
	return sb.String(), nil
}

func extractDOCX(data []byte) (string, error) {
	zr, err := openZip(data)
	if err != nil {
		return "", fmt.Errorf("docx: %w", err)
	}
	g := &zipBombGuard{remaining: maxDecompressed}
	for _, f := range zr.File {
		if f.Name == "word/document.xml" {
			b, err := g.open(f)
			if err != nil {
				return "", err
			}
			return collectTagText(bytes.NewReader(b), "t")
		}
	}
	return "", errors.New("docx: word/document.xml not found")
}

func extractPPTX(data []byte) (string, error) {
	zr, err := openZip(data)
	if err != nil {
		return "", fmt.Errorf("pptx: %w", err)
	}
	type entry struct {
		name string
		file *zip.File
	}
	var slides []entry
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "ppt/slides/slide") && strings.HasSuffix(f.Name, ".xml") {
			slides = append(slides, entry{f.Name, f})
		}
	}
	if len(slides) == 0 {
		return "", errors.New("pptx: no slides found")
	}
	sort.Slice(slides, func(i, j int) bool { return slides[i].name < slides[j].name })
	g := &zipBombGuard{remaining: maxDecompressed}
	var sb strings.Builder
	for _, s := range slides {
		b, err := g.open(s.file)
		if err != nil {
			return "", err
		}
		txt, err := collectTagText(bytes.NewReader(b), "t")
		if err != nil {
			return "", err
		}
		sb.WriteString(txt)
		sb.WriteByte('\n')
	}
	return sb.String(), nil
}

// --- XLSX (shared strings + worksheet cells) ---

// parseSharedStrings builds the string table from xl/sharedStrings.xml. Each
// <si> is one string; its text may be split across <r><t> runs, which are
// concatenated.
func parseSharedStrings(r io.Reader) ([]string, error) {
	dec := xml.NewDecoder(r)
	var sst []string
	var cur strings.Builder
	inSi := false
	inT := false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return sst, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inSi = true
				cur.Reset()
			case "t":
				if inSi {
					inT = true
				}
			}
		case xml.CharData:
			if inT {
				cur.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inT = false
			case "si":
				inSi = false
				sst = append(sst, cur.String())
			}
		}
	}
	return sst, nil
}

// extractXLSXSheet appends cell text from one worksheet. Shared strings are
// resolved via sst; inline strings, formula strings, and raw numbers are taken
// verbatim. Rows are separated by newlines, cells by tabs.
func extractXLSXSheet(r io.Reader, sst []string, sb *strings.Builder) error {
	dec := xml.NewDecoder(r)
	var (
		inC      bool
		cellType string
		inV      bool
		inIs     bool
		inTinIs  bool
		vBuf     strings.Builder
		isBuf    strings.Builder
	)
	flushCell := func() {
		switch cellType {
		case "s":
			if idx, e := strconv.Atoi(strings.TrimSpace(vBuf.String())); e == nil && idx >= 0 && idx < len(sst) {
				sb.WriteString(sst[idx])
			}
		case "inlineStr":
			sb.WriteString(isBuf.String())
		default: // "str" (formula), "n"/"" (number) → value text
			sb.WriteString(vBuf.String())
		}
		sb.WriteByte('\t')
	}
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "c":
				inC = true
				cellType = ""
				vBuf.Reset()
				isBuf.Reset()
				for _, a := range t.Attr {
					if a.Name.Local == "t" {
						cellType = a.Value
					}
				}
			case "v":
				if inC {
					inV = true
				}
			case "is":
				if inC {
					inIs = true
				}
			case "t":
				if inIs {
					inTinIs = true
				}
			}
		case xml.CharData:
			if inV {
				vBuf.Write(t)
			} else if inTinIs {
				isBuf.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "c":
				if inC {
					flushCell()
					inC = false
				}
			case "v":
				inV = false
			case "is":
				inIs = false
			case "t":
				inTinIs = false
			case "row":
				sb.WriteByte('\n')
			}
		}
	}
	return nil
}

func extractXLSX(data []byte) (string, error) {
	zr, err := openZip(data)
	if err != nil {
		return "", fmt.Errorf("xlsx: %w", err)
	}
	g := &zipBombGuard{remaining: maxDecompressed}

	var sst []string
	for _, f := range zr.File {
		if f.Name == "xl/sharedStrings.xml" {
			b, err := g.open(f)
			if err != nil {
				return "", err
			}
			sst, err = parseSharedStrings(bytes.NewReader(b))
			if err != nil {
				return "", err
			}
			break
		}
	}

	var sheets []*zip.File
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "xl/worksheets/sheet") && strings.HasSuffix(f.Name, ".xml") {
			sheets = append(sheets, f)
		}
	}
	if len(sheets) == 0 {
		return "", errors.New("xlsx: no worksheets found")
	}
	sort.Slice(sheets, func(i, j int) bool { return sheets[i].Name < sheets[j].Name })

	var sb strings.Builder
	for _, f := range sheets {
		b, err := g.open(f)
		if err != nil {
			return "", err
		}
		if err := extractXLSXSheet(bytes.NewReader(b), sst, &sb); err != nil {
			return "", err
		}
	}
	return sb.String(), nil
}
