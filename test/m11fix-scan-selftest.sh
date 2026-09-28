#!/usr/bin/env bash
# M11 审查第 1 条的回归：用 rich4:local 叠一层全是合成内容的「泄漏」文件（不含任何原版字节），scan-image.sh 必须逐条命中并退出 1；
# 另验证 TMPDIR 不可用时退出 2（第 12 条）。结束时删除自测镜像与构建目录。
set -euo pipefail
cd "$(dirname "$0")/.."
ctx=.cache/m11/fix/selftest
tag=rich4:m11fix-selftest
rm -rf "$ctx" && mkdir -p "$ctx/vendor/maps" "$ctx/vendor/data" "$ctx/gone" "$ctx/fakeassets"
python3 - "$ctx" <<'PY'
import gzip, io, json, lzma, sys, tarfile, zipfile, hashlib, os
c = sys.argv[1]; v = os.path.join(c, 'vendor')
def w(p, b):
    with open(os.path.join(v, p), 'wb') as f: f.write(b)
w('78.c5d26f34.flc.br', b'FAKE')
w('78.c5d26f34.flc.gz', gzip.compress(b'FAKE'))
w('.rich4-extract.json', b'{"generator":"selftest"}')
w('maps/taiwan.skin.ca179eee.json', b'{"schema":"rich4.mapskin/1"}')
w('data/flic-map.38238323.json', b'FAKE')
w('manifest.json.gz', gzip.compress(b'{"schema":"rich4.assets/1","files":[]}'))
w('track03.94a26a33.opus', b'FAKE')
w('start.22f4561c.mp4', b'FAKE')
w('track02.ogg', b'FAKE')
w('InstOK.wav', b'FAKE')
bio = io.BytesIO()
with tarfile.open(fileobj=bio, mode='w:gz') as t:
    ti = tarfile.TarInfo('Game/Data.mkf'); ti.size = 4; t.addfile(ti, io.BytesIO(b'FAKE'))
w('bundle.tar.gz', bio.getvalue())
w('renamed.bin', b'OggS\x00\x02' + b'\x00' * 22 + b'OpusTags\x07\x00\x00\x00encoderRICH4_DERIVED=1')
w('voices.txt', b'{"schema":"rich4.voice-map/1","voices":[]}')
zb = io.BytesIO()
with zipfile.ZipFile(zb, 'w') as z: z.writestr('pack/rich4-assets/a.png', b'FAKE')
w('pack.zip', zb.getvalue())
w('blob.xz', lzma.compress(b'FAKE'))
secret = b'pretend this is a renamed asset-pack file'
w('innocent.bin', secret)
with open(os.path.join(c, 'fakeassets', 'manifest.json'), 'w') as f:
    json.dump({'schema': 'rich4.assets/1', 'files': [{'path': 'x.png', 'sha256': hashlib.sha256(secret).hexdigest()}]}, f)
with open(os.path.join(c, 'gone', 'Data.MKF'), 'wb') as f: f.write(b'FAKE')
PY
cat >"$ctx/Dockerfile" <<'DF'
FROM rich4:local
USER root
COPY gone/Data.MKF /app/public/Data.MKF
RUN rm /app/public/Data.MKF
COPY vendor/ /app/public/vendor/
USER node
DF
docker build -q -t "$tag" -f "$ctx/Dockerfile" "$ctx" >/dev/null
rc=0
RICH4_ASSETS_DIR="$ctx/fakeassets" bash deploy/scan-image.sh "$tag" >"$ctx/../selftest-scan.log" 2>&1 || rc=$?
echo "scan-image.sh 自测镜像退出码：${rc}"
grep -E '^  命中' "$ctx/../selftest-scan.log" | sed -E 's/^  命中 [0-9a-f]{64}：/  层：/' | sort -u
tail -n 1 "$ctx/../selftest-scan.log"
rc2=0
TMPDIR=/nonexistent-dir-xyz bash deploy/scan-image.sh "$tag" >"$ctx/../selftest-tmpdir.log" 2>&1 || rc2=$?
echo "TMPDIR 不可用时退出码：${rc2}（$(tail -n 1 "$ctx/../selftest-tmpdir.log")）"
docker rmi "$tag" >/dev/null
rm -rf "$ctx"
docker image inspect "$tag" >/dev/null 2>&1 && echo "自测镜像没删掉" || echo "自测镜像已删除"
