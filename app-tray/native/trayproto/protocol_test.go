package trayproto

import (
	"strings"
	"testing"
)

func TestParseMenu(t *testing.T) {
	got, err := ParseDriverMessage([]byte(`{"v":1,"type":"menu","tooltip":"Agent Lens","items":[{"id":"open","label":"Ouvrir","enabled":true},{"id":"state","label":"2 sessions suivies","enabled":false}]}`))
	if err != nil {
		t.Fatal(err)
	}
	want := Menu{Tooltip: "Agent Lens", Items: []Item{{ID: ItemOpen, Label: "Ouvrir", Enabled: true}, {ID: ItemState, Label: "2 sessions suivies", Enabled: false}}}
	if got.Type != TypeMenu || got.Menu.Tooltip != want.Tooltip || len(got.Menu.Items) != 2 || got.Menu.Items[0] != want.Items[0] || got.Menu.Items[1] != want.Items[1] {
		t.Fatalf("got %+v", got)
	}
}

func TestParseQuit(t *testing.T) {
	got, err := ParseDriverMessage([]byte(`{"v":1,"type":"quit"}`))
	if err != nil || got.Type != TypeQuit {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestParseRefusesNullWhereAValueIsExpected(t *testing.T) {
	// encoding/json silently accepts null for a string, a bool or a slice: the parser must not.
	for _, line := range []string{
		`{"v":1,"type":null}`,
		`{"v":null,"type":"quit"}`,
		`{"v":1,"type":"menu","tooltip":null,"items":[]}`,
		`{"v":1,"type":"menu","tooltip":"t","items":null}`,
		`{"v":1,"type":"menu","tooltip":"t","items":[null]}`,
		`{"v":1,"type":"menu","tooltip":"t","items":[{"id":null,"label":"x","enabled":true}]}`,
		`{"v":1,"type":"menu","tooltip":"t","items":[{"id":"open","label":"x","enabled":null}]}`,
	} {
		if got, err := ParseDriverMessage([]byte(line)); err == nil {
			t.Errorf("%s accepted as %+v", line, got)
		}
	}
}

func TestParseRefusesAVersionWrittenOtherwise(t *testing.T) {
	for _, line := range []string{`{"v":1.0,"type":"quit"}`, `{"v":true,"type":"quit"}`, `{"v":[1],"type":"quit"}`, `{"v":-1,"type":"quit"}`} {
		if _, err := ParseDriverMessage([]byte(line)); err == nil {
			t.Errorf("%s accepted", line)
		}
	}
}

func TestParseRefusesALineOverTheCap(t *testing.T) {
	label := strings.Repeat("a", MaxDriverLineBytes)
	line := `{"v":1,"type":"menu","tooltip":"t","items":[{"id":"open","label":"` + label + `","enabled":true}]}`
	if _, err := ParseDriverMessage([]byte(line)); err == nil {
		t.Fatal("a line over the cap was accepted")
	}
}

func TestErrorsNeverCarryTheLine(t *testing.T) {
	const secret = "SECRET-TOKEN-7f3a"
	for _, line := range []string{
		secret,
		`{"v":1,"type":"` + secret + `"}`,
		`{"v":1,"type":"menu","tooltip":"t","items":[{"id":"` + secret + `","label":"x","enabled":true}]}`,
		`{"v":1,"type":"quit","` + secret + `":1}`,
	} {
		_, err := ParseDriverMessage([]byte(line))
		if err == nil {
			t.Fatalf("%s accepted", line)
		}
		if strings.Contains(err.Error(), secret) {
			t.Errorf("error %q repeats the content of the line", err)
		}
	}
}

func TestEncodeClickRefusesAnUnknownID(t *testing.T) {
	for _, id := range []ItemID{"", "exec", "Open", "open ", "http://127.0.0.1:3001"} {
		if line, err := EncodeClick(id); err == nil {
			t.Errorf("%q encoded as %q", id, line)
		}
	}
}

func TestEncodedLinesAreOneLineEach(t *testing.T) {
	lines := [][]byte{EncodeReady(), EncodeClosed()}
	for _, id := range ItemIDs() {
		l, err := EncodeClick(id)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, l)
	}
	for _, l := range lines {
		if strings.Count(string(l), "\n") != 1 || l[len(l)-1] != '\n' {
			t.Errorf("%q is not exactly one line", l)
		}
		if len(l) > 1024 {
			t.Errorf("%q is over the 1024 bytes the driver accepts", l)
		}
	}
}
