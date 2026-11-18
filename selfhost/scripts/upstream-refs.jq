# Used by notify-upstream.sh: the upstream items a fork PR declares, from
# `Upstream:` lines at the top of its body. Load with `jq -L <this dir>` and
# `include "upstream-refs";`. Design: docs/specs/upstream-handpicked.md.
#
#   Upstream: `amosblomqvist/learnharness#123`
#
# Leading blank lines are skipped; reading stops at the first line that isn't
# an `Upstream:` line, so one quoted lower down (say, in an imported PR's
# copied description) never counts. A reference is `owner/repo#N` (backticks
# optional) or the item's URL (`https://github.com/owner/repo/issues/N` or
# `/pull/N`). Returns one object per line: {line, repo, number}, with repo and
# number null when the line doesn't parse.
def upstream_lines:
	(. // "") | split("\n") | map(rtrimstr("\r"))
	| reduce .[] as $l ({started: false, done: false, lines: []};
		if .done then .
		elif ($l | test("^\\s*$")) then (if .started then .done = true else . end)
		elif ($l | test("^Upstream:")) then .started = true | .lines += [$l]
		else .done = true end)
	| .lines;

def upstream_refs:
	upstream_lines
	| map(. as $line
		| (ltrimstr("Upstream:") | gsub("^\\s+|\\s+$"; "") | ltrimstr("`") | rtrimstr("`")) as $ref
		| ($ref | capture("^(?<repo>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#(?<n>[0-9]+)$")
			// ($ref | capture("^https://github\\.com/(?<repo>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/(issues|pull)/(?<n>[0-9]+)/?$"))
			// {repo: null, n: null}) as $m
		| {line: $line, repo: $m.repo, number: ($m.n | if . == null then null else tonumber end)});

# The distinct upstream numbers for $repo (compared ignoring case), sorted.
def upstream_numbers($repo):
	[upstream_refs[] | select(.repo != null and (.repo | ascii_downcase) == ($repo | ascii_downcase)) | .number] | unique;
