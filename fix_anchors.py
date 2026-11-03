#!/usr/bin/env python3
"""
HISTORICAL — verify against the refactored repository before running.

This script was part of the pre-refactor patch workflow. It contains no
literal reference to index.html / styles/ / scripts/ paths, so it may
or may not still apply cleanly depending on what it actually targets.
Do not run it without first inspecting the source and testing against
a copy of the current tree.
"""
import io, re, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()

upair = re.compile(r'\\u([dD][89abAB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})')
def cp(m):
    hi, lo = int(m.group(1), 16), int(m.group(2), 16)
    return chr(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))
s = upair.sub(cp, s)

s = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), s)
io.open(p, 'w', encoding='utf-8').write(s)
print('decoded \\uXXXX escapes in', p)
