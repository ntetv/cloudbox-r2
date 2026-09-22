package main

import (
	"fmt"
	"os"
)

func main() {
	if err := deployCommand(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "cloudbox-r2: %s\n", err)
		os.Exit(1)
	}
}
