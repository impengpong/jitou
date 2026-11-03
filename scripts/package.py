"""Package the loadable extension, excluding tests and local artifacts."""
from pathlib import Path
import json
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
extension = root / 'zitou-extension'
version = json.loads((extension / 'manifest.json').read_text())['version']
out = root / 'dist' / f'jitou-{version}.zip'
out.parent.mkdir(exist_ok=True)
with ZipFile(out, 'w', ZIP_DEFLATED) as archive:
    for path in sorted(extension.rglob('*')):
        if not path.is_file() or path.is_symlink():
            continue
        if path.name.startswith('.') or path.name.startswith('__test') or '.test.' in path.name:
            continue
        if '__pycache__' in path.parts:
            continue
        archive.write(path, path.relative_to(root))
    for name in ['LICENSE', 'NOTICE', 'PRIVACY.md']:
        archive.write(root / name, name)
print(out)
