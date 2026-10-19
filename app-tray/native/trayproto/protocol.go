// Package trayproto is the native side of the JSON line protocol between the tray driver (Node,
// app-tray/src/protocol.ts) and the menu binary (docs/tray.md, #510). It holds no GUI code: a native
// menu plugs in through the UI interface of Session.
//
// The binary reads one JSON object per line on stdin and writes one per line on stdout. It only ever
// sends back ready, closed or a click carrying a known item id: never a command, a path or a URL. It
// runs nothing itself and opens no socket. Every incoming line is size-capped and strictly validated,
// and an error never repeats the content of the line.
package trayproto

import (
	"bytes"
	"encoding/json"
	"errors"
)

// Version is the protocol version, "v" on every line.
const Version = 1

// MaxDriverLineBytes caps one line from the driver. A real menu is a few hundred bytes; a longer line
// is dropped without being kept in memory.
const MaxDriverLineBytes = 16 * 1024

// Message types sent by the driver.
const (
	TypeMenu = "menu"
	TypeQuit = "quit"
)

// ItemID is the only thing a click carries back to the driver.
type ItemID string

// The item ids of the menu (app-tray/src/menu-model.ts).
const (
	ItemOpen    ItemID = "open"
	ItemCopyURL ItemID = "copyUrl"
	ItemState   ItemID = "state"
	ItemSkipped ItemID = "skipped"
	ItemQuit    ItemID = "quit"
)

// ItemIDs lists every known item id.
func ItemIDs() []ItemID {
	return []ItemID{ItemOpen, ItemCopyURL, ItemState, ItemSkipped, ItemQuit}
}

func knownID(id ItemID) bool {
	for _, k := range ItemIDs() {
		if id == k {
			return true
		}
	}
	return false
}

// Item is one menu entry. Label is the text and the accessible name; Enabled false greys it out.
type Item struct {
	ID      ItemID `json:"id"`
	Label   string `json:"label"`
	Enabled bool   `json:"enabled"`
}

// Menu is what the native menu draws. Tooltip is the name of the icon.
type Menu struct {
	Tooltip string
	Items   []Item
}

// DriverMessage is a validated line from the driver. Menu is set only when Type is TypeMenu.
type DriverMessage struct {
	Type string
	Menu Menu
}

// ProtocolError says why a line was refused. Its text is fixed: it never carries the line.
type ProtocolError struct{ Reason string }

func (e *ProtocolError) Error() string { return e.Reason }

func refuse(reason string) error { return &ProtocolError{Reason: reason} }

// object decodes a JSON object whose keys are exactly the given ones.
func object(raw []byte, keys ...string) (map[string]json.RawMessage, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' {
		return nil, refuse("not an object")
	}
	var o map[string]json.RawMessage
	if err := json.Unmarshal(raw, &o); err != nil {
		return nil, refuse("invalid JSON")
	}
	if len(o) != len(keys) {
		return nil, refuse("unexpected key")
	}
	for _, k := range keys {
		if _, ok := o[k]; !ok {
			return nil, refuse("unexpected key")
		}
	}
	return o, nil
}

// encoding/json accepts null for a string, a bool or a slice without an error: these helpers do not.
func str(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var s string
	return s, json.Unmarshal(raw, &s) == nil
}

func boolean(raw json.RawMessage) (bool, bool) {
	switch string(raw) {
	case "true":
		return true, true
	case "false":
		return false, true
	}
	return false, false
}

func array(raw json.RawMessage) ([]json.RawMessage, bool) {
	if len(raw) == 0 || raw[0] != '[' {
		return nil, false
	}
	var a []json.RawMessage
	return a, json.Unmarshal(raw, &a) == nil
}

// ParseDriverMessage validates one line from the driver. Unknown types, missing or extra keys, a wrong
// version, an unknown or repeated item id and a line over MaxDriverLineBytes are refused.
func ParseDriverMessage(line []byte) (DriverMessage, error) {
	if len(line) > MaxDriverLineBytes {
		return DriverMessage{}, refuse("line too long")
	}
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		if !json.Valid(trimmed) {
			return DriverMessage{}, refuse("invalid JSON")
		}
		return DriverMessage{}, refuse("not an object")
	}
	var head map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &head); err != nil {
		return DriverMessage{}, refuse("invalid JSON")
	}
	if string(head["v"]) != "1" {
		return DriverMessage{}, refuse("unsupported version")
	}
	typ, ok := str(head["type"])
	if !ok {
		return DriverMessage{}, refuse("unknown type")
	}
	switch typ {
	case TypeQuit:
		if _, err := object(trimmed, "v", "type"); err != nil {
			return DriverMessage{}, err
		}
		return DriverMessage{Type: TypeQuit}, nil
	case TypeMenu:
		o, err := object(trimmed, "v", "type", "tooltip", "items")
		if err != nil {
			return DriverMessage{}, err
		}
		tooltip, ok := str(o["tooltip"])
		if !ok {
			return DriverMessage{}, refuse("invalid tooltip")
		}
		rawItems, ok := array(o["items"])
		if !ok {
			return DriverMessage{}, refuse("invalid items")
		}
		items := make([]Item, 0, len(rawItems))
		seen := map[ItemID]bool{}
		for _, rawItem := range rawItems {
			fields, err := object(rawItem, "id", "label", "enabled")
			if err != nil {
				return DriverMessage{}, refuse("invalid item")
			}
			id, ok := str(fields["id"])
			if !ok || !knownID(ItemID(id)) {
				return DriverMessage{}, refuse("unknown item id")
			}
			if seen[ItemID(id)] {
				return DriverMessage{}, refuse("repeated item id")
			}
			seen[ItemID(id)] = true
			label, ok := str(fields["label"])
			if !ok {
				return DriverMessage{}, refuse("invalid item label")
			}
			enabled, ok := boolean(fields["enabled"])
			if !ok {
				return DriverMessage{}, refuse("invalid item state")
			}
			items = append(items, Item{ID: ItemID(id), Label: label, Enabled: enabled})
		}
		return DriverMessage{Type: TypeMenu, Menu: Menu{Tooltip: tooltip, Items: items}}, nil
	}
	return DriverMessage{}, refuse("unknown type")
}

// The three lines the binary may write. They are fixed bytes: nothing from the driver or the system
// is copied into them except a known item id.
var (
	readyLine  = []byte(`{"v":1,"type":"ready"}` + "\n")
	closedLine = []byte(`{"v":1,"type":"closed"}` + "\n")
)

// ErrUnknownItem is returned for a click on an id that is not one of ItemIDs.
var ErrUnknownItem = errors.New("unknown item id")

// EncodeReady is the line that says the icon is up (the driver then resends the menu).
func EncodeReady() []byte { return append([]byte(nil), readyLine...) }

// EncodeClosed is the line that says the icon is gone.
func EncodeClosed() []byte { return append([]byte(nil), closedLine...) }

// EncodeClick is the line of a click on a known item.
func EncodeClick(id ItemID) ([]byte, error) {
	if !knownID(id) {
		return nil, ErrUnknownItem
	}
	return []byte(`{"v":1,"type":"click","id":"` + string(id) + `"}` + "\n"), nil
}
