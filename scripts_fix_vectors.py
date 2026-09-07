import re

path = 'test/signing-policy.test.ts'
src = open(path, encoding='utf-8').read()

rows = [
    (0x0007, 'C0 control'),
    (0x007F, 'DEL'),
    (0x0085, 'C1 control'),
    (0x00AD, 'soft hyphen'),
    (0x034F, 'combining grapheme joiner'),
    (0x061C, 'ARABIC LETTER MARK'),
    (0x180E, 'Mongolian FVS/MVS block'),
    (0x200B, 'zero-width space'),
    (0x202E, 'RLO bidi override'),
    (0x2028, 'line separator'),
    (0x206A, 'deprecated format controls'),
    (0x206F, ''),
    (0xFE0F, 'VS16 variation selector'),
    (0xE0101, 'astral variation-selector supplement'),
    (0xE0041, 'tag code point'),
    (0xFEFF, 'BOM / zero-width no-break space'),
    (0xFDD0, 'noncharacter (BMP block)'),
    (0xFFFE, 'noncharacter'),
    (0x1FFFE, 'noncharacter, plane 1'),
    (0xD800, 'lone surrogate'),
]
lines = []
for cp, comment in rows:
    if cp == 0xD800:
        inp = "'a\\ud800b'"
    else:
        inp = "'a\\u{%x}b'" % cp
    c = ('   // ' + comment) if comment else ''
    lines.append("      [%s, 'U+%04X'],%s" % (inp, cp, c))
lines.append("      ['line1\\nline2', 'U+000A']    // newline - multi-line SIWE cannot be signed")
table = "    const vectors: Array<[string, string]> = [\n" + "\n".join(lines) + "\n    ]"

start = src.index('    const vectors')
end = src.index('\n    ]', start) + len('\n    ]')
src = src[:start] + table + src[end:]

# never-normalizes vector -> explicit escape (row may hold a literal U+200B)
nn = src.index("it('never normalizes")
seg = src[nn:nn + 200]
seg = re.sub(r"validateSigningText\('a.{0,2}b'\)", "validateSigningText('a\\\\u200bb')", seg, count=1)
src = src[:nn] + seg + src[nn + 200:]

open(path, 'w', encoding='utf-8').write(src)

# verify: no disallowed literal code points anywhere in the file
classes = [(0, 0x1f), (0x7f, 0x9f), (0xad, 0xad), (0x34f, 0x34f), (0x61c, 0x61c),
           (0x180b, 0x180f), (0x200b, 0x200f), (0x2028, 0x2029), (0x202a, 0x202e),
           (0x2060, 0x206f), (0xfe00, 0xfe0f), (0xfeff, 0xfeff), (0xfdd0, 0xfdef),
           (0xd800, 0xdfff), (0xfff0, 0xffff), (0xe0000, 0xe0fff), (0x1fffe, 0x1ffff)]
count = 0
for ch in src:
    cp = ord(ch)
    if cp in (0x09, 0x0a):
        continue
    if any(lo <= cp <= hi for lo, hi in classes):
        count += 1
print('literal disallowed code points remaining:', count)
