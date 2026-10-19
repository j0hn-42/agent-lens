package trayproto

import (
	"errors"
	"fmt"
	"io"
	"sync"
)

// MaxInvalidLines is the number of refused lines after which Serve gives up (the driver applies the same
// limit to the binary).
const MaxInvalidLines = 20

// ErrTooManyInvalidLines ends Serve after MaxInvalidLines refused lines.
var ErrTooManyInvalidLines = errors.New("too many invalid lines from the driver")

// ErrNotClickable is returned by Click for an item that is not an enabled entry of the menu on screen,
// or once Serve has ended.
var ErrNotClickable = errors.New("item not clickable")

// UI is the native menu. Show and Close are called from the goroutine running Serve; a GUI toolkit that
// needs its own thread must hand the call over itself. The UI reports back through the Session: Ready
// when the icon is up, Click for a chosen item, Closed when the icon is gone.
type UI interface {
	// Show draws or redraws the menu: label as the text and accessible name, tooltip as the name of the
	// icon, enabled false greyed out.
	Show(Menu)
	// Close removes the icon. Called exactly once, when Serve ends.
	Close()
}

// Session is one run of the binary: it reads the driver's lines and writes the UI's events.
type Session struct {
	out io.Writer
	log io.Writer

	writeMu sync.Mutex
	closed  bool // "closed" already written

	menuMu    sync.Mutex
	clickable map[ItemID]bool // nil before the first menu and after Serve
}

// NewSession writes protocol lines to out (stdout) and one fixed line per refused input to log (stderr).
func NewSession(out, log io.Writer) *Session {
	return &Session{out: out, log: log}
}

func (s *Session) write(line []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.out.Write(line)
	return err
}

// Ready says the icon is up. It may be sent again (the driver then resends the menu).
func (s *Session) Ready() error { return s.write(readyLine) }

// Closed says the icon is gone. Only the first call writes the line.
func (s *Session) Closed() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	_, err := s.out.Write(closedLine)
	return err
}

// Click reports a click on an item. Only an enabled item of the menu on screen can be clicked: anything
// else returns ErrNotClickable and writes nothing.
func (s *Session) Click(id ItemID) error {
	s.menuMu.Lock()
	ok := s.clickable[id]
	s.menuMu.Unlock()
	if !ok {
		return ErrNotClickable
	}
	line, err := EncodeClick(id)
	if err != nil {
		return err
	}
	return s.write(line)
}

func (s *Session) setMenu(m Menu) {
	clickable := map[ItemID]bool{}
	for _, it := range m.Items {
		if it.Enabled {
			clickable[it.ID] = true
		}
	}
	s.menuMu.Lock()
	s.clickable = clickable
	s.menuMu.Unlock()
}

func (s *Session) clearMenu() {
	s.menuMu.Lock()
	s.clickable = nil
	s.menuMu.Unlock()
}

func (s *Session) logRefused(reason string) {
	_, _ = fmt.Fprintf(s.log, "agent-lens-tray-menu: line from the driver ignored: %s\n", reason)
}

// Serve reads the driver's lines from in (stdin) until quit, the end of the input (the driver is gone),
// a read error or too many invalid lines, then closes the UI. Quit and the end of the input return nil.
func (s *Session) Serve(in io.Reader, ui UI) error {
	defer func() {
		s.clearMenu()
		ui.Close()
	}()
	lines := NewLineReader(in, MaxDriverLineBytes)
	invalid := 0
	for {
		line, overflow, err := lines.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		var msg DriverMessage
		if err == nil && overflow {
			err = refuse("line too long")
		} else if err == nil {
			msg, err = ParseDriverMessage(line)
		}
		var perr *ProtocolError
		if errors.As(err, &perr) {
			s.logRefused(perr.Reason)
			invalid++
			if invalid >= MaxInvalidLines {
				return ErrTooManyInvalidLines
			}
			continue
		}
		if err != nil {
			return err
		}
		switch msg.Type {
		case TypeQuit:
			return nil
		case TypeMenu:
			s.setMenu(msg.Menu)
			ui.Show(msg.Menu)
		}
	}
}
