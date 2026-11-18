# Shared by import-upstream-pr.sh and mirror-upstream-issues.sh: copied
# upstream text goes into a ~~~~markdown code block, where @mentions, #N
# references and URLs don't fire. Load with `jq -L <this dir>` and
# `include "fence";`.
#
# A tilde fence closes only on a line of at least as many tildes as it opened
# with, so the fence is one tilde longer than the longest run of tildes
# anywhere in the text (and at least 4). Nothing inside can close it, whatever
# its indentation or line endings (CommonMark also ends a line at a lone CR),
# and the text is copied unchanged. Empty or null text becomes $empty.
def fence($empty):
	(. // "") as $text
	# The longest tilde run, in one pass (scan("~+") is quadratic on long text).
	| ($text | explode | reduce .[] as $c ([0, 0]; if $c == 126 then [.[0] + 1, ([.[1], .[0] + 1] | max)] else [0, .[1]] end) | .[1]) as $longest
	| ([4, $longest + 1] | max) as $width
	| ([range($width)] | map("~") | join("")) as $f
	| $f + "markdown\n" + (if $text == "" then $empty else $text end) + "\n" + $f + "\n";
