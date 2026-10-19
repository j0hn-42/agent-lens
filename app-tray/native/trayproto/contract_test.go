package trayproto

// #510: the Go side of the shared protocol contract (app-tray/protocol-fixtures.json). The Node side
// (app-tray/src/protocol-contract.test.ts) reads the same file.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type fixtureMessage struct {
	Type    string `json:"type"`
	Tooltip string `json:"tooltip"`
	Items   []Item `json:"items"`
	ID      ItemID `json:"id"`
}

type fixtures struct {
	DriverToBinary []struct {
		Name    string         `json:"name"`
		Message fixtureMessage `json:"message"`
		Line    string         `json:"line"`
	} `json:"driverToBinary"`
	DriverToBinaryRefused []struct {
		Name string `json:"name"`
		Line string `json:"line"`
	} `json:"driverToBinaryRefused"`
	BinaryToDriver []struct {
		Name    string         `json:"name"`
		Message fixtureMessage `json:"message"`
		Line    string         `json:"line"`
	} `json:"binaryToDriver"`
}

func loadFixtures(t *testing.T) fixtures {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var f fixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}
	if len(f.DriverToBinary) < 4 || len(f.DriverToBinaryRefused) < 10 || len(f.BinaryToDriver) != 7 {
		t.Fatalf("fixtures look truncated: %d / %d / %d", len(f.DriverToBinary), len(f.DriverToBinaryRefused), len(f.BinaryToDriver))
	}
	return f
}

func TestContractParsesEveryDriverLine(t *testing.T) {
	for _, c := range loadFixtures(t).DriverToBinary {
		got, err := ParseDriverMessage([]byte(c.Line))
		if err != nil {
			t.Errorf("%s: refused: %v", c.Name, err)
			continue
		}
		if got.Type != c.Message.Type {
			t.Errorf("%s: type %q, want %q", c.Name, got.Type, c.Message.Type)
		}
		if c.Message.Type == TypeMenu {
			want := Menu{Tooltip: c.Message.Tooltip, Items: c.Message.Items}
			if want.Items == nil {
				want.Items = []Item{}
			}
			if !reflect.DeepEqual(got.Menu, want) {
				t.Errorf("%s: menu %+v, want %+v", c.Name, got.Menu, want)
			}
		}
	}
}

func TestContractRefusesEveryBadDriverLine(t *testing.T) {
	for _, c := range loadFixtures(t).DriverToBinaryRefused {
		if got, err := ParseDriverMessage([]byte(c.Line)); err == nil {
			t.Errorf("%s: accepted as %+v", c.Name, got)
		}
	}
}

func TestContractWritesExactlyTheBinaryLines(t *testing.T) {
	for _, c := range loadFixtures(t).BinaryToDriver {
		var line []byte
		var err error
		switch c.Message.Type {
		case "ready":
			line = EncodeReady()
		case "closed":
			line = EncodeClosed()
		case "click":
			line, err = EncodeClick(c.Message.ID)
		default:
			t.Fatalf("%s: unexpected fixture type %q", c.Name, c.Message.Type)
		}
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		if string(line) != c.Line+"\n" {
			t.Errorf("%s: wrote %q, want %q", c.Name, line, c.Line+"\n")
		}
	}
}
