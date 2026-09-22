package embedded

import "sort"

// Files is populated by generated.go during release candidate builds.
// Empty map keeps source-only development builds usable before embedding.
var Files = map[string][]byte{}

func Names() []string {
	names := make([]string, 0, len(Files))
	for name := range Files {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func TotalBytes() int64 {
	var total int64
	for _, content := range Files {
		total += int64(len(content))
	}
	return total
}
