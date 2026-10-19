package trayproto

import (
	"bufio"
	"bytes"
	"errors"
	"io"
)

// LineReader splits a byte stream into lines of at most max bytes (a final "\r" is removed). A longer
// line is reported once as an overflow and skipped up to the next newline without being kept: memory
// stays bounded whatever the peer sends. An unfinished last line (no newline before the end) is dropped.
type LineReader struct {
	r   *bufio.Reader
	max int
}

// NewLineReader reads lines of at most max bytes from r.
func NewLineReader(r io.Reader, max int) *LineReader {
	// One more byte than max for the newline itself; bufio needs at least 16.
	size := max + 2
	if size < 16 {
		size = 16
	}
	return &LineReader{r: bufio.NewReaderSize(r, size), max: max}
}

// Next returns the next line, or overflow true for a line longer than max (line is then nil). At the
// end of the stream it returns io.EOF; any other read error is returned as is.
func (l *LineReader) Next() (line []byte, overflow bool, err error) {
	chunk, err := l.r.ReadSlice('\n')
	switch {
	case err == nil:
		content := bytes.TrimSuffix(chunk[:len(chunk)-1], []byte("\r"))
		if len(content) > l.max {
			return nil, true, nil
		}
		return append([]byte(nil), content...), false, nil
	case errors.Is(err, bufio.ErrBufferFull):
		return nil, true, l.skipLine()
	default:
		// io.EOF with a partial line: the line was never finished, drop it.
		return nil, false, err
	}
}

// skipLine discards the rest of an overlong line, up to and including its newline.
func (l *LineReader) skipLine() error {
	for {
		_, err := l.r.ReadSlice('\n')
		if err == nil {
			return nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			if errors.Is(err, io.EOF) {
				// Report the overflow now; the next call returns io.EOF.
				return nil
			}
			return err
		}
	}
}
