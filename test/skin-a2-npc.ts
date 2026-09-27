// 调试脚本（A2）：列出 A3 NPC_LINES 中 id 数较多的条目
import { NPC_LINES } from '../tools/extract/src/assets/data/voice';
for (const n of NPC_LINES) if (n.ids.length > 1) console.log(n.key, n.ids.length, n.desc, n.confidence);
