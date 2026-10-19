package trayproto

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
)

// fakeUI records what the session asks the native menu to do.
type fakeUI struct {
	mu      sync.Mutex
	shown   []Menu
	closed  int
	shownCh chan struct{}
}

func (f *fakeUI) Show(m Menu) {
	f.mu.Lock()
	f.shown = append(f.shown, m)
	f.mu.Unlock()
	if f.shownCh != nil {
		f.shownCh <- struct{}{}
	}
}
func (f *fakeUI) Close() { f.mu.Lock(); defer f.mu.Unlock(); f.closed++ }

// syncBuffer is a bytes.Buffer safe for concurrent writers.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *syncBuffer) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

const menuLine = `{"v":1,"type":"menu","tooltip":"Agent Lens: 2 sessions tracked","items":[{"id":"open","label":"Open the interface","enabled":true},{"id":"state","label":"2 sessions tracked","enabled":false},{"id":"quit","label":"Quit and stop the relay","enabled":true}]}`

func newTestSession() (*Session, *syncBuffer, *syncBuffer) {
	out, log := &syncBuffer{}, &syncBuffer{}
	return NewSession(out, log), out, log
}

func TestServeShowsEachMenuAndClosesOnQuit(t *testing.T) {
	s, out, _ := newTestSession()
	ui := &fakeUI{}
	err := s.Serve(strings.NewReader(menuLine+"\n"+menuLine+"\n"+`{"v":1,"type":"quit"}`+"\n"+menuLine+"\n"), ui)
	if err != nil {
		t.Fatal(err)
	}
	if len(ui.shown) != 2 {
		t.Fatalf("shown %d menus, want 2 (nothing after quit)", len(ui.shown))
	}
	if ui.shown[0].Tooltip != "Agent Lens: 2 sessions tracked" || len(ui.shown[0].Items) != 3 {
		t.Errorf("menu %+v", ui.shown[0])
	}
	if ui.closed != 1 {
		t.Errorf("closed %d times, want 1", ui.closed)
	}
	if out.String() != "" {
		t.Errorf("wrote %q on its own: the binary only answers ready, click and closed", out.String())
	}
}

func TestServeClosesTheIconWhenTheDriverGoesAway(t *testing.T) {
	s, _, _ := newTestSession()
	ui := &fakeUI{}
	if err := s.Serve(strings.NewReader(menuLine+"\n"), ui); err != nil {
		t.Fatalf("end of input is a normal end, got %v", err)
	}
	if ui.closed != 1 {
		t.Fatalf("closed %d times, want 1", ui.closed)
	}
}

func TestServeIgnoresAndLogsInvalidLinesWithoutTheirContent(t *testing.T) {
	const secret = "SECRET-TOKEN-7f3a"
	s, _, log := newTestSession()
	ui := &fakeUI{}
	in := strings.Join([]string{
		secret,
		`{"v":1,"type":"exec","cmd":"` + secret + `"}`,
		`{"v":2,"type":"quit"}`,
		strings.Repeat(secret, MaxDriverLineBytes),
		menuLine,
	}, "\n") + "\n"
	if err := s.Serve(strings.NewReader(in), ui); err != nil {
		t.Fatal(err)
	}
	if len(ui.shown) != 1 {
		t.Fatalf("shown %d menus, want 1", len(ui.shown))
	}
	logged := log.String()
	if strings.Count(logged, "\n") != 4 {
		t.Errorf("want one log line per invalid line, got %q", logged)
	}
	if strings.Contains(logged, secret) {
		t.Errorf("the log repeats the content of a line: %q", logged)
	}
	if !strings.Contains(logged, "line too long") {
		t.Errorf("the overflow is not named: %q", logged)
	}
}

func TestServeStopsAfterTooManyInvalidLines(t *testing.T) {
	s, _, _ := newTestSession()
	ui := &fakeUI{}
	in := strings.Repeat("garbage\n", MaxInvalidLines) + menuLine + "\n"
	err := s.Serve(strings.NewReader(in), ui)
	if !errors.Is(err, ErrTooManyInvalidLines) {
		t.Fatalf("got %v, want ErrTooManyInvalidLines", err)
	}
	if len(ui.shown) != 0 || ui.closed != 1 {
		t.Fatalf("shown %d, closed %d", len(ui.shown), ui.closed)
	}
}

func TestServeToleratesFewerInvalidLinesThanTheLimit(t *testing.T) {
	s, _, _ := newTestSession()
	ui := &fakeUI{}
	in := strings.Repeat("garbage\n", MaxInvalidLines-1) + menuLine + "\n"
	if err := s.Serve(strings.NewReader(in), ui); err != nil {
		t.Fatal(err)
	}
	if len(ui.shown) != 1 {
		t.Fatalf("shown %d menus", len(ui.shown))
	}
}

func TestServeReturnsAReadError(t *testing.T) {
	s, _, _ := newTestSession()
	ui := &fakeUI{}
	boom := errors.New("boom")
	if err := s.Serve(io.MultiReader(strings.NewReader(menuLine+"\n"), errReader{boom}), ui); !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
	if ui.closed != 1 {
		t.Fatalf("closed %d", ui.closed)
	}
}

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }

func TestReadyAndClosedWriteTheirLine(t *testing.T) {
	s, out, _ := newTestSession()
	if err := s.Ready(); err != nil {
		t.Fatal(err)
	}
	if err := s.Ready(); err != nil {
		t.Fatal(err)
	}
	if err := s.Closed(); err != nil {
		t.Fatal(err)
	}
	if err := s.Closed(); err != nil {
		t.Fatal(err)
	}
	want := `{"v":1,"type":"ready"}` + "\n" + `{"v":1,"type":"ready"}` + "\n" + `{"v":1,"type":"closed"}` + "\n"
	if out.String() != want {
		t.Fatalf("wrote %q, want %q (closed only once)", out.String(), want)
	}
}

// live runs Serve on a pipe, as the real binary does with its stdin.
type live struct {
	s    *Session
	out  *syncBuffer
	ui   *fakeUI
	in   *io.PipeWriter
	done chan error
}

func startLive(t *testing.T) *live {
	t.Helper()
	s, out, _ := newTestSession()
	r, w := io.Pipe()
	l := &live{s: s, out: out, ui: &fakeUI{shownCh: make(chan struct{}, 16)}, in: w, done: make(chan error, 1)}
	go func() { l.done <- s.Serve(r, l.ui) }()
	t.Cleanup(func() { _ = w.Close() })
	return l
}

// sendMenu writes one menu line and waits until the session has shown it.
func (l *live) sendMenu(t *testing.T, line string) {
	t.Helper()
	if _, err := io.WriteString(l.in, line+"\n"); err != nil {
		t.Fatal(err)
	}
	<-l.ui.shownCh
}

func TestClickOnlyForAnEnabledItemOfTheCurrentMenu(t *testing.T) {
	l := startLive(t)
	if err := l.s.Click(ItemOpen); !errors.Is(err, ErrNotClickable) {
		t.Fatalf("click before any menu: got %v", err)
	}
	l.sendMenu(t, menuLine)
	for _, id := range []ItemID{ItemState, ItemCopyURL, ItemSkipped, "exec"} {
		if err := l.s.Click(id); !errors.Is(err, ErrNotClickable) {
			t.Errorf("click on %q: got %v, want ErrNotClickable", id, err)
		}
	}
	if err := l.s.Click(ItemOpen); err != nil {
		t.Fatal(err)
	}
	if err := l.s.Click(ItemQuit); err != nil {
		t.Fatal(err)
	}
	want := `{"v":1,"type":"click","id":"open"}` + "\n" + `{"v":1,"type":"click","id":"quit"}` + "\n"
	if l.out.String() != want {
		t.Fatalf("wrote %q, want %q", l.out.String(), want)
	}
}

func TestNoClickOnceServeHasEnded(t *testing.T) {
	l := startLive(t)
	l.sendMenu(t, menuLine)
	_ = l.in.Close()
	if err := <-l.done; err != nil {
		t.Fatal(err)
	}
	if err := l.s.Click(ItemOpen); !errors.Is(err, ErrNotClickable) {
		t.Fatalf("the icon is closed, got %v", err)
	}
	if l.out.String() != "" {
		t.Fatalf("wrote %q", l.out.String())
	}
}

func TestANewMenuReplacesWhatIsClickable(t *testing.T) {
	l := startLive(t)
	l.sendMenu(t, menuLine)
	l.sendMenu(t, `{"v":1,"type":"menu","tooltip":"t","items":[{"id":"open","label":"Open the interface","enabled":false}]}`)
	if err := l.s.Click(ItemOpen); !errors.Is(err, ErrNotClickable) {
		t.Fatalf("open is disabled in the latest menu, got %v", err)
	}
	if err := l.s.Click(ItemQuit); !errors.Is(err, ErrNotClickable) {
		t.Fatalf("quit is gone from the latest menu, got %v", err)
	}
}

func TestConcurrentEventsWriteWholeLines(t *testing.T) {
	l := startLive(t)
	l.sendMenu(t, menuLine)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); _ = l.s.Click(ItemOpen) }()
		go func() { defer wg.Done(); _ = l.s.Ready() }()
	}
	wg.Wait()
	lines := strings.Split(strings.TrimSuffix(l.out.String(), "\n"), "\n")
	if len(lines) != 100 {
		t.Fatalf("got %d lines", len(lines))
	}
	for _, line := range lines {
		if line != `{"v":1,"type":"click","id":"open"}` && line != `{"v":1,"type":"ready"}` {
			t.Fatalf("interleaved line %q", line)
		}
	}
}

func TestWritesFailOnceTheOutputIsBroken(t *testing.T) {
	s := NewSession(failingWriter{}, io.Discard)
	if err := s.Ready(); err == nil {
		t.Fatal("a failed write was not reported")
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
