//go:build unix

package trayproto

// #510: the real Node driver (app-tray/src/cli.ts) talking to a Go binary built on this package, over
// real pipes. The binary is this test executable started again in helper mode, with a headless UI: it
// draws nothing (no GUI is involved, no icon is shown), records the menus it is given and clicks
// "quit" once the menu shows the count the relay proved. The relay is the test double
// app-tray/test/fake-relay.mjs, which listens on a free loopback port (port 0) and records how it was
// stopped.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const helperEnv = "TRAYPROTO_E2E_HELPER"

func TestMain(m *testing.M) {
	if os.Getenv(helperEnv) == "1" {
		code := runHelper()
		// The test reads the binary's own exit code here: the driver's says nothing of it (#613)
		if f := os.Getenv("TRAYPROTO_E2E_EXIT"); f != "" {
			_ = os.WriteFile(f, []byte(fmt.Sprint(code)), 0o600)
		}
		os.Exit(code)
	}
	os.Exit(m.Run())
}

// headlessUI records each menu as one JSON line and clicks quit when the proven count appears.
type headlessUI struct {
	mu      sync.Mutex
	session *Session
	record  *os.File
	clicked bool
}

func (h *headlessUI) Show(m Menu) {
	h.mu.Lock()
	defer h.mu.Unlock()
	line, _ := json.Marshal(struct {
		Tooltip string `json:"tooltip"`
		Items   []Item `json:"items"`
	}{m.Tooltip, m.Items})
	_, _ = h.record.Write(append(line, '\n'))
	for _, it := range m.Items {
		if it.ID == ItemState && it.Label == "2 sessions tracked" && !h.clicked {
			h.clicked = true
			_ = h.session.Click(ItemQuit)
		}
	}
}

func (h *headlessUI) Close() {}

func runHelper() int {
	record, err := os.OpenFile(os.Getenv("TRAYPROTO_E2E_MENUS"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "helper: cannot open the record file")
		return 3
	}
	defer record.Close()
	s := NewSession(os.Stdout, os.Stderr)
	ui := &headlessUI{session: s, record: record}
	if err := s.Ready(); err != nil {
		return 4
	}
	if err := s.Serve(os.Stdin, ui); err != nil {
		fmt.Fprintln(os.Stderr, "helper:", err)
		return 5
	}
	return 0
}

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// needNode skips the test when Node or the repository's dependencies are missing, except in CI, where
// both are installed before this test runs and their absence is a failure.
func needNode(t *testing.T, root string) string {
	t.Helper()
	node, err := exec.LookPath("node")
	_, tsxErr := os.Stat(filepath.Join(root, "node_modules", "tsx"))
	if err == nil && tsxErr == nil {
		return node
	}
	if os.Getenv("CI") != "" {
		t.Fatalf("node (%v) or node_modules/tsx (%v) missing in CI", err, tsxErr)
	}
	t.Skip("node or node_modules/tsx missing: run pnpm install")
	return ""
}

func TestRealDriverWithAGoBinary(t *testing.T) {
	root := repoRoot(t)
	node := needNode(t, root)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	menus := filepath.Join(dir, "menus.jsonl")
	mark := filepath.Join(dir, "relay.mark")
	exitFile := filepath.Join(dir, "binary.exit")

	// The driver passes no argument to the binary: a wrapper script points it at this test executable.
	wrapper := filepath.Join(dir, "tray-bin")
	script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run='^$'\n", self)
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, "--import", "tsx", "app-tray/src/cli.ts",
		"--tray-bin", wrapper, "--relay-entry", "app-tray/test/fake-relay.mjs")
	cmd.Dir = root
	env := []string{}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "LC_ALL=") || strings.HasPrefix(kv, "LC_MESSAGES=") || strings.HasPrefix(kv, "LANG=") {
			continue
		}
		env = append(env, kv)
	}
	cmd.Env = append(env, "LANG=C", helperEnv+"=1", "TRAYPROTO_E2E_MENUS="+menus, "TRAYPROTO_E2E_EXIT="+exitFile, "FAKE_RELAY_MARK="+mark)
	// On a timeout, kill the whole process group (driver, relay, binary) and stop waiting for their
	// pipes: a failure must end the test, never hang it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err = cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("the driver did not end within 30 s; stderr:\n%s", stderr.String())
	}
	if err != nil {
		t.Fatalf("the driver failed (%v); stderr:\n%s", err, stderr.String())
	}

	raw, err := os.ReadFile(menus)
	if err != nil {
		t.Fatalf("the binary recorded no menu: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	var last Menu
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &last); err != nil {
		t.Fatal(err)
	}
	if last.Tooltip != "Agent Lens: 2 sessions tracked" {
		t.Errorf("last menu tooltip %q", last.Tooltip)
	}
	ids := []string{}
	for _, it := range last.Items {
		ids = append(ids, string(it.ID))
	}
	if got := strings.Join(ids, ","); got != "open,copyUrl,state,skipped,quit" {
		t.Errorf("last menu items %s", got)
	}

	// The driver's exit code says nothing of the binary's (#613): the helper writes its own before exiting
	if code, err := os.ReadFile(exitFile); err != nil || string(code) != "0" {
		t.Errorf("the Go binary did not exit 0 (code %q, %v)", code, err)
	}

	stopped, err := os.ReadFile(mark)
	if err != nil || string(stopped) != "IPC" {
		t.Errorf("the relay was not stopped over its IPC channel (mark %q, %v)", stopped, err)
	}
	if strings.Contains(stderr.String(), "ignored") || strings.Contains(stderr.String(), "invalid") {
		t.Errorf("a line was refused on one side:\n%s", stderr.String())
	}
}
