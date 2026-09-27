#!/usr/bin/env python3
"""调研：汇总音频/视频调研结论为 JSON 清单（.cache/assets-research/audio/audio-manifest.v206.json）。只读原版。"""
import json, subprocess, glob, os, re
R = '.'; A = f'{R}/.cache/assets-research/audio'
def dur(f): return float(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',f],capture_output=True,text=True).stdout)
def silence(f):
    out = subprocess.run(['ffmpeg','-hide_banner','-nostats','-i',f,'-af','silencedetect=noise=-50dB:d=0.2','-f','null','-'],capture_output=True,text=True).stderr
    ev = re.findall(r'silence_(start|end): ([0-9.]+)', out); return [(k, float(v)) for k, v in ev]
MIDI = open(f'{R}/original/Game/Midi.txt','rb').read().decode('ascii').split()
music = []
for k, name in enumerate(MIDI):
    t = k + 2; f = f'{R}/original/Media/Music/track{t:02d}.ogg'; d = dur(f); ev = silence(f)
    lead = ev[1][1] if len(ev) >= 2 and ev[0] == ('start', 0.0) else 0.0
    tail = next((v for kk, v in reversed(ev) if kk == 'start' and v > d - 5), d)
    music.append({'track': t, 'file': f'Media/Music/track{t:02d}.ogg', 'midi': name, 'nameIndex': k, 'dur': round(d, 3), 'loopStartSuggest': round(lead, 3), 'loopEndSuggest': round(tail, 3), 'bytes': os.path.getsize(f)})
SCENES = [  # (场景, 场景参数 arg, v2.06 调用点, 宿主函数, 备注)
    ('标题画面', 0, '0x402a16', 'fcn.0040297f', '同函数引用字符串 "V2.06"'),
    ('开局设定', 0x8001, '0x406e52', 'fcn.00406bb2', '0x8000 位=不记忆棋盘曲续播点'),
    ('游戏结束结算（其后播 END.AVI/OVER.AVI）', 0x8006, '0x40746e', 'fcn.004072e6', '同函数引用 JUMP.MKF/PANEL.MKF/END.AVI/OVER.AVI'),
    ('破产', 2, '0x40ca4e', 'fcn.0040c84d', '同函数播 Data#514 破产 FLIC + 音效 100'),
    ('破产（分支，esi>3 时）', 5, '0x40cc93', 'fcn.0040c84d', '与拍卖同曲'),
    ('企鵝挖寶', 12, '0x414cc0', 'fcn.00414b56', '同函数载入音效集 0x472ee7'),
    ('七彩氣球', 11, '0x414ebe', 'fcn.00414e01', '同函数载入音效集 0x472f2f'),
    ('喜從天降', 10, '0x4150de', 'fcn.00414f20', '同函数载入音效集 0x472f4f'),
    ('道具商店', 6, '0x42e0ea', 'fcn.0042dd0a', '同函数引用 "$%d"'),
    ('乐透投注', 6, '0x430a24', 'fcn.004309af', '同函数载入音效集 0x47349f'),
    ('乐透开奖', 8, '0x430b89', 'fcn.00430afc', '同函数载入音效集 0x4734af'),
    ('魔法屋', 7, '0x432c50', 'fcn.00432bb7', '同函数载入音效集 0x47361b'),
    ('魔法屋（第二入口）', 7, '0x432ed8', 'fcn.00432d87', ''),
    ('银行', 4, '0x43599e', 'fcn.004358b0', ''),
    ('银行（第二入口）', 4, '0x435c0a', 'fcn.00435b7b', ''),
    ('月结颁奖', 9, '0x438e97', 'fcn.00438bf2', '同函数载入音效集 0x47394b'),
    ('拍卖', 5, '0x43b437', 'fcn.0043ac9d', '同函数载入音效集 0x4739ee'),
    ('监狱', 15, '0x43c0d1', 'fcn.0043c03f', '同函数播 Data#497 警车 FLIC + 音效 94'),
    ('医院', 16, '0x43d75e', 'fcn.0043d6c0', '同函数播 Data#483 救护车 FLIC + 音效 92'),
    ('节日：圣诞 12/25（节日表 music=13）', 0x800D, '0x450d26', 'fcn.00450c16', '节日表 0x47d6ab'),
    ('节日：农历正月初一～初三（节日表 music=14）', 0x800E, '0x450d26', 'fcn.00450c16', '节日表 0x47d6ab'),
]
scenes = []
for name, arg, site, fn, note in SCENES:
    idx = 8 + (arg & 0x7fff); scenes.append({'scene': name, 'arg': hex(arg), 'midi': MIDI[idx], 'track': idx + 2, 'callSite': site, 'function': fn, 'note': note})
board = {'rule': 'fcn.004533f0(n): n!=0 → 选第 n-1 首；n==0 → (当前+1)&7 轮播；MIDI 模式 open sequencer!RICHxx.MID，CD 模式 play cdtrack from (idx+2)', 'tracks': [{'idx': k, 'midi': MIDI[k], 'track': k + 2} for k in range(8)]}
sfx_tables = json.load(open(f'{A}/sfx-tables.v206.json'))
CTX = {'0x47f5fa': '全局 UI 集（启动时载入 0x401721）', '0x47f62a': '棋盘主界面集（0x407d0f 载入/0x407e5f 释放）', '0x472ee7': '企鵝挖寶', '0x472f2f': '七彩氣球', '0x472f4f': '喜從天降',
       '0x472f88': '小游戏公共（fcn.00415184，入场/结算，推断）', '0x4733c3': '股市行情（fcn.0042aafd，持有股數表/股價表）', '0x4733db': '上市公司分红（fcn.0042b017）', '0x47349f': '乐透投注', '0x4734af': '乐透开奖',
       '0x47361b': '魔法屋', '0x47394b': '月结颁奖', '0x4739ee': '拍卖', '0x473b60': 'fcn.0043df4a（"%d元" 输入类界面，推断）', '0x473b70': 'fcn.0043e43e（推断同上）', '0x46ab7c': '开局设定（fcn.00406bb2）',
       '0x46ab8c': '无代码引用（死表）', '0x473342': '假阳性', '0x474110': '假阳性'}
for t in sfx_tables: t['context'] = CTX.get(t['va'], '')
eff = {r['i']: r for r in json.load(open(f'{A}/effect.index.json'))}
FLIC_SFX = [  # (FLIC 资源, 音效号, 调用点, 目视/语境)
    ('Data#515', 101, '0x407661', '地图崩裂（游戏结束，推断）'), ('Data#482', 90, '0x40acf9', '烟火（亦见节日表 1/1、10/10）'), ('Data#514', 100, '0x40ca83', '破产：房屋倒塌'),
    ('Data#492', 84, '0x40cf5e', 'UFO 光束（外星人事件）'), ('Data#517', 96, '0x40d053', '飞机飞过（强迫出国观光，推断）'),
    ('Data#499', 102, '0x40e6e5', '神明降临：小財神'), ('Data#500', 103, '0x40e7b9', '神明降临：大財神'), ('Data#501', 104, '0x40e851', '神明降临：小福神'), ('Data#502', 105, '0x40e90f', '神明降临：大福神'),
    ('Data#503', 106, '0x40ea05', '神明降临：小窮神'), ('Data#504', 107, '0x40eac8', '神明降临（小型神像，推断大窮神）'), ('Data#505', 108, '0x40eb61', '神明降临（衰神类）'), ('Data#506', 109, '0x40ec2d', '神明降临（小型神像，推断小衰神）'),
    ('Data#507', 110, '0x40ecad', '神明降临：天使'), ('Data#508', 112, '0x40ed00', '神明降临：惡魔'), ('Data#509', 111, '0x40ed48', '神明降临：土地公'), ('Data#510', 113, '0x40edbd', '神明降临：死神'),
    ('Data#485', 95, '0x40f0b7', '烟雾 110×110（神明离身，推断）'), ('Data#496', 98, '0x41aa34/0x41aace/0x41ab52', '旋转的 Ticket（得点券）@(204,180)'), ('Data#495', 99, '0x41abb2', '翻转卡片→问号（得卡片）@(208,180)'),
    ('Data#484', 82, '0x41afc3/0x41b714', '小爆炸（地雷/炸弹，推断）'), ('Data#511', 85, '0x41b0e9', '小爆炸（绿底）'), ('Data#491', 93, '0x41b12e', '烟雾'), ('Data#497', 94, '0x43c3d5', '警车（入狱）'), ('Data#483', 92, '0x43da65', '救护车 440×74 @y=210（住院）'),
    ('Data#516', 80, '0x4426e8', '蓝底小人（推断）'), ('Data#488', 97, '0x442a15', '坦克拆屋+烟（怪兽/拆除，推断）'), ('Data#490', 86, '0x447df6', '天降光束+穹顶爆炸（飞弹，推断）'), ('Data#498', 84, '0x448018', 'UFO 光束'),
    ('Data#486', 87, '0x44900e', '碎屑爆炸（定时炸弹，推断）'), ('Data#493', 89, '0x4496cc', '龙卷风'), ('Data#494', 88, '0x44986c', '龙卷风'), ('Data#513', 114, '节日表', '圣诞 FLIC（节日表 img=513 snd=114）'),
    ('动态 FLIC', 91, '0x41a374/0x41a617/0x431442/0x445f0d', ''), ('动态 FLIC', 97, '0x431717', ''), ('动态 FLIC', 81, '0x445c2d', ''), ('动态 FLIC', 83, '0x446751', 'flag bit31=全屏'), ('动态 FLIC', 59, '0x431e17/0x432656', '乐透/魔法屋附近'),
]
flic_sfx = [{'flic': a, 'sfx': b, 'sfxDur': eff[b]['dur'], 'callSite': c, 'desc': d} for a, b, c, d in FLIC_SFX]
effects = [{'id': i, 'bytes': eff[i]['size'], 'dur': eff[i].get('dur'), 'empty': not eff[i]['wav']} for i in sorted(eff)]
flic = json.load(open(f'{A}/flic.index.json'))
manifest = {'version': 'v2.06 (original/Game)', 'music': music, 'boardBgm': board, 'scenes': scenes, 'sfxTables': sfx_tables, 'flicSfx': flic_sfx, 'effects': effects,
            'flic': {k: [{kk: x[kk] for kk in ('i', 'w', 'h', 'frames', 'speedMs', 'raw', 'stored')} for x in v] for k, v in flic.items()},
            'video': json.load(open(f'{R}/.cache/assets-research/video/all/video-convert.json'))}
json.dump(manifest, open(f'{A}/audio-manifest.v206.json', 'w'), ensure_ascii=False, indent=1)
print('written', f'{A}/audio-manifest.v206.json')
for m in music: print(m['track'], m['midi'], m['dur'], m['loopStartSuggest'], m['loopEndSuggest'])
for s in scenes: print(s['scene'], s['arg'], s['midi'], 'track', s['track'])
