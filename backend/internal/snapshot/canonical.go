package snapshot

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

const (
	CanonicalizationVersion = "beez-canonical-json-v1"
	DigestAlgorithmVersion  = "sha256-beez-canonical-json-v1"
)

// CanonicalJSON serializes JSON with lexicographically sorted object keys,
// no insignificant whitespace, and exact fixed-decimal numbers (never an
// exponent). It is deliberately defined here rather than relying on jsonb's
// text representation, which is not a portable digest boundary.
func CanonicalJSON(raw []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("decode JSON: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("decode JSON: multiple values")
	}
	var out bytes.Buffer
	if err := appendCanonical(&out, value); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// MarshalCanonical marshals a Go value and then applies the snapshot's JSON
// canonicalization rules.
func MarshalCanonical(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("marshal JSON: %w", err)
	}
	return CanonicalJSON(raw)
}

func appendCanonical(out *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		if typed {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case string:
		out.Write(encodeJSONString(typed))
	case json.Number:
		normalized, err := normalizeJSONNumber(typed.String())
		if err != nil {
			return err
		}
		out.WriteString(normalized)
	case []any:
		out.WriteByte('[')
		for index, item := range typed {
			if index != 0 {
				out.WriteByte(',')
			}
			if err := appendCanonical(out, item); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out.WriteByte('{')
		for index, key := range keys {
			if index != 0 {
				out.WriteByte(',')
			}
			out.Write(encodeJSONString(key))
			out.WriteByte(':')
			if err := appendCanonical(out, typed[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return fmt.Errorf("canonical JSON: unsupported value %T", value)
	}
	return nil
}

func encodeJSONString(value string) []byte {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return bytes.TrimSuffix(out.Bytes(), []byte{'\n'})
}

// normalizeJSONNumber expands exponent notation exactly, removes insignificant
// zeroes, and normalizes every representation of negative zero to zero.
func normalizeJSONNumber(input string) (string, error) {
	s := strings.TrimSpace(input)
	if s == "" {
		return "", fmt.Errorf("canonical JSON: empty number")
	}
	negative := false
	if s[0] == '-' {
		negative = true
		s = s[1:]
	}
	mantissa, exponentText, hasExponent := strings.Cut(strings.ToLower(s), "e")
	exponent := 0
	if hasExponent {
		parsed, err := strconv.Atoi(exponentText)
		if err != nil {
			return "", fmt.Errorf("canonical JSON: invalid number %q", input)
		}
		exponent = parsed
	}
	integer, fraction, hasFraction := strings.Cut(mantissa, ".")
	if integer == "" || (hasFraction && fraction == "") {
		return "", fmt.Errorf("canonical JSON: invalid number %q", input)
	}
	for _, ch := range integer + fraction {
		if ch < '0' || ch > '9' {
			return "", fmt.Errorf("canonical JSON: invalid number %q", input)
		}
	}
	digits := integer + fraction
	decimal := len(integer) + exponent
	if decimal <= 0 {
		digits = strings.Repeat("0", -decimal) + digits
		decimal = 0
	} else if decimal >= len(digits) {
		digits += strings.Repeat("0", decimal-len(digits))
		decimal = len(digits)
	}
	var fixed string
	if decimal == 0 {
		fixed = "0." + digits
	} else if decimal == len(digits) {
		fixed = digits
	} else {
		fixed = digits[:decimal] + "." + digits[decimal:]
	}
	parts := strings.SplitN(fixed, ".", 2)
	parts[0] = strings.TrimLeft(parts[0], "0")
	if parts[0] == "" {
		parts[0] = "0"
	}
	if len(parts) == 2 {
		parts[1] = strings.TrimRight(parts[1], "0")
		if parts[1] != "" {
			fixed = parts[0] + "." + parts[1]
		} else {
			fixed = parts[0]
		}
	} else {
		fixed = parts[0]
	}
	if fixed == "0" {
		negative = false
	}
	if negative {
		fixed = "-" + fixed
	}
	return fixed, nil
}

func DigestCanonicalJSON(raw []byte) (string, error) {
	canonical, err := CanonicalJSON(raw)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

func SHA256Hex(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}
