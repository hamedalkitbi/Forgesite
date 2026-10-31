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
