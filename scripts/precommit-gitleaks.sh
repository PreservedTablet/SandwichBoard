#!/usr/bin/env bash
# Pre-commit secret scan (docs/plan/05 T4): refuse to commit unscanned changes.
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
	echo "✖ gitleaks is not installed — refusing to commit without a secret scan." >&2
	echo "  Install one of:" >&2
	echo "    go install github.com/zricethezav/gitleaks/v8@v8.30.1" >&2
	echo "    brew install gitleaks" >&2
	echo "    https://github.com/gitleaks/gitleaks#installing" >&2
	echo "  (CI runs the identical scan — bypassing locally only delays the failure.)" >&2
	exit 1
fi

exec gitleaks git --pre-commit --staged --redact --no-banner
