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
#
# GitHub's renderer treats any fence longer than 255 tildes as 255, so a line
# of 255 or more would still close it. Only for text with such a run, the fence
# is 255, line endings become LF, and each line starting with up to 3 spaces
# and a tilde is indented to 4 spaces, which no fence can close on.
def fence($empty):
	(. // "") as $text
	# The longest tilde run, in one pass (scan("~+") is quadratic on long text).
	| ($text | explode | reduce .[] as $c ([0, 0]; if $c == 126 then [.[0] + 1, ([.[1], .[0] + 1] | max)] else [0, .[1]] end) | .[1]) as $longest
	| (if $longest < 255 then [$text, ([4, $longest + 1] | max)]
		else [$text | split("\r\n") | join("\n") | split("\r") | join("\n") | split("\n")
			| map(if test("^ {0,3}~") then sub("^ {0,3}"; "    ") else . end) | join("\n"), 255] end) as [$body, $width]
	| ([range($width)] | map("~") | join("")) as $f
	| $f + "markdown\n" + (if $body == "" then $empty else $body end) + "\n" + $f + "\n";
