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

// #613: the texts are checked, not only typed. The driver only writes safe texts (deriveMenu), so these
// lines can only come from something else: they are refused rather than drawn.
func TestParseRefusesUnsafeTexts(t *testing.T) {
	menu := func(tooltip, label string) string {
		return `{"v":1,"type":"menu","tooltip":"` + tooltip + `","items":[{"id":"open","label":"` + label + `","enabled":true}]}`
	}
	for name, line := range map[string]string{
		"tooltip with RLO (bidi override)":        menu(`Agent \u202eLens`, "Open"),
		"tooltip with a raw RLO":                  menu("Agent \u202eLens", "Open"),
		"label with an isolate (LRI)":             menu("t", `a\u2066b`),
		"label with ALM":                          menu("t", `a\u061cb`),
		"label with RLM":                          menu("t", `a\u200fb`),
		"label with NUL":                          menu("t", `a\u0000b`),
		"label with ESC":                          menu("t", `a\u001bb`),
		"label with CR":                           menu("t", `a\rb`),
		"label with DEL":                          menu("t", `a\u007fb`),
		"label with a C1 control":                 menu("t", `a\u0085b`),
		"label with an invalid UTF-8 byte":        menu("t", "a\xffb"),
		"tooltip with a truncated UTF-8 sequence": menu("Agent \xe2\x80", "Open"),
		"label with a lone surrogate escape":      menu("t", `a\ud800b`),
		"label with U+FFFD":                       menu("t", "a\uFFFDb"),
	} {
		if got, err := ParseDriverMessage([]byte(line)); err == nil {
			t.Errorf("%s: accepted as %+v", name, got)
		}
	}
}

func TestParseKeepsOrdinaryTexts(t *testing.T) {
	line := `{"v":1,"type":"menu","tooltip":"Agent Lens : 2 sessions\nsuivies\tok","items":[{"id":"open","label":"Ouvrir l’interface — 日本語 ✓","enabled":true}]}`
	got, err := ParseDriverMessage([]byte(line))
	if err != nil {
		t.Fatalf("refused: %v", err)
	}
	if got.Menu.Tooltip != "Agent Lens : 2 sessions\nsuivies\tok" || got.Menu.Items[0].Label != "Ouvrir l’interface — 日本語 ✓" {
		t.Fatalf("got %+v", got.Menu)
	}
}

// #613: a key written twice is refused (encoding/json would keep the last one silently). The driver
// writes its lines with JSON.stringify of an object, so it never repeats a key.
func TestParseRefusesARepeatedKey(t *testing.T) {
	for _, line := range []string{
		`{"v":1,"v":1,"type":"quit"}`,
		`{"v":1,"type":"menu","type":"quit"}`,
		`{"v":1,"type":"menu","tooltip":"a","tooltip":"b","items":[]}`,
		`{"v":1,"type":"menu","tooltip":"t","items":[{"id":"open","label":"x","label":"y","enabled":true}]}`,
		`{"v":1,"type":"menu","tooltip":"t","items":[{"id":"open","id":"quit","label":"x","enabled":true}]}`,
	} {
		if got, err := ParseDriverMessage([]byte(line)); err == nil {
			t.Errorf("%s accepted as %+v", line, got)
		}
	}
}
