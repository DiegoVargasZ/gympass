"""Prepare a byte-exact, signed APK update after a successful emulator smoke test."""
import base64
import gzip
import hashlib
import json
import pathlib
import struct
import subprocess
import sys
import zipfile

if len(sys.argv) != 5:
    raise SystemExit('Usage: prepare-android-release.py BASE.apk NEW.apk BASE_RELEASE_URL SMOKE_PROOF.json')
base_path, new_path = map(pathlib.Path, sys.argv[1:3])
base, new = base_path.read_bytes(), new_path.read_bytes()
sha = lambda data: hashlib.sha256(data).hexdigest()
version = new_path.stem.removeprefix('GymPASS-Android-')
proof = json.loads(pathlib.Path(sys.argv[4]).read_text(encoding='utf-8'))
if not proof.get('passed') or proof['sha256'] != sha(new) or len(proof.get('starts', [])) < 2:
    raise SystemExit('The signed APK has not passed two cold starts in the emulator.')

def entries(path, data):
    result = {}
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            names, extra = struct.unpack_from('<HH', data, item.header_offset + 26)
            start = item.header_offset + 30 + names + extra
            result[item.filename] = (start, item.compress_size)
    return result

old_entries, new_entries = entries(base_path, base), entries(new_path, new)
copies = []
for name, (start, length) in new_entries.items():
    old = old_entries.get(name)
    if old and old[1] == length and length and base[old[0]:old[0]+length] == new[start:start+length]:
        copies.append((start, old[0], length))
copies.sort()
literal, operations, cursor = bytearray(), [], 0
for start, old_start, length in copies:
    if start > cursor:
        operations.append(['insert', len(literal), start-cursor])
        literal.extend(new[cursor:start])
    operations.append(['copy', old_start, length])
    cursor = start + length
if cursor < len(new):
    operations.append(['insert', len(literal), len(new)-cursor])
    literal.extend(new[cursor:])
restored = b''.join((base if kind == 'copy' else literal)[offset:offset+length] for kind, offset, length in operations)
if sha(restored) != sha(new):
    raise SystemExit('Restored APK differs from the signed APK.')
patch = {'base_url': sys.argv[3], 'base_sha256': sha(base), 'sha256': sha(new), 'size': len(new), 'operations': operations}
manifest = {'version': version, 'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'sha256': sha(new), 'smoke': proof}
payload = {'manifest': manifest, 'patch': patch, 'literal': base64.b64encode(literal).decode('ascii')}
target = pathlib.Path('output', f'GymPASS-Android-prepared-{version}.json.gz')
target.parent.mkdir(exist_ok=True)
target.write_bytes(gzip.compress(json.dumps(payload, separators=(',', ':')).encode('utf-8'), compresslevel=9, mtime=0))
metadata = {'archive': str(target.resolve()), 'sha256': sha(target.read_bytes()), 'manifest': manifest}
pathlib.Path('output', f'prepared-android-{version}.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
print(json.dumps({'archive': str(target), 'bytes': target.stat().st_size, 'apk_bytes': len(new), 'sha256': metadata['sha256']}))
