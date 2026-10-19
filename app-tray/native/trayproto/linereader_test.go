package trayproto

import (
	"errors"
	"io"
	"strings"
	"testing"
	"testing/iotest"
)

type readResult struct {
	line     string
	overflow bool
}

func readAll(t *testing.T, r io.Reader, max int) []readResult {
	t.Helper()
	lr := NewLineReader(r, max)
	var out []readResult
	for i := 0; i < 1000; i++ {
		line, overflow, err := lr.Next()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		out = append(out, readResult{string(line), overflow})
	}
	t.Fatal("reader never reached EOF")
	return nil
}

func TestLineReaderSplitsLinesAndStripsCR(t *testing.T) {
	got := readAll(t, strings.NewReader("a\nbb\r\n\nccc\n"), 16)
	want := []readResult{{"a", false}, {"bb", false}, {"", false}, {"ccc", false}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestLineReaderWorksByteByByte(t *testing.T) {
	got := readAll(t, iotest.OneByteReader(strings.NewReader("hello\nworld\n")), 16)
	if len(got) != 2 || got[0].line != "hello" || got[1].line != "world" {
		t.Fatalf("got %+v", got)
	}
}

func TestLineReaderAcceptsExactlyMaxAndDropsOneMore(t *testing.T) {
	exact := strings.Repeat("x", 8)
	tooLong := strings.Repeat("y", 9)
	got := readAll(t, strings.NewReader(exact+"\n"+tooLong+"\nafter\n"), 8)
	want := []readResult{{exact, false}, {"", true}, {"after", false}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestLineReaderReportsAHugeLineOnceWithoutKeepingIt(t *testing.T) {
	huge := strings.Repeat("z", 1<<20)
	got := readAll(t, iotest.HalfReader(strings.NewReader(huge+"\nok\n")), 64)
	if len(got) != 2 || !got[0].overflow || got[0].line != "" || got[1] != (readResult{"ok", false}) {
		t.Fatalf("got %d results, first %+v", len(got), got[0])
	}
}

func TestLineReaderDropsAnUnfinishedLastLine(t *testing.T) {
	got := readAll(t, strings.NewReader("done\nhalf"), 16)
	if len(got) != 1 || got[0].line != "done" {
		t.Fatalf("got %+v", got)
	}
}

func TestLineReaderReturnsItsOwnCopy(t *testing.T) {
	lr := NewLineReader(strings.NewReader("first\nsecond\n"), 16)
	a, _, _ := lr.Next()
	b, _, _ := lr.Next()
	if string(a) != "first" || string(b) != "second" {
		t.Fatalf("got %q then %q", a, b)
	}
}

func TestLineReaderPassesReadErrorsThrough(t *testing.T) {
	boom := errors.New("boom")
	lr := NewLineReader(iotest.ErrReader(boom), 16)
	if _, _, err := lr.Next(); !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
}
